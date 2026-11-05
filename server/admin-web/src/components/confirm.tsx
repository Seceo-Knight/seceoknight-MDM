import { useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { Button, Field, Input, Modal, cn } from './ui';

/* ============================================================================
   Promise-based confirm dialogs — the styled replacement for window.confirm()
   and window.prompt('Type WIPE…'). Call confirmDialog({...}) from anywhere;
   <ConfirmRoot/> (mounted once in Layout) renders the dialog and resolves the
   promise with the user's choice. Dismissing (Escape / overlay / Cancel)
   resolves false, so call sites read as: if (await confirmDialog(...)) act().
   ========================================================================== */

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;        // default "Confirm"
  cancelLabel?: string;         // default "Cancel"
  tone?: 'danger' | 'warn' | 'accent';
  icon?: LucideIcon;            // default AlertTriangle
  requireText?: string;         // user must type this exactly to enable confirm
}

interface ConfirmState {
  seq: number;
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  open: (o: ConfirmOptions, resolve: (ok: boolean) => void) => void;
  close: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  seq: 0,
  current: null,
  open: (o, resolve) => set(s => ({ current: { ...o, resolve }, seq: s.seq + 1 })),
  close: (ok) => { get().current?.resolve(ok); set({ current: null }); },
}));

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => useConfirmStore.getState().open(opts, resolve));
}

const TONE = {
  danger: { chip: 'bg-danger-soft text-danger ring-1 ring-inset ring-danger/20', btn: 'danger-solid' as const },
  warn: { chip: 'bg-warn-soft text-warn ring-1 ring-inset ring-warn/25', btn: 'primary' as const },
  accent: { chip: 'bg-accent-soft text-accent ring-1 ring-inset ring-accent/20', btn: 'primary' as const },
};

export function ConfirmRoot() {
  const current = useConfirmStore(s => s.current);
  const seq = useConfirmStore(s => s.seq);
  if (!current) return null;
  // Key by seq so each request gets a fresh typed-text state.
  return <ConfirmModal key={seq} opts={current} />;
}

function ConfirmModal({ opts }: { opts: ConfirmOptions }) {
  const close = useConfirmStore(s => s.close);
  const [typed, setTyped] = useState('');
  const tone = TONE[opts.tone ?? 'danger'];
  const Icon = opts.icon ?? AlertTriangle;
  const armed = !opts.requireText || typed === opts.requireText;

  return (
    <Modal onClose={() => close(false)} label={opts.title} width="max-w-md">
      <div className="flex items-start gap-3.5 px-5 pb-1 pt-5">
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', tone.chip)}>
          <Icon size={20} />
        </span>
        <div className="min-w-0 pt-0.5">
          <div className="text-[15px] font-semibold leading-snug text-fg">{opts.title}</div>
          {opts.message && <div className="mt-1.5 text-sm leading-relaxed text-muted">{opts.message}</div>}
        </div>
      </div>
      {opts.requireText && (
        <div className="px-5 pb-1 pt-3">
          <Field label={`Type ${opts.requireText} to confirm`}>
            <Input
              autoFocus
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && armed) close(true); }}
              placeholder={opts.requireText}
              className="font-mono tracking-widest"
              aria-label={`Type ${opts.requireText} to confirm`}
            />
          </Field>
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-2 px-5 pb-4">
        <Button variant="ghost" onClick={() => close(false)}>{opts.cancelLabel ?? 'Cancel'}</Button>
        <Button variant={tone.btn} disabled={!armed} onClick={() => close(true)} autoFocus={!opts.requireText}>
          {opts.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </Modal>
  );
}
