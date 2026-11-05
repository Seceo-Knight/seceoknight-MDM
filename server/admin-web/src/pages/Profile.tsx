import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { changePassword, updateEmail } from '../api/auth';
import { useAuth } from '../stores/authStore';
import { toast } from '../components/toast';
import { Panel, Field, Input, Button, Badge, PageHero, cn, Hairline } from '../components/ui';
import { UserCircle, ShieldCheck, Building2, Mail, KeyRound, Moon, Sun, LogOut, Check, Lock, Sparkles, ListChecks, ScrollText } from 'lucide-react';

export function Profile() {
  const { user, setUser, dark, toggleDark, logout } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState(user?.email ?? '');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  const saveEmail = useMutation({
    mutationFn: () => updateEmail(email.trim()),
    onSuccess: (u) => { setUser(u); toast.success('Email updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });

  const savePw = useMutation({
    mutationFn: () => changePassword(oldPw, newPw),
    onSuccess: () => {
      setOldPw(''); setNewPw(''); setConfirmPw('');
      toast.success('Password changed');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Change failed')
  });

  const pwMismatch = newPw.length > 0 && confirmPw.length > 0 && newPw !== confirmPw;
  const canSavePw = oldPw.length > 0 && newPw.length >= 8 && newPw === confirmPw;

  const roleLabel = user?.role?.replace('_', ' ') ?? '—';
  const permCount = user?.permissions?.length ?? 0;

  // Lightweight strength read-out for the new-password field (presentational only).
  const pwScore = scorePassword(newPw);

  return (
    <div className="max-w-2xl space-y-5">
      <PageHero
        icon={UserCircle}
        eyebrow={<><UserCircle size={13} className="text-accent" /> Account</>}
        title="Your profile"
        subtitle={user?.email ?? '—'}
        stats={<>
          <Badge tone="accent" dot>{roleLabel}</Badge>
          {permCount > 0 && (
            <Badge tone="info">
              <Sparkles size={11} /> {permCount} permission{permCount === 1 ? '' : 's'}
            </Badge>
          )}
        </>}
      />

      {/* Identity facts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FactTile delay={0} icon={<ShieldCheck size={15} />} label="Role" value={roleLabel} />
        <FactTile
          delay={60}
          icon={<Building2 size={15} />}
          label="Tenant"
          value={<span className="font-mono text-xs">{user?.tenant_id ?? '—'}</span>}
          title={user?.tenant_id ?? ''}
        />
        <FactTile
          delay={120}
          icon={<ListChecks size={15} />}
          label="Permissions"
          value={<span className="tabular-nums">{permCount} granted</span>}
        />
      </div>

      {/* ---------------- Access / permissions ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '180ms' }}>
        <Panel
          icon={ScrollText}
          title="Access scope"
          subtitle={`Capabilities granted to your ${roleLabel} role.`}
          className="card-grad group relative overflow-hidden ring-1 ring-inset ring-line"
        >
          <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
          {permCount > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {user!.permissions!.map(perm => (
                <span
                  key={perm}
                  className="inline-flex items-center gap-1.5 rounded-full bg-surface-2/60 ring-1 ring-inset ring-line px-2.5 py-1 text-2xs font-medium text-muted transition-colors hover:text-fg hover:ring-line-strong"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
                  <span className="font-mono">{perm}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2.5 text-xs text-faint">
              <ShieldCheck size={14} className="text-faint" />
              No explicit permissions are attached to this account.
            </div>
          )}
        </Panel>
      </div>

      {/* ---------------- Email ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '240ms' }}>
        <Panel
          icon={Mail}
          title="Email address"
          subtitle="Used for sign-in and console notifications."
          className="card-grad group relative overflow-hidden ring-1 ring-inset ring-line"
        >
          <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
          <div className="flex gap-2">
            <Input value={email} onChange={e => setEmail(e.target.value)} type="email" className="flex-1" />
            <Button variant="primary"
              disabled={!email.trim() || email.trim() === user?.email || saveEmail.isPending}
              onClick={() => saveEmail.mutate()}>
              {saveEmail.isPending ? 'Saving…' : (<><Check size={15} /> Save</>)}
            </Button>
          </div>
        </Panel>
      </div>

      {/* ---------------- Password ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '300ms' }}>
        <Panel
          icon={KeyRound}
          title="Change password"
          subtitle="Rotate your credentials. Minimum 8 characters."
          className="card-grad group relative overflow-hidden ring-1 ring-inset ring-line"
        >
          <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
          <div className="space-y-4">
            <Field label="Current password">
              <Input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder="••••••••" />
            </Field>

            <div className="space-y-2.5">
              <Field label="New password" hint="At least 8 characters.">
                <Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="••••••••" />
              </Field>

              {/* Strength meter — purely visual feedback on the typed value */}
              {newPw.length > 0 && (
                <div className="flex items-center gap-3 rounded-lg bg-surface-2/50 ring-1 ring-inset ring-line px-3 py-2 animate-fadein">
                  <div className="flex-1 flex gap-1.5">
                    {[0, 1, 2, 3].map(i => (
                      <span key={i} className={cn(
                        'h-1.5 flex-1 rounded-full transition-colors duration-300',
                        i < pwScore.bars ? pwScore.cls : 'bg-line'
                      )} />
                    ))}
                  </div>
                  <span className={cn('flex items-center gap-1 text-2xs font-semibold tabular-nums w-16 justify-end', pwScore.text)}>
                    {pwScore.bars >= 4 && <ShieldCheck size={12} />}
                    {pwScore.label}
                  </span>
                </div>
              )}
            </div>

            <Field label="Confirm new password">
              <Input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="••••••••" />
            </Field>

            {pwMismatch && (
              <div className="text-xs text-danger bg-danger/10 ring-1 ring-inset ring-danger/20 rounded-lg px-3 py-2">Passwords don't match.</div>
            )}
            {newPw.length > 0 && newPw.length < 8 && (
              <div className="text-xs text-warn bg-warn/10 ring-1 ring-inset ring-warn/25 rounded-lg px-3 py-2">New password must be at least 8 characters.</div>
            )}

            <Button variant="primary" disabled={!canSavePw || savePw.isPending} onClick={() => savePw.mutate()}>
              {savePw.isPending ? 'Saving…' : (<><Lock size={15} /> Change password</>)}
            </Button>
          </div>
        </Panel>
      </div>

      {/* ---------------- Preferences ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '360ms' }}>
        <Panel
          icon={Sparkles}
          title="Preferences"
          subtitle="Appearance and session controls."
          bodyClassName="p-2"
        >
        <div className="space-y-1.5">
          <PrefRow
            icon={dark ? <Moon size={16} /> : <Sun size={16} />}
            title="Theme"
            desc={dark ? 'Currently using dark mode.' : 'Currently using light mode.'}
            action={
              <Button variant="secondary" size="sm" onClick={toggleDark}>
                {dark ? <><Sun size={14} /> Switch to light</> : <><Moon size={14} /> Switch to dark</>}
              </Button>
            }
          />
          <PrefRow
            icon={<LogOut size={16} />}
            tone="danger"
            title="Session"
            desc="Sign out of the admin console on this device."
            action={
              <Button variant="danger" size="sm" onClick={() => { logout(); navigate('/login'); }}>
                <LogOut size={14} /> Sign out
              </Button>
            }
          />
        </div>
        </Panel>
      </div>
    </div>
  );
}

/* ---------------- Presentational sub-components ---------------- */

function FactTile({ icon, label, value, title, delay = 0 }: { icon: React.ReactNode; label: string; value: React.ReactNode; title?: string; delay?: number }) {
  return (
    <div
      className="card-grad group/fact relative flex items-center gap-3 overflow-hidden rounded-xl ring-1 ring-inset ring-line bg-surface-2/40 px-3.5 py-3 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md animate-slideup"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Hairline className="opacity-0 transition-opacity duration-200 group-hover/fact:opacity-100" />
      <span className="grid place-items-center w-9 h-9 rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 shrink-0 transition-colors group-hover/fact:bg-accent/15">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
        <div className="text-sm font-medium text-fg truncate capitalize" title={title}>{value}</div>
      </div>
    </div>
  );
}

function PrefRow({ icon, title, desc, action, tone }: {
  icon: React.ReactNode; title: string; desc: string; action: React.ReactNode; tone?: 'danger';
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-surface-2">
      <div className="flex items-center gap-3 min-w-0">
        <span className={cn(
          'grid place-items-center w-9 h-9 rounded-lg ring-1 ring-inset shrink-0',
          tone === 'danger' ? 'bg-danger/10 text-danger ring-danger/20' : 'bg-surface-2 text-muted ring-line'
        )}>
          {icon}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">{title}</div>
          <div className="text-xs text-muted">{desc}</div>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function scorePassword(pw: string): { bars: number; label: string; cls: string; text: string } {
  if (!pw) return { bars: 0, label: '', cls: 'bg-line', text: 'text-faint' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  if (s <= 1) return { bars: 1, label: 'Weak', cls: 'bg-danger', text: 'text-danger' };
  if (s === 2) return { bars: 2, label: 'Fair', cls: 'bg-warn', text: 'text-warn' };
  if (s === 3) return { bars: 3, label: 'Good', cls: 'bg-info', text: 'text-info' };
  return { bars: 4, label: 'Strong', cls: 'bg-success', text: 'text-success' };
}
