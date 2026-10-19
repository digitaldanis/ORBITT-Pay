import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { errorMessage } from './api.js';
import { statusLabel, statusTone } from './format.js';

/** Loads data on mount and whenever `load` changes; `reload` keeps stale data visible while refreshing. */
export function useResource<T>(load: () => Promise<T>, fallbackError: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await load();
      if (current === generation.current) { setData(next); setError(''); }
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause, fallbackError));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [load, fallbackError]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge tone-${statusTone(status)}`}><i />{label ?? statusLabel(status)}</span>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1><p>{description}</p></div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function Banner({ tone, children, onDismiss }: { tone: 'success' | 'error' | 'warning'; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'success' ? <Check size={16} /> : <TriangleAlert size={16} />}
      <span>{children}</span>
      {onDismiss && <button className="icon-button" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { window.prompt('Copy this value', value); }
  };
  return (
    <button type="button" className={compact ? 'icon-button' : 'secondary-button small'} onClick={() => void copy()} aria-label={compact ? label : undefined}>
      {copied ? <Check size={14} /> : <Copy size={14} />}{!compact && (copied ? 'Copied' : label)}
    </button>
  );
}

export function Loading({ label }: { label: string }) {
  return <div className="loading-state"><RefreshCw className="spin" size={17} />{label}</div>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', listener);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', listener); document.body.style.overflow = overflow; };
  }, [onClose]);
}

export function Drawer({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <header className="drawer-header">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close" autoFocus><X size={16} /></button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="overlay center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function DetailRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><div className={mono ? 'mono' : undefined}>{children}</div></div>;
}
