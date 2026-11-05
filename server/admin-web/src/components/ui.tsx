import clsx from 'clsx';
import { forwardRef, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const cn = clsx;

/* ============================== Hairline ==============================
   The signature top-edge accent — a 1px gradient that fades in from both
   sides. One component instead of the same span copy-pasted per card. Parent
   must be `relative` (and usually `overflow-hidden`). */
const hairlineTone = {
  accent: 'via-accent/50',
  faint: 'via-accent/40',
  strong: 'via-accent/60',
  success: 'via-success/50',
} as const;

export function Hairline({ tone = 'accent', className }: {
  tone?: keyof typeof hairlineTone; className?: string;
}) {
  return (
    <span aria-hidden className={cn(
      'pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent',
      hairlineTone[tone], className
    )} />
  );
}

/* ============================== Surfaces ============================== */

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-sm', className)} {...rest} />;
}

// A titled panel: header row (optional icon chip + title + optional actions)
// over body content. Passing `icon` renders a soft accent chip before the title
// for a polished, consistent section header across the app.
export function Panel({ title, subtitle, actions, icon: Icon, children, className, bodyClassName }: {
  title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; icon?: LucideIcon;
  children: React.ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line">
          <div className="flex items-start gap-2.5 min-w-0">
            {Icon && (
              <span className="mt-0.5 grid place-items-center h-7 w-7 shrink-0 rounded-lg bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
                <Icon size={15} />
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="font-display text-sm font-semibold text-fg">{title}</h2>}
              {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </Card>
  );
}

// In-body section header — an icon chip + title (+ optional hint and right-side
// actions). Use to give every distinct block on a page clear, consistent
// hierarchy without a full Panel wrapper.
export function SectionHeading({ icon: Icon, title, hint, actions, className }: {
  icon?: LucideIcon; title: React.ReactNode; hint?: React.ReactNode; actions?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5 mb-3', className)}>
      {Icon && (
        <span className="grid place-items-center h-7 w-7 shrink-0 rounded-lg bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
          <Icon size={14} />
        </span>
      )}
      <div className="min-w-0">
        <div className="text-sm font-semibold text-fg leading-tight truncate">{title}</div>
        {hint && <div className="text-2xs text-faint truncate">{hint}</div>}
      </div>
      {actions && <div className="ml-auto shrink-0">{actions}</div>}
    </div>
  );
}

/* ============================== Buttons ============================== */

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid' | 'subtle';
type BtnSize = 'sm' | 'md';

const btnBase = 'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap select-none';
const btnVariant: Record<BtnVariant, string> = {
  primary: 'btn-brand ring-1 ring-inset ring-white/20 active:translate-y-px transition-all',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-2 hover:border-line-strong active:translate-y-px',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'text-danger border border-danger/30 hover:bg-danger/10',
  'danger-solid': 'bg-danger-solid text-white hover:bg-danger-solid-hover shadow-sm ring-1 ring-inset ring-white/10 active:translate-y-px',
  subtle: 'bg-surface-2 text-fg hover:bg-surface-3',
};
const btnSize: Record<BtnSize, string> = { sm: 'text-xs px-2.5 py-1.5 h-8', md: 'text-sm px-3.5 py-2 h-9' };

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }>(
  ({ variant = 'secondary', size = 'md', className, ...rest }, ref) => (
    <button ref={ref} className={cn(btnBase, btnVariant[variant], btnSize[size], className)} {...rest} />
  )
);
Button.displayName = 'Button';

export function IconButton({ label, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label}
    className={cn('inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors', className)} {...rest} />;
}

/* ============================== Badge ============================== */

type Tone = 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'muted';
const toneCls: Record<Tone, string> = {
  default: 'bg-surface-2 text-fg ring-1 ring-inset ring-line',
  accent: 'bg-accent/12 text-accent ring-1 ring-inset ring-accent/20',
  success: 'bg-success/12 text-success ring-1 ring-inset ring-success/20',
  warn: 'bg-warn/15 text-warn ring-1 ring-inset ring-warn/25',
  danger: 'bg-danger/12 text-danger ring-1 ring-inset ring-danger/20',
  info: 'bg-info/12 text-info ring-1 ring-inset ring-info/20',
  muted: 'bg-surface-2 text-muted ring-1 ring-inset ring-line',
};
export function Badge({ tone = 'default', dot, className, children }: { tone?: Tone; dot?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium', toneCls[tone], className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

/* ============================== Stat / KPI ============================== */

export function Stat({ label, value, sub, icon, trend, accent }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode;
  trend?: { dir: 'up' | 'down' | 'flat'; label: string }; accent?: boolean;
}) {
  const trendCls = trend?.dir === 'up' ? 'text-success' : trend?.dir === 'down' ? 'text-danger' : 'text-muted';
  return (
    <Card className={cn(
      'group relative p-4 overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-line-strong',
      accent && 'ring-1 ring-accent/30'
    )}>
      {/* Hairline that ignites on hover (always lit for the accent variant). */}
      <Hairline className={cn('transition-opacity duration-200', accent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} />
      {accent && <span className="pointer-events-none absolute -top-12 -right-10 w-28 h-28 rounded-full bg-accent/15 blur-2xl" />}
      <div className="relative flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted">{label}</span>
        {icon && (
          <span className="grid place-items-center w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_6px_16px_-6px_rgba(99,102,241,0.6)] ring-1 ring-white/20 transition-transform duration-200 group-hover:scale-105">
            {icon}
          </span>
        )}
      </div>
      <div className="relative mt-3 text-[1.7rem] font-semibold text-fg tabular-nums leading-none tracking-tight">{value}</div>
      {(sub || trend) && (
        <div className="relative mt-2 flex items-center gap-2 text-xs">
          {trend && <span className={cn('font-medium', trendCls)}>{trend.label}</span>}
          {sub && <span className="text-muted">{sub}</span>}
        </div>
      )}
    </Card>
  );
}

/* ============================== Page header ============================== */

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 relative pl-3.5">
        {/* Slim gradient rail — a quiet identity cue echoed from the brand mark. */}
        <span className="absolute left-0 top-1 bottom-1 w-1 rounded-full bg-gradient-to-b from-indigo-500 to-violet-600" />
        <h1 className="text-xl font-semibold text-fg tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ============================== Page hero ==============================
   The canonical page title bar used across every page — one component so the
   whole app's headers are identical (not merely similar). A calm command-center
   banner: a gradient brand-icon tile, an uppercase eyebrow, a Bricolage display
   title, a subtitle, an optional right-aligned `actions` slot, and an optional
   `stats` chip row beneath. Decoration is static (no perpetual motion). */
export function PageHero({ icon: Icon, eyebrow, title, subtitle, actions, stats, aside }: {
  icon: LucideIcon;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  stats?: React.ReactNode;
  aside?: React.ReactNode;     // right-side visual (e.g. the fleet-health ring)
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-sm animate-fadein">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-28 -right-20 w-80 h-80 rounded-full bg-accent/12 blur-3xl" />
        <div className="absolute -bottom-32 left-1/4 w-72 h-72 rounded-full bg-info/10 blur-3xl" />
      </div>
      <Hairline />
      <div className="relative flex items-center justify-between gap-6 p-6 sm:p-7">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="grid place-items-center w-12 h-12 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_10px_28px_-8px_rgba(99,102,241,0.7)] ring-1 ring-white/20">
                <Icon size={20} />
              </div>
              <div className="min-w-0">
                {eyebrow && <div className="flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-muted">{eyebrow}</div>}
                <h1 className="mt-1 font-display text-2xl font-semibold text-fg tracking-tight">{title}</h1>
                {subtitle && <p className="mt-1.5 text-sm text-muted max-w-2xl">{subtitle}</p>}
              </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
          </div>
          {stats && <div className="relative mt-5 flex flex-wrap items-center gap-2">{stats}</div>}
        </div>
        {aside && <div className="hidden shrink-0 sm:block">{aside}</div>}
      </div>
    </section>
  );
}

const heroStatTone: Record<string, string> = {
  accent: 'text-accent bg-accent-soft ring-accent/20',
  success: 'text-success bg-success-soft ring-success/20',
  info: 'text-info bg-info-soft ring-info/20',
  warn: 'text-warn bg-warn-soft ring-warn/20',
  danger: 'text-danger bg-danger-soft ring-danger/20',
  muted: 'text-muted bg-surface-2 ring-line',
};

// A consistent at-a-glance KPI chip for the PageHero `stats` row.
export function HeroStat({ icon: Icon, label, value, tone = 'accent' }: {
  icon?: LucideIcon; label: string; value: React.ReactNode;
  tone?: 'accent' | 'success' | 'info' | 'warn' | 'danger' | 'muted';
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-surface/70 backdrop-blur px-3 py-2 ring-1 ring-inset ring-line shadow-xs">
      {Icon && <span className={cn('grid place-items-center h-8 w-8 rounded-lg ring-1 ring-inset', heroStatTone[tone])}><Icon size={15} /></span>}
      <div className="leading-tight">
        <div className="text-base font-semibold text-fg tabular-nums">{value}</div>
        <div className="text-2xs uppercase tracking-wider text-faint">{label}</div>
      </div>
    </div>
  );
}

/* ============================== Empty / loading ============================== */

export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon && <div className="w-11 h-11 rounded-xl bg-surface-2 text-faint flex items-center justify-center mb-3">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint && <p className="text-xs text-muted mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />;
}

/* ============================== Form fields ============================== */

const fieldCls = 'w-full rounded-lg border border-line bg-surface text-sm text-fg placeholder:text-faint px-3 py-2 transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input ref={ref} className={cn(fieldCls, className)} {...rest} />
);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...rest }, ref) => <select ref={ref} className={cn(fieldCls, 'pr-8', className)} {...rest} />
);
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => <textarea ref={ref} className={cn(fieldCls, 'resize-y', className)} {...rest} />
);
Textarea.displayName = 'Textarea';

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-2xs text-faint mt-1">{hint}</span>}
    </label>
  );
}

