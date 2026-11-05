import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { listSessions, revokeSession, type Session } from '../api/auth';
import { useAuth } from '../stores/authStore';
import { useCan } from '../lib/rbac';
import { confirmDialog } from '../components/confirm';
import { formatRelative } from '../components/online';
import { Card, Input, Badge, Button, Skeleton, cn, PageHero, HeroStat } from '../components/ui';
import {
  KeyRound, Users, ShieldAlert, Globe, Monitor, LogOut, Search, Clock, MapPin, UserCheck
} from 'lucide-react';

// One audit row (mirrors Audit.tsx) — used here for login history.
interface AuditEntry {
  id: string;
  actor_id?: string;
  action: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

// Best-effort browser + OS from a User-Agent string. Keeps the table readable
// instead of dumping a 200-char UA.
function parseUA(ua: string): { browser: string; os: string } {
  if (!ua) return { browser: 'Unknown client', os: '' };
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/curl\//i.test(ua)) browser = 'curl';
  else if (/okhttp|MDM/i.test(ua)) browser = 'Agent';
  let os = '';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

function roleTone(role: string) {
  if (role === 'super_admin') return 'danger' as const;
  if (role === 'admin') return 'accent' as const;
  return 'muted' as const;
}

// Short, human "expires in" using the same vocabulary as formatRelative but for
// a future instant.
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function AccessLog() {
  const me = useAuth(s => s.user);
  const canRevoke = useCan('user:manage');
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');

  const { data: sessions, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: listSessions,
    refetchInterval: 10_000,
  });

  // Login history: reuse the audit feed, filtered to login events (which the
  // auth-service now emits with ip + user_agent in metadata).
  const { data: logins } = useQuery({
    queryKey: ['login-history'],
    queryFn: async () => {
      const items = (await api.get<{ items: AuditEntry[] }>('/api/v1/audit?limit=300')).data.items;
      return items.filter(e => e.action === 'user.login' || e.action === 'user.login_failed');
    },
    refetchInterval: 15_000,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });

  const rows = useMemo(() => {
    const list = sessions ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(s =>
      s.email.toLowerCase().includes(q) || s.ip.toLowerCase().includes(q) || s.role.toLowerCase().includes(q));
  }, [sessions, filter]);

  // KPIs.
  const stats = useMemo(() => {
    const list = sessions ?? [];
    const users = new Set(list.map(s => s.user_id)).size;
    const ips = new Set(list.map(s => s.ip).filter(Boolean)).size;
    const dayAgo = Date.now() - 86_400_000;
    const failed = (logins ?? []).filter(e => e.action === 'user.login_failed' && new Date(e.created_at).getTime() > dayAgo).length;
    return { active: list.length, users, ips, failed };
  }, [sessions, logins]);

  async function onRevoke(s: Session) {
    const mine = s.user_id === me?.id;
    if (!(await confirmDialog({
      title: `Sign out this session?`,
      message: mine
        ? `This is one of YOUR sessions (${s.email}). Revoking it may log you out of this browser.`
        : `Force-logout ${s.email} (${parseUA(s.user_agent).browser} · ${s.ip || 'unknown IP'}). They'll need to sign in again.`,
      confirmLabel: 'Sign out',
    }))) return;
    revoke.mutate(s.id);
  }

  return (
    <div className="space-y-5">
      <PageHero
        icon={KeyRound}
        eyebrow="Security"
        title="Access log"
        subtitle="Who is signed in to the console, from where, and recent sign-in activity."
        stats={
          <>
            <HeroStat icon={UserCheck} label="Active sessions" value={isLoading ? '—' : stats.active} tone="accent" />
            <HeroStat icon={Users} label="Users online" value={isLoading ? '—' : stats.users} tone="info" />
            <HeroStat icon={Globe} label="Unique IPs" value={isLoading ? '—' : stats.ips} tone="success" />
            <HeroStat icon={ShieldAlert} label="Failed logins (24h)" value={stats.failed} tone={stats.failed > 0 ? 'danger' : 'muted'} />
          </>
        }
      />

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint" />
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by user, IP or role…" className="pl-9 h-9" />
      </div>

      {/* Active sessions */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-accent" />
          <span className="font-medium text-sm">Active sessions</span>
          <Badge tone="info" dot>{rows.length}</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2/40 text-left text-2xs uppercase tracking-wider text-faint">
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">IP address</th>
                <th className="px-4 py-2.5 font-medium">Last active</th>
                <th className="px-4 py-2.5 font-medium">Expires</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="rail">
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-6"><Skeleton className="h-5 w-full" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-faint">No active sessions{filter ? ' match your filter' : ''}.</td></tr>
              ) : rows.map(s => {
                const ua = parseUA(s.user_agent);
                const mine = s.user_id === me?.id;
                return (
                  <tr key={s.id} className="border-t border-line/70 hover:bg-surface-2 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{s.email}</span>
                        {mine && <Badge tone="success">you</Badge>}
                        <Badge tone={roleTone(s.role)}>{s.role}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <Monitor className="w-3.5 h-3.5 text-faint" />
                        {ua.browser}{ua.os ? ` · ${ua.os}` : ''}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">
                      <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3 text-faint" />{s.ip || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted"><span className="inline-flex items-center gap-1"><Clock className="w-3 h-3 text-faint" />{formatRelative(s.issued_at)}</span></td>
                    <td className="px-4 py-2.5 tabular-nums text-muted">{expiresIn(s.expires_at)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant={mine ? 'secondary' : 'danger'} className="h-7 px-2"
                        disabled={!canRevoke || revoke.isPending}
                        title={canRevoke ? 'Force sign-out' : 'Requires user:manage'}
                        onClick={() => onRevoke(s)}>
                        <LogOut className="w-3.5 h-3.5" /> Sign out
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Login history */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <Clock className="w-4 h-4 text-accent" />
          <span className="font-medium text-sm">Recent sign-in activity</span>
        </div>
        {logins == null ? (
          <div className="px-4 py-6"><Skeleton className="h-5 w-full" /></div>
        ) : logins.length === 0 ? (
          <div className="px-4 py-10 text-center text-faint">No sign-in events recorded yet. New logins will appear here.</div>
        ) : (
          <ul className="rail divide-y divide-line/70">
            {logins.map(e => {
              const m = (e.metadata ?? {}) as Record<string, string>;
              const ua = parseUA(m.user_agent || '');
              const failed = e.action === 'user.login_failed';
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={cn('grid place-items-center h-7 w-7 rounded-lg shrink-0',
                    failed ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success')}>
                    {failed ? <ShieldAlert className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{m.email || e.actor_id || 'unknown'}</span>
                      <Badge tone={failed ? 'danger' : 'success'}>{failed ? 'failed' : 'signed in'}</Badge>
                    </div>
                    <div className="text-2xs text-faint truncate">
                      {ua.browser}{ua.os ? ` · ${ua.os}` : ''} · {m.ip || 'unknown IP'}
                    </div>
                  </div>
                  <span className="text-xs text-faint tabular-nums shrink-0">{formatRelative(e.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
