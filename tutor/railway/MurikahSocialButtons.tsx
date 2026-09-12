"use client";

import { useEffect, useMemo, useState } from "react";

interface Provider {
  id: "google" | "microsoft" | "apple";
  label: string;
}

function ProviderMark({ id }: { id: Provider["id"] }) {
  if (id === "google") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4">
        <path fill="currentColor" d="M21.8 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.5a4.7 4.7 0 0 1-2 3.1v2.4h3.2c1.9-1.7 3.1-4.3 3.1-7.2Z" />
        <path fill="currentColor" d="M12 22c2.7 0 5-.9 6.7-2.4L15.5 17c-.9.6-2 1-3.5 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.5A10 10 0 0 0 12 22Z" opacity=".78" />
        <path fill="currentColor" d="M6.4 13.9A6 6 0 0 1 6.1 12c0-.7.1-1.3.3-1.9V7.6H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.4l3.3-2.5Z" opacity=".55" />
        <path fill="currentColor" d="M12 6c1.5 0 2.8.5 3.9 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.6l3.3 2.5C7.2 7.8 9.4 6 12 6Z" opacity=".9" />
      </svg>
    );
  }
  if (id === "microsoft") {
    return (
      <span aria-hidden className="grid h-4 w-4 grid-cols-2 gap-[1px]">
        <span className="bg-current" /><span className="bg-current" />
        <span className="bg-current" /><span className="bg-current" />
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="currentColor">
      <path d="M17.1 12.5c0-2.3 1.9-3.4 2-3.5a4.4 4.4 0 0 0-3.5-1.9c-1.5-.2-2.9.9-3.6.9-.8 0-1.9-.9-3.1-.9a4.7 4.7 0 0 0-4 2.4c-1.7 3-.4 7.4 1.2 9.7.8 1.1 1.7 2.4 3 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.2-.9-2.2-4Zm-2.5-7c.6-.8 1.1-2 1-3.1-1 .1-2.3.7-3 1.5-.7.7-1.2 1.9-1.1 3 1.2.1 2.4-.6 3.1-1.4Z" />
    </svg>
  );
}

export default function MurikahSocialButtons({ next = "/chat" }: { next?: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/oauth/providers", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { providers: [] }))
      .then((data) => {
        if (!alive) return;
        const values = Array.isArray(data?.providers) ? data.providers : [];
        setProviders(values.filter((item: Provider) => ["google", "microsoft", "apple"].includes(item.id)));
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const encodedNext = useMemo(() => encodeURIComponent(next), [next]);
  if (!providers.length) return null;

  return (
    <div className="space-y-2.5" aria-label="Social sign in">
      {providers.map((provider) => (
        <a
          key={provider.id}
          href={`/api/auth/oauth/${provider.id}/start?next=${encodedNext}`}
          className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/60"
        >
          <ProviderMark id={provider.id} />
          <span>Continue with {provider.label}</span>
        </a>
      ))}
    </div>
  );
}
