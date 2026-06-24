import { useEffect, useRef, useState } from 'react';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const GREETING =
  "Hello. I am Murikah's assistant. Ask me about internal audit, AI governance, data protection, audit software, or what Murikah does.";

const STARTERS = [
  'What does Murikah do?',
  'How much does Audit OS cost?',
  'What is ISO 42001 readiness?',
];

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    // Keep the latest message in view as it streams.
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  function close() {
    setOpen(false);
    launcherRef.current?.focus();
  }

  function appendToLast(delta: string) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant')
        copy[copy.length - 1] = { ...last, content: last.content + delta };
      return copy;
    });
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const history = [...messages, { role: 'user' as const, content: trimmed }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/ai/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (typeof evt.delta === 'string') appendToLast(evt.delta);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      appendToLast(
        'Sorry, I could not answer just now. Please try again, or contact the team at /contact.',
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mk-assistant-panel"
        aria-label={open ? 'Close the Murikah assistant' : 'Open the Murikah assistant'}
        className="fixed right-4 bottom-4 z-[60] inline-flex size-14 items-center justify-center rounded-full bg-gold text-navy shadow-pop hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:transition-transform"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {open ? (
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M4 5h16v11H8l-4 4V5z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
              fill="none"
            />
          )}
        </svg>
      </button>

      {open && (
        <div
          id="mk-assistant-panel"
          role="dialog"
          aria-label="Murikah assistant"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
          className="on-dark fixed inset-0 z-[60] flex flex-col bg-surface ring-1 ring-hairline sm:inset-auto sm:right-4 sm:bottom-20 sm:h-[540px] sm:max-h-[calc(100vh-6rem)] sm:w-[380px] sm:rounded-card sm:shadow-pop"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-hairline bg-navy px-4 py-3 text-paper sm:rounded-t-card">
            <div>
              <p className="font-medium text-white">Murikah assistant</p>
              <p className="text-xs text-paper/70">Demo assistant, sample answers</p>
            </div>
            <button
              onClick={close}
              aria-label="Close"
              className="rounded-md p-1.5 text-paper/80 hover:bg-white/10 hover:text-white"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div
            ref={logRef}
            className="flex-1 space-y-3 overflow-y-auto bg-paper px-4 py-4"
            aria-live="polite"
          >
            <p className="text-sm text-slate">{GREETING}</p>
            {messages.length === 0 && (
              <div className="space-y-2 pt-1">
                {STARTERS.map((q) => (
                  <button
                    key={q}
                    onClick={() => void send(q)}
                    className="block w-full rounded-lg bg-surface px-3 py-2 text-left text-sm text-navy ring-1 ring-hairline hover:bg-paper-shade"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <span
                  className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-navy text-white'
                      : 'bg-surface text-ink ring-1 ring-hairline'
                  }`}
                >
                  {m.content || (busy && i === messages.length - 1 ? 'Thinking...' : '')}
                </span>
              </div>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-center gap-2 border-t border-hairline bg-surface px-3 py-3 sm:rounded-b-card"
          >
            <label htmlFor="mk-assistant-input" className="sr-only">
              Ask the Murikah assistant
            </label>
            <input
              id="mk-assistant-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about Murikah, audit or AI governance"
              className="min-h-[2.5rem] flex-1 rounded-btn border border-hairline bg-surface px-3 text-sm text-ink"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-btn bg-gold text-navy hover:bg-gold-deep disabled:opacity-50"
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 12l16-8-6 16-3-7-7-1z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </form>
          <p className="bg-surface px-4 pb-3 text-xs text-slate sm:rounded-b-card">
            For a real conversation,{' '}
            <a href="/contact" className="font-medium text-blue hover:text-blue-deep">
              book a demo
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
