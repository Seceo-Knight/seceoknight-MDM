import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../stores/authStore';
import { Moon, Sun, LogOut, Menu, X, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { ToastRoot } from './toast';
import { ConfirmRoot } from './confirm';
import { CommandPalette, useCommandPalette, isMac } from './CommandPalette';
import { can } from '../lib/rbac';
import { BrandIcon, BrandWordmark, CompanyLogo } from './brand';

import { nav, type NavItem } from './navItems';

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 group">
      <BrandIcon className="w-9 h-9 transition-transform group-hover:scale-105" />
      <div className="leading-tight">
        <BrandWordmark className="text-base" />
        <div className="text-2xs uppercase tracking-wider text-faint">Mobile Device Management</div>
      </div>
    </Link>
  );
}

// Sleek, always-visible company bar — FIXED to the viewport bottom (stays put
// on scroll), offset to clear the sidebar. Opaque (no backdrop-blur) so it never
// re-rasterizes over scrolling content. Product lockup left, SeceoKnight
// Technologies mark right.
function AppFooter({ collapsed }: { collapsed: boolean }) {
  const year = new Date().getFullYear();
  return (
    <footer className={clsx(
      'fixed bottom-0 left-0 right-0 z-20 h-[52px] border-t border-line bg-surface shadow-[0_-12px_34px_-22px_rgb(0_0_0_/_0.35)] transition-[left] duration-200 ease-out',
      collapsed ? 'lg:left-16' : 'lg:left-64'
    )}>
      {/* machined top edge — a soft accent hairline */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent" />
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-5 sm:px-6 lg:px-8">
        {/* Product */}
        <Link to="/" className="group flex items-center gap-3 min-w-0">
          {/* shield in a subtle badge so it reads as a deliberate mark, not a floating logo */}
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 ring-1 ring-inset ring-line shadow-xs transition-all duration-200 group-hover:ring-accent/30 group-hover:-translate-y-px">
            <BrandIcon className="h-[22px] w-[22px]" />
          </span>
          <BrandWordmark className="text-[15px]" />
          <span className="hidden sm:block h-3.5 w-px bg-line" />
          <span className="hidden sm:inline text-2xs font-medium uppercase tracking-[0.2em] text-faint">Mobile Device Management</span>
        </Link>
        {/* Company */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline text-2xs text-faint whitespace-nowrap tabular-nums">© {year}</span>
          <span className="hidden md:block h-3.5 w-px bg-line" />
          <CompanyLogo className="opacity-80" />
        </div>
      </div>
    </footer>
  );
}

function NavSection({ label, items, onNavigate, collapsed }: { label: string; items: NavItem[]; onNavigate: () => void; collapsed: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      {collapsed
        ? <div className="mx-2 mb-1.5 h-px bg-line/70" />
        : <div className="text-2xs font-semibold uppercase tracking-wider text-faint px-3 mb-1.5">{label}</div>}
      <nav className="space-y-0.5">
        {items.map(({ to, label, Icon }) => (
          <NavLink
            key={to} to={to} end={to === '/'} onClick={onNavigate}
            title={collapsed ? label : undefined}
            className={({ isActive }) => clsx(
              'group relative flex items-center rounded-lg py-2 text-[13px] font-medium transition-all duration-150',
              collapsed ? 'justify-center px-0' : 'gap-2.5 pl-3 pr-2.5',
              isActive
                ? 'bg-accent/10 text-accent ring-1 ring-inset ring-accent/15'
                : 'text-muted hover:text-fg hover:bg-surface-2 hover:translate-x-0.5'
            )}
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="nav-active-bar absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full" />}
                <Icon size={16} className={clsx('shrink-0 transition-transform group-hover:scale-110', isActive ? 'text-accent' : 'text-faint group-hover:text-muted')} />
                {!collapsed && label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Sidebar({ onNavigate, collapsed = false, onToggleCollapse }: { onNavigate: () => void; collapsed?: boolean; onToggleCollapse?: () => void }) {
  const { dark, toggleDark, user, logout } = useAuth();
  const navigate = useNavigate();
  const fleet = nav.filter(n => n.section === 'fleet' && (!n.perm || can(n.perm)));
  const ops = nav.filter(n => n.section === 'ops' && (!n.perm || can(n.perm)));
  const initials = (user?.email ?? '?').slice(0, 2).toUpperCase();
  const iconBtn = 'w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors shrink-0';

  const openPalette = () => useCommandPalette.getState().setOpen(true);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className={clsx('h-16 flex items-center border-b border-line', collapsed ? 'justify-center px-0' : 'px-5')}>
        {collapsed
          ? <Link to="/" title="SeceoKnight MDM — Mobile Device Management"><BrandIcon className="w-9 h-9" /></Link>
          : <Brand />}
      </div>

      {/* ⌘K trigger — the palette is the fastest way anywhere. */}
      {collapsed ? (
        <div className="flex justify-center pt-3">
          <button onClick={openPalette} aria-label="Search (⌘K)" title="Search (⌘K)" className={iconBtn}>
            <Search size={15} />
          </button>
        </div>
      ) : (
        <div className="px-3 pt-3">
          <button onClick={openPalette}
                  className="group flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-xs text-faint transition-colors hover:border-line-strong hover:text-muted">
            <Search size={13} className="shrink-0" />
            Search…
            <kbd className="ml-auto rounded border border-line bg-surface px-1.5 py-0.5 text-2xs tracking-wide text-faint">
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>
          </button>
        </div>
      )}

      <div className={clsx('flex-1 overflow-y-auto py-4 space-y-5', collapsed ? 'px-2' : 'px-3')}>
        <NavSection label="Fleet" items={fleet} onNavigate={onNavigate} collapsed={collapsed} />
        <NavSection label="Operations" items={ops} onNavigate={onNavigate} collapsed={collapsed} />
      </div>

      <div className={clsx('border-t border-line p-3', collapsed && 'flex flex-col items-center gap-1')}>
        {collapsed ? (
          <>
            <Link to="/profile" onClick={onNavigate} title={user?.email}
                  className="w-9 h-9 rounded-full bg-accent/15 text-accent grid place-items-center text-xs font-semibold hover:bg-accent/25 transition-colors">
              {initials}
            </Link>
            <button onClick={toggleDark} aria-label="Toggle theme" title="Toggle theme" className={iconBtn}>
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button onClick={() => { logout(); navigate('/login'); }} aria-label="Sign out" title="Sign out"
                    className="w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors shrink-0">
              <LogOut size={15} />
            </button>
            {onToggleCollapse && (
              <button onClick={onToggleCollapse} aria-label="Expand sidebar" title="Expand sidebar"
                      className="mt-1 w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors">
                <PanelLeftOpen size={16} />
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 rounded-lg p-2">
              <Link to="/profile" onClick={onNavigate} className="flex items-center gap-2.5 min-w-0 flex-1 group">
                <span className="w-8 h-8 rounded-full bg-accent/15 text-accent grid place-items-center text-xs font-semibold shrink-0">{initials}</span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg truncate group-hover:text-accent transition-colors" title={user?.email}>{user?.email ?? 'Signed in'}</span>
                  <span className="block text-2xs text-faint capitalize">{user?.role?.replace('_', ' ')}</span>
                </span>
              </Link>
              <button onClick={toggleDark} aria-label="Toggle theme" className={iconBtn}>
                {dark ? <Sun size={15} /> : <Moon size={15} />}
              </button>
              <button onClick={() => { logout(); navigate('/login'); }} aria-label="Sign out"
                      className="w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors shrink-0">
                <LogOut size={15} />
              </button>
            </div>
            {onToggleCollapse && (
              <button onClick={onToggleCollapse}
                      className="w-full flex items-center gap-2.5 rounded-lg pl-3 pr-2.5 py-2 text-[13px] font-medium text-muted hover:text-fg hover:bg-surface-2 transition-colors">
                <PanelLeftClose size={16} className="text-faint shrink-0" />
                Collapse
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { dark } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar-collapsed') === '1'; } catch { return false; }
  });
  const loc = useLocation();

  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => { setMobileOpen(false); }, [loc.pathname]);
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c;
    try { localStorage.setItem('sidebar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <div className="h-full">
      {/* Desktop sidebar */}
      <aside className={clsx('hidden lg:flex fixed inset-y-0 left-0 border-r border-line z-30 transition-[width] duration-200 ease-out', collapsed ? 'w-16' : 'w-64')}>
        <Sidebar onNavigate={() => {}} collapsed={collapsed} onToggleCollapse={toggleCollapsed} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fadein" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-line shadow-overlay animate-drawer-in">
            <button onClick={() => setMobileOpen(false)} aria-label="Close menu"
                    className="absolute top-4 right-3 z-10 w-8 h-8 grid place-items-center rounded-lg text-muted hover:bg-surface-2">
              <X size={16} />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className={clsx('relative h-full flex flex-col transition-[padding] duration-200 ease-out', collapsed ? 'lg:pl-16' : 'lg:pl-64')}>
        {/* Ambient atmosphere — a whisper-quiet, theme-aware accent wash plus a
            fine engineering grid (the login hero's visual language, app-wide).
            Fixed + pointer-events-none so it never interferes. */}
        <div className="app-aura pointer-events-none fixed inset-0 z-0" />
        <div className="app-grid pointer-events-none fixed inset-0 z-0" />

        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-20 h-14 flex items-center justify-between px-4 border-b border-line bg-surface/80 backdrop-blur">
          <Brand />
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu"
                  className="w-9 h-9 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-2">
            <Menu size={18} />
          </button>
        </header>

        <main className="relative z-10 flex-1 overflow-auto">
          {/* `key` re-triggers the entrance animation on every route change.
              pb clears the fixed bottom AppFooter so nothing hides behind it. */}
          <div key={loc.pathname} className="page-enter mx-auto w-full max-w-7xl px-5 pt-6 pb-20 sm:px-6 lg:px-8 lg:pt-8 lg:pb-24">{children}</div>
        </main>
      </div>

      {/* Sleek company bar — fixed to the viewport bottom, always visible. */}
      <AppFooter collapsed={collapsed} />
      <ToastRoot />
      <ConfirmRoot />
      <CommandPalette />
    </div>
  );
}
