import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Panel({ children, className = '', title, actions }: { children: ReactNode; className?: string; title?: string; actions?: ReactNode }) {
  return <section className={'sb-panel ' + className}>
    {(title || actions) && <div className="sb-panel__head">{title && <h2>{title}</h2>}<div>{actions}</div></div>}
    {children}
  </section>;
}

export function Button({ children, icon, variant = 'secondary', disabled, title, onClick, type = 'button', className = '' }: {
  children: ReactNode; icon?: IconName; variant?: 'primary'|'secondary'|'quiet'|'danger'; disabled?: boolean; title?: string;
  onClick?: () => void; type?: 'button'|'submit'; className?: string;
}) {
  return <button type={type} className={'sb-btn sb-btn--' + variant + ' ' + className} disabled={disabled} title={title} onClick={onClick}>
    {icon && <Icon name={icon} size={16}/>}<span>{children}</span>
  </button>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral'|'critical'|'high'|'medium'|'low'|'success'|'warn'|'info' }) {
  return <span className={'sb-badge sb-badge--' + tone}>{children}</span>;
}

export function RatingBadge({ rating }: { rating: string }) {
  const tone = rating === 'Critical' ? 'critical' : rating === 'High' ? 'high' : rating === 'Medium' ? 'medium' : 'low';
  return <Badge tone={tone}>{rating}</Badge>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="sb-empty"><strong>{title}</strong><span>{body}</span></div>;
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return <div className="sb-skeleton-list" aria-label="Loading sample data">{Array.from({length:rows}).map((_,i)=><div className="sb-skeleton-row" key={i}/>)}</div>;
}

export function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter((el)=>!el.hasAttribute('disabled'));
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length-1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [open, onClose]);
  return ref;
}

export function Drawer({ open, title, onClose, children, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return <div className="sb-overlay" role="presentation" onMouseDown={(e)=>{ if(e.target===e.currentTarget) onClose(); }}>
    <div ref={ref} className={'sb-drawer ' + (wide ? 'sb-drawer--wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
      <div className="sb-drawer__head"><h2>{title}</h2><button className="sb-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x"/></button></div>
      <div className="sb-drawer__body">{children}</div>
    </div>
  </div>;
}

export function TooltipLock({ label, children }: { label: string; children: ReactNode }) {
  return <span className="sb-tooltip" data-tooltip={label}>{children}</span>;
}
