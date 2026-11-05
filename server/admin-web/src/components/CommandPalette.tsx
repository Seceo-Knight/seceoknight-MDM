import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { Search, Smartphone, Moon, Sun, LogOut, UserCircle, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { listDevices, deviceLabel } from '../api/devices';
import { useAuth } from '../stores/authStore';
import { can } from '../lib/rbac';
import { nav } from './navItems';
import { Modal, cn } from './ui';

/* ============================================================================
   ⌘K command palette — fuzzy jump to any page, any device, or a quick action.
   Global hotkey (⌘K / Ctrl+K) is registered by <CommandPalette/>, which Layout
   keeps mounted; the sidebar search button opens it too via the store.
   ========================================================================== */

interface PaletteState { open: boolean; setOpen: (v: boolean) => void }
export const useCommandPalette = create<PaletteState>(set => ({
  open: false,
  setOpen: open => set({ open }),
}));

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface Item {
  id: string;
  group: 'Pages' | 'Actions' | 'Devices';
  label: string;
  hint?: string;
  Icon: LucideIcon;
  perform: () => void;
}

export function CommandPalette() {
  const open = useCommandPalette(s => s.open);
  const setOpen = useCommandPalette(s => s.setOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useCommandPalette.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;
  return <Palette onClose={() => setOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { dark, toggleDark, logout } = useAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { data: devices } = useQuery({
    queryKey: ['devices', 'palette'],
    queryFn: () => listDevices({ limit: 200 }),
    staleTime: 30_000,
  });

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => { onClose(); navigate(to); };
    const pages: Item[] = nav
      .filter(n => !n.perm || can(n.perm))
      .map(n => ({ id: `page:${n.to}`, group: 'Pages', label: n.label, hint: n.to, Icon: n.Icon, perform: go(n.to) }));
    pages.push({ id: 'page:/profile', group: 'Pages', label: 'Your profile', hint: '/profile', Icon: UserCircle, perform: go('/profile') });

    const actions: Item[] = [
      {
        id: 'act:theme', group: 'Actions',
        label: dark ? 'Switch to light theme' : 'Switch to dark theme',
        Icon: dark ? Sun : Moon,
        perform: () => { onClose(); toggleDark(); },
      },
      {
        id: 'act:signout', group: 'Actions', label: 'Sign out', Icon: LogOut,
        perform: () => { onClose(); logout(); navigate('/login'); },
      },
    ];

    const deviceItems: Item[] = (devices?.items ?? []).map(d => ({
      id: `dev:${d.id}`, group: 'Devices',
      label: deviceLabel(d),
      hint: [d.manufacturer, d.model, d.serial_number].filter(Boolean).join(' · ') || d.id.slice(0, 8),
      Icon: Smartphone,
      perform: go(`/devices/${d.id}`),
    }));

    return [...pages, ...actions, ...deviceItems];
  }, [devices, dark, toggleDark, logout, navigate, onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      // Idle state: every page + action, plus a taste of the fleet.
      const devs = items.filter(i => i.group === 'Devices').slice(0, 5);
      return [...items.filter(i => i.group !== 'Devices'), ...devs];
    }
    const match = (i: Item) =>
      i.label.toLowerCase().includes(needle) || (i.hint ?? '').toLowerCase().includes(needle);
    const hits = items.filter(match);
    // Prefix matches on the label float to the top within their group order.
    return hits.sort((a, b) =>
      Number(b.label.toLowerCase().startsWith(needle)) - Number(a.label.toLowerCase().startsWith(needle)));
  }, [items, q]);

  // Clamp/reset the cursor whenever the result set changes.
  useEffect(() => { setActive(0); }, [q]);
  const clamped = Math.min(active, Math.max(0, filtered.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${clamped}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % Math.max(1, filtered.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + filtered.length) % Math.max(1, filtered.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[clamped]?.perform(); }
  };

  let lastGroup: string | null = null;

  return (
    <Modal onClose={onClose} label="Command palette" align="top" bare className="w-full max-w-xl">
      <div onKeyDown={onKeyDown}
           className="relative flex max-h-[60vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        {/* Query row */}
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Jump to a page, device, or action…"
            aria-label="Search commands"
            className="w-full bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-faint">esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-faint">No matches for “{q}”.</div>
          )}
          {filtered.map((item, idx) => {
            const header = item.group !== lastGroup
              ? <div key={`h:${item.group}`} className="px-3 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-faint">{item.group}</div>
              : null;
            lastGroup = item.group;
            const isActive = idx === clamped;
            return (
              <div key={item.id}>
                {header}
                <button
                  data-idx={idx}
                  role="option"
                  aria-selected={isActive}
                  onMouseMove={() => setActive(idx)}
                  onClick={item.perform}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    isActive ? 'bg-surface-2 text-fg' : 'text-muted'
                  )}>
                  {isActive && <span className="nav-active-bar absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full" />}
                  <span className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors',
                    isActive ? 'bg-accent/12 text-accent ring-accent/20' : 'bg-surface-2 text-faint ring-line'
                  )}>
                    <item.Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                  {item.hint && <span className="shrink-0 truncate font-mono text-2xs text-faint max-w-[14rem]">{item.hint}</span>}
                  {isActive && <CornerDownLeft size={13} className="shrink-0 text-faint" />}
                </button>
              </div>
            );
          })}
        </div>

        {/* Hints */}
        <div className="flex items-center gap-3 border-t border-line bg-surface-2/50 px-4 py-2 text-2xs text-faint">
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-line bg-surface px-1">↑↓</kbd> navigate</span>
          <span className="inline-flex items-center gap-1"><kbd className="rounded border border-line bg-surface px-1">↵</kbd> open</span>
          <span className="ml-auto inline-flex items-center gap-1">
            <kbd className="rounded border border-line bg-surface px-1">{isMac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="rounded border border-line bg-surface px-1">K</kbd>
          </span>
        </div>
      </div>
    </Modal>
  );
}
