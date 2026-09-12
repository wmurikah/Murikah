"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import MurikahSocialButtons from "@/components/auth/MurikahSocialButtons";

type Message = { role: "user" | "assistant"; content: string };

export default function MurikahGuestChat() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [remaining, setRemaining] = useState(3);
  const [limit, setLimit] = useState(3);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/auth/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/murikah/guest-status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([auth, guest]) => {
        if (!alive) return;
        if (auth?.authenticated) {
          router.replace("/chat");
          return;
        }
        if (guest) {
          setLimit(Number(guest.limit) || 3);
          setRemaining(Math.max(0, Number(guest.remaining) || 0));
          setAuthNeeded(Boolean(guest.requires_auth));
        }
        setChecking(false);
      })
      .catch(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy, authNeeded]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || busy) return;
    if (remaining <= 0 || authNeeded) {
      setAuthNeeded(true);
      return;
    }

    const prior = messages.slice(-6);
    setMessages((current) => [...current, { role: "user", content: prompt }]);
    setDraft("");
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/murikah/guest-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, history: prior }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403) {
          setRemaining(0);
          setAuthNeeded(true);
          return;
        }
        throw new Error(typeof data?.detail === "string" ? data.detail : "Tutor could not answer that prompt.");
      }
      setMessages((current) => [
        ...current,
        { role: "assistant", content: String(data.answer || "") },
      ]);
      const nextRemaining = Math.max(0, Number(data.remaining) || 0);
      setRemaining(nextRemaining);
      setAuthNeeded(Boolean(data.requires_auth) || nextRemaining === 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tutor could not answer that prompt.");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--background)] px-6 text-sm text-[var(--muted-foreground)]">
        Opening Murikah Tutor…
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)]/70 bg-[var(--background)]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5">
          <div className="inline-flex items-center gap-2.5 rounded-lg bg-[#1E2A30] px-3 py-1.5 text-sm font-semibold tracking-tight text-white shadow-sm">
            <span>Murikah</span><span aria-hidden className="h-4 w-px bg-[#A9822E]" /><span>Tutor</span>
          </div>
          <Link href="/login?next=/chat" className="text-sm font-medium text-[var(--foreground)]/75 hover:text-[var(--foreground)]">
            Sign in
          </Link>
        </div>
      </header>

      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl flex-col px-5 py-8">
        {messages.length === 0 ? (
          <div className="mx-auto my-auto w-full max-w-2xl pb-20 text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#A9822E]">AI-powered personalised learning</p>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">What would you like to learn?</h1>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-[var(--muted-foreground)]">
              Ask Murikah Tutor anything. You can try {limit} prompts before creating an account to save your learning and continue.
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-2xl flex-1 space-y-6 pb-8">
            {messages.map((message, index) => (
              <article key={`${message.role}-${index}`} className={message.role === "user" ? "ml-auto max-w-[85%] rounded-2xl bg-[var(--muted)] px-4 py-3" : "max-w-full"}>
                {message.role === "assistant" && <div className="mb-2 text-xs font-semibold text-[#A9822E]">Murikah Tutor</div>}
                <div className="whitespace-pre-wrap text-[15px] leading-7">{message.content}</div>
              </article>
            ))}
            {busy && (
              <div className="text-sm text-[var(--muted-foreground)]">Murikah Tutor is thinking…</div>
            )}
            <div ref={endRef} />
          </div>
        )}

        {authNeeded ? (
          <div className="mx-auto w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">
            <div className="text-center">
              <h2 className="text-xl font-semibold tracking-tight">Continue your learning</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                Your {limit}-prompt preview is complete. Sign in or create your account with a trusted provider to keep going.
              </p>
            </div>
            <div className="mt-5"><MurikahSocialButtons next="/chat" /></div>
            <div className="my-4 flex items-center gap-3 text-xs text-[var(--muted-foreground)] before:h-px before:flex-1 before:bg-[var(--border)] after:h-px after:flex-1 after:bg-[var(--border)]">or</div>
            <Link href="/login?next=/chat" className="block w-full rounded-lg bg-[#1E2A30] px-4 py-2.5 text-center text-sm font-semibold text-white hover:opacity-90">
              Sign in with username
            </Link>
            <p className="mt-4 text-center text-xs text-[var(--muted-foreground)]">Apache-2.0</p>
          </div>
        ) : (
          <form onSubmit={submit} className="mx-auto w-full max-w-2xl">
            {error && <p className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-2 shadow-sm focus-within:ring-2 focus-within:ring-[#A9822E]/30">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Ask a question…"
                rows={3}
                maxLength={6000}
                className="w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-[var(--muted-foreground)]"
              />
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-xs text-[var(--muted-foreground)]">{remaining} preview prompt{remaining === 1 ? "" : "s"} remaining</span>
                <button type="submit" disabled={busy || !draft.trim()} className="rounded-lg bg-[#1E2A30] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
                  Send
                </button>
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-[var(--muted-foreground)]">Preview chats are not saved · Apache-2.0</p>
          </form>
        )}
      </section>
    </main>
  );
}