/* ============================== Modal ==============================
   The single overlay primitive for the whole app: dimmed blurred backdrop,
   centered panel, entrance animation, Escape + overlay-click dismissal, body
   scroll-lock, and focus containment. Rendered through a portal so an animated
   or transformed ancestor can never capture `position: fixed` and drag the
   overlay out of the viewport. Stacking-aware: with two modals open (e.g. a
   confirm on top of a dialog) Escape only closes the top one. */

const modalStack: symbol[] = [];

export function Modal({ onClose, label, width = 'max-w-lg', bare, align = 'center', className, children }: {
  onClose: () => void;
  label: string;                 // accessible dialog name
  width?: string;                // Tailwind max-w-* class for the panel
  bare?: boolean;                // no panel chrome (e.g. image lightbox)
  align?: 'center' | 'top';      // 'top' for command-palette-style surfaces
  className?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement as HTMLElement | null;
    // Respect an autoFocus child (it grabs focus during commit, before this
    // effect runs); otherwise focus the panel so Escape/Tab work immediately.
    const root = panelRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();

    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return; // not the top modal
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab cycling inside the panel.
      const root = panelRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), audio[controls], [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      modalStack.splice(modalStack.indexOf(id), 1);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className={cn(
           'fixed inset-0 z-50 flex justify-center bg-black/50 p-4 backdrop-blur-sm animate-fadein',
           align === 'top' ? 'items-start pt-[14vh]' : 'items-center'
         )}
         onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
           onClick={e => e.stopPropagation()}
           className={cn(
             'animate-scalein outline-none',
             !bare && 'relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay',
             !bare && width,
             className
           )}>
        {!bare && <Hairline />}
        {children}
      </div>
    </div>,
    document.body
  );
}

const modalIconTone = {
  brand: 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm ring-1 ring-white/20',
  accent: 'bg-accent-soft text-accent ring-1 ring-inset ring-accent/20',
  success: 'bg-success-soft text-success ring-1 ring-inset ring-success/20',
  warn: 'bg-warn-soft text-warn ring-1 ring-inset ring-warn/25',
  danger: 'bg-danger-soft text-danger ring-1 ring-inset ring-danger/20',
} as const;

export function ModalHeader({ icon: Icon, tone = 'brand', title, subtitle, onClose, children }: {
  icon?: LucideIcon; tone?: keyof typeof modalIconTone;
  title: React.ReactNode; subtitle?: React.ReactNode;
  onClose: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
      {Icon && (
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', modalIconTone[tone])}>
          <Icon size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-fg">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
      </div>
      {children}
      <IconButton label="Close" onClick={onClose} className="-mr-1 shrink-0"><X size={16} /></IconButton>
    </div>
  );
}

export function ModalBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)}>{children}</div>;
}

export function ModalFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3.5', className)}>{children}</div>;
}
