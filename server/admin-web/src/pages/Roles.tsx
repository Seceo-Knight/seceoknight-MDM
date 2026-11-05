import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRoles, listUsers, createUser, updateUserRole, deactivateUser } from '../api/auth';
import { useCan, assignableRoles, canManageTarget } from '../lib/rbac';
import { useAuth } from '../stores/authStore';
import { toast } from '../components/toast';
import { Panel, Field, Input, Select, Button, Badge, EmptyState, PageHero, Skeleton, cn, Hairline } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { Check, ShieldOff, ShieldCheck, Users, KeyRound, UserPlus, Grid3x3, Eye, Wrench, Shield, Crown } from 'lucide-react';

const ROLE_TONE: Record<string, 'muted' | 'info' | 'accent' | 'danger'> = {
  viewer: 'muted', operator: 'info', admin: 'accent', super_admin: 'danger',
};

// Per-role identity used in the matrix column headers / role cards (presentation only).
const ROLE_ICON: Record<string, typeof Eye> = {
  viewer: Eye, operator: Wrench, admin: Shield, super_admin: Crown,
};

// Tonal surface for a role's icon/avatar chip — keeps the palette intentional
// (neutral → info → indigo → danger) rather than rainbow.
const ROLE_CHIP: Record<'muted' | 'info' | 'accent' | 'danger', string> = {
  muted: 'bg-surface-2 text-muted ring-line',
  info: 'bg-info-soft text-info ring-info/20',
  accent: 'bg-accent-soft text-accent ring-accent/20',
  danger: 'bg-danger-soft text-danger ring-danger/20',
};

