import { create } from 'zustand';
import { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type Toast = {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  ttlMs: number;
};

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast['kind'], message: string, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let _idSeq = 0;
const newId = () => ++_idSeq;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, ttlMs = 4000) =>
    set(s => ({ toasts: [...s.toasts, { id: newId(), kind, message, ttlMs }] })),
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

export const toast = {
  success: (m: string, ttl?: number) => useToasts.getState().push('success', m, ttl),
  error:   (m: string, ttl?: number) => useToasts.getState().push('error',   m, ttl ?? 6000),
  info:    (m: string, ttl?: number) => useToasts.getState().push('info',    m, ttl),
};

export function ToastRoot() {
  const toasts = useToasts(s => s.toasts);
  const dismiss = useToasts(s => s.dismiss);
  return (
    <div aria-live="polite" className="fixed top-3 right-3 z-[70] space-y-2 w-[min(24rem,calc(100vw-1.5rem))] pointer-events-none">
      {toasts.map(t => <ToastItem key={t.id} t={t} onDismiss={() => dismiss(t.id)} />)}
    </div>
  );
}

// Semantic-token styling so toasts track the theme like every other surface.
const TONES = {
  success: { Icon: CheckCircle2,  chip: 'bg-success-soft text-success ring-success/20' },
  error:   { Icon: AlertTriangle, chip: 'bg-danger-soft text-danger ring-danger/20' },
  info:    { Icon: Info,          chip: 'bg-info-soft text-info ring-info/20' },
} as const;

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const h = setTimeout(onDismiss, t.ttlMs);
    return () => clearTimeout(h);
  }, [t.ttlMs, onDismiss]);
  const { Icon, chip } = TONES[t.kind];
  return (
    <div role="status"
         className="pointer-events-auto relative overflow-hidden flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-lg ring-1 ring-inset ring-line animate-slideup">
      <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${
        t.kind === 'success' ? 'via-success/50' : t.kind === 'error' ? 'via-danger/50' : 'via-info/50'}`} />
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${chip}`}>
        <Icon size={14} />
      </span>
      <span className="flex-1 min-w-0 break-words pt-0.5 text-sm text-fg">{t.message}</span>
      <button onClick={onDismiss} aria-label="Dismiss"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg">
        <X size={13} />
      </button>
    </div>
  );
}