export function Roles() {
  const canViewMatrix = useCan('role:read');
  const canViewUsers = useCan('user:read');
  const canManage = useCan('user:manage');

  if (!canViewMatrix && !canViewUsers) {
    return (
      <div className="grid place-items-center min-h-[60vh] px-6 animate-fadein">
        <div className="relative overflow-hidden w-full max-w-md rounded-2xl border border-line bg-surface shadow-sm card-grad ring-1 ring-inset ring-line">
          <Hairline />
          <span className="pointer-events-none absolute -top-16 -right-12 w-40 h-40 rounded-full bg-accent/10 blur-3xl" />
          <div className="relative flex flex-col items-center text-center px-8 py-12">
            <span className="grid place-items-center h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_10px_28px_-8px_rgba(99,102,241,0.7)] ring-1 ring-white/20">
              <ShieldOff size={22} />
            </span>
            <h2 className="mt-4 text-base font-semibold text-fg">No access</h2>
            <p className="mt-1.5 text-sm text-muted max-w-xs">
              You don't have permission to view roles &amp; users. Ask an administrator to grant
              the <span className="font-mono text-xs text-fg">role:read</span> or <span className="font-mono text-xs text-fg">user:read</span> permission.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHero
        icon={KeyRound}
        eyebrow={<><ShieldCheck size={13} className="text-success" /> Access management</>}
        title="Access control"
        subtitle="Roles, their permissions, and the users they're assigned to."
      />

      {canViewUsers && <UsersSection canManage={canManage} />}
      {canViewMatrix && <MatrixSection />}
    </div>
  );
}

function UsersSection({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const myID = useAuth(s => s.user?.id);
  const myRole = useAuth(s => s.user?.role);
  const { data: users, isLoading } = useQuery({ queryKey: ['tenant-users'], queryFn: listUsers, refetchInterval: 10000 });
  const { data: matrix } = useQuery({ queryKey: ['roles-matrix'], queryFn: getRoles });
  const roles = matrix?.roles ?? ['viewer', 'operator', 'admin', 'super_admin'];
  // Only roles at or below my own — an admin can't mint/assign super_admin.
  const assignable = assignableRoles(myRole, roles);

  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [role, setRole] = useState('viewer');

  const create = useMutation({
    mutationFn: () => createUser(email.trim(), pw, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); setEmail(''); setPw(''); setRole('viewer'); toast.success('User created'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Create failed')
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => updateUserRole(id, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); toast.success('Role updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => deactivateUser(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); toast.success('User deactivated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Deactivate failed')
  });

  return (
    <Panel
      icon={Users}
      title="Users"
      subtitle="Console accounts in this tenant."
      actions={
        users && !isLoading
          ? <Badge tone="muted">{users.length} {users.length === 1 ? 'account' : 'accounts'}</Badge>
          : undefined
      }
      bodyClassName="p-0"
      className="animate-slideup overflow-hidden"
    >
      {canManage && (
        <div className="relative flex flex-wrap items-end gap-3 px-4 py-4 border-b border-line bg-surface-2/40">
          <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-indigo-500 to-violet-600" />
          <div className="flex items-center gap-2 w-full text-2xs font-medium uppercase tracking-wider text-faint">
            <UserPlus size={13} className="text-accent" />
            Provision an account
          </div>
          <Field label="Email"><Input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="user@company.com" className="w-56" /></Field>
          <Field label="Temp password" hint="Minimum 8 characters."><Input value={pw} onChange={e => setPw(e.target.value)} type="text" placeholder="Set a password" className="w-48" /></Field>
          <Field label="Role">
            <Select value={role} onChange={e => setRole(e.target.value)} className="w-36">
              {assignable.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
            </Select>
          </Field>
          <Button variant="primary" disabled={!email.trim() || pw.length < 8 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2/40">
              <th className="px-4 py-2.5 font-semibold">Email</th>
              <th className="px-4 py-2.5 font-semibold">Role</th>
              <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="rail divide-y divide-line">
            {isLoading && Array.from({ length: 4 }).map((_, i) => (
              <tr key={`sk-${i}`} className="animate-fadein" style={{ animationDelay: `${i * 40}ms` }}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Skeleton className="h-7 w-7 rounded-full" />
                    <Skeleton className="h-3.5 w-44 rounded" />
                  </div>
                </td>
                <td className="px-4 py-3"><Skeleton className="h-5 w-20 rounded-full" /></td>
                <td className="px-4 py-3"><div className="flex justify-end"><Skeleton className="h-3.5 w-16 rounded" /></div></td>
              </tr>
            ))}
            {!isLoading && users && users.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4">
                  <EmptyState
                    icon={<Users size={18} />}
                    title="No accounts yet"
                    hint={canManage ? 'Provision the first console account with the form above.' : 'No console accounts exist in this tenant yet.'}
                  />
                </td>
              </tr>
            )}
            {users?.map((u, i) => {
              const isSelf = u.id === myID;
              const manageable = canManage && !isSelf && canManageTarget(myRole, u.role);
              const RoleIcon = ROLE_ICON[u.role] ?? Shield;
              const tone = ROLE_TONE[u.role] ?? 'muted';
              return (
                <tr key={u.id} className="group hover:bg-surface-2 transition-colors animate-fadein" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className={cn(
                        'relative grid place-items-center h-8 w-8 rounded-full ring-1 ring-inset text-2xs font-semibold uppercase shadow-xs transition-transform group-hover:scale-105',
                        ROLE_CHIP[tone]
                      )}>
                        {u.email.slice(0, 2)}
                        <span className={cn(
                          'absolute -bottom-0.5 -right-0.5 grid place-items-center h-4 w-4 rounded-full bg-surface ring-1 ring-inset ring-line',
                          tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : tone === 'info' ? 'text-info' : 'text-muted'
                        )}>
                          <RoleIcon size={9} strokeWidth={2.5} />
                        </span>
                      </span>
                      <div className="min-w-0">
                        <span className="font-medium text-fg">{u.email}</span>
                        {isSelf && <span className="ml-1.5 text-2xs text-faint">(you)</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {manageable ? (
                      <Select value={u.role} onChange={e => changeRole.mutate({ id: u.id, role: e.target.value })} className="h-8 py-1 w-36">
                        {assignable.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                      </Select>
                    ) : (
                      <Badge tone={ROLE_TONE[u.role] ?? 'muted'} className="gap-1">
                        <RoleIcon size={10} />
                        {u.role.replace('_', ' ')}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {manageable ? (
                      <Button variant="danger" size="sm" onClick={async () => {
                        if (await confirmDialog({
                          title: `Deactivate ${u.email}?`,
                          message: 'The account loses console access immediately.',
                          confirmLabel: 'Deactivate', icon: ShieldOff,
                        })) deactivate.mutate(u.id);
                      }}>
                        Deactivate
                      </Button>
                    ) : (
                      <span className="text-xs text-faint">
                        {isSelf ? 'current session' : canManage ? 'higher role — locked' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function MatrixSection() {
  const { data } = useQuery({ queryKey: ['roles-matrix'], queryFn: getRoles });
  if (!data) return null;
  const held = (role: string, perm: string) => data.matrix[role]?.includes(perm);
  return (
    <Panel
      icon={Grid3x3}
      title="Permission matrix"
      subtitle="Fixed roles — super_admin holds every permission. Enforced server-side on every request."
      bodyClassName="p-0"
      className="animate-slideup overflow-hidden"
    >
      {/* Role cards — quick legend with per-role grant counts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-4 py-4 border-b border-line bg-surface-2/30">
        {data.roles.map((r, i) => {
          const RoleIcon = ROLE_ICON[r] ?? Shield;
          const count = data.matrix[r]?.length ?? 0;
          const tone = ROLE_TONE[r] ?? 'muted';
          return (
            <div
              key={r}
              className="group relative overflow-hidden rounded-xl border border-line card-grad p-3 shadow-xs ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-line-strong animate-fadein"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <Hairline className="opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center gap-2">
                <span className={cn('grid place-items-center h-7 w-7 rounded-lg ring-1 ring-inset', ROLE_CHIP[tone])}>
                  <RoleIcon size={14} />
                </span>
                <span className="text-sm font-medium text-fg capitalize truncate">{r.replace('_', ' ')}</span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold text-fg tabular-nums leading-none">{count}</span>
                <span className="text-2xs uppercase tracking-wider text-faint">of {data.permissions.length} perms</span>
              </div>
              <div className="mt-2 h-1 rounded-full bg-surface-2 overflow-hidden ring-1 ring-inset ring-line/60">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    tone === 'danger' ? 'bg-danger' : tone === 'accent' ? 'bg-accent' : tone === 'info' ? 'bg-info' : 'bg-muted'
                  )}
                  style={{ width: `${data.permissions.length ? (count / data.permissions.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="overflow-auto max-h-[28rem]">
        <table className="text-sm w-full border-collapse">
          <thead className="sticky top-0 z-20">
            <tr className="text-left border-b border-line bg-surface-2/95">
              <th className="font-semibold text-2xs uppercase tracking-wider text-faint py-2.5 px-4 sticky left-0 z-10 bg-surface-2/95">Permission</th>
              {data.roles.map(r => {
                const RoleIcon = ROLE_ICON[r] ?? Shield;
                const tone = ROLE_TONE[r] ?? 'muted';
                return (
                  <th key={r} className="font-semibold text-2xs uppercase tracking-wider text-faint py-2.5 px-3 text-center whitespace-nowrap bg-surface-2/95">
                    <span className="inline-flex items-center gap-1.5">
                      <RoleIcon size={11} className={cn(
                        tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : tone === 'info' ? 'text-info' : 'text-muted'
                      )} />
                      {r.replace('_', ' ')}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.permissions.map(p => (
              <tr key={p} className="group hover:bg-surface-2 transition-colors">
                <td className="py-2 px-4 font-mono text-xs text-muted sticky left-0 z-10 bg-surface group-hover:bg-surface-2 transition-colors group-hover:text-fg">{p}</td>
                {data.roles.map(r => (
                  <td key={r} className="py-2 px-3 text-center">
                    {held(r, p)
                      ? <span className="inline-grid place-items-center h-5 w-5 rounded-full bg-success-soft text-success ring-1 ring-inset ring-success/20 transition-transform group-hover:scale-110"><Check size={12} strokeWidth={2.5} /></span>
                      : <span className="inline-grid place-items-center h-5 w-5 select-none"><span className="h-2 w-2 rounded-full ring-1 ring-inset ring-line-strong" /></span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
