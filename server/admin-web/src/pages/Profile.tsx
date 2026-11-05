import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { changePassword, updateEmail, mfaStatus, setupMFA, confirmMFA, disableMFA, regenerateBackupCodes } from '../api/auth';
import { useAuth } from '../stores/authStore';
import { toast } from '../components/toast';
import { Panel, Field, Input, Button, Badge, PageHero, cn, Hairline } from '../components/ui';
import { UserCircle, ShieldCheck, Building2, Mail, KeyRound, Moon, Sun, LogOut, Check, Lock, Sparkles, ListChecks, ScrollText, QrCode, RefreshCcw, ShieldOff, Copy, Eye, EyeOff } from 'lucide-react';

// ----- MFA panel -------------------------------------------------------

type MFAStep = 'idle' | 'setup' | 'confirm' | 'enabled' | 'regen';

function MFAPanel() {
  const qc = useQueryClient();
  const [step, setStep] = useState<MFAStep>('idle');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: mfaStatus,
  });

  // Reset local state when mfa status changes
  useEffect(() => {
    if (status?.enabled) setStep('enabled');
    else if (step === 'enabled') setStep('idle');
  }, [status?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSetup = useMutation({
    mutationFn: setupMFA,
    onSuccess: (r) => { setQrCode(r.qr_code); setSecret(r.secret); setStep('setup'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Setup failed'),
  });

  const doConfirm = useMutation({
    mutationFn: () => confirmMFA(confirmCode),
    onSuccess: (r) => {
      setBackupCodes(r.codes);
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      setStep('enabled');
      toast.success('MFA enabled — save your backup codes!');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Verification failed'),
  });

  const doDisable = useMutation({
    mutationFn: () => disableMFA(disableCode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      setStep('idle'); setDisableCode(''); setShowDisable(false);
      toast.success('MFA disabled');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Disable failed'),
  });

  const doRegen = useMutation({
    mutationFn: () => regenerateBackupCodes(regenCode),
    onSuccess: (r) => { setBackupCodes(r.codes); setRegenCode(''); setStep('enabled'); toast.success('Backup codes regenerated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Regenerate failed'),
  });

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'));
    toast.success('Backup codes copied');
  };

  if (isLoading) return null;

  return (
    <Panel
      icon={QrCode}
      title="Two-factor authentication"
      subtitle={status?.enabled
        ? 'Your account is protected with TOTP-based MFA.'
        : 'Add an extra layer of security to your account.'}
      className="card-grad group relative overflow-hidden ring-1 ring-inset ring-line"
    >
      <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      {/* ---- IDLE: not enabled ---- */}
      {!status?.enabled && step === 'idle' && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-muted">
            <ShieldOff size={15} className="text-faint shrink-0" />
            MFA is currently disabled. Enable it to require a 6-digit code on sign-in.
          </div>
          <Button variant="primary" size="sm" onClick={() => doSetup.mutate()} disabled={doSetup.isPending}>
            {doSetup.isPending ? 'Generating…' : <><QrCode size={14} /> Enable MFA</>}
          </Button>
        </div>
      )}

      {/* ---- SETUP: show QR code ---- */}
      {step === 'setup' && (
        <div className="space-y-5">
          <p className="text-sm text-muted">
            Scan this QR code with <strong className="text-fg">Google Authenticator</strong>, Authy, or any TOTP app.
          </p>
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-xl bg-white p-3 ring-1 ring-line inline-block">
              <img src={qrCode} alt="TOTP QR code" className="w-48 h-48" />
            </div>
            <div className="w-full">
              <div className="text-2xs font-medium uppercase tracking-wider text-faint mb-1.5">Or enter manually</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-xs font-mono text-fg tracking-wider break-all">
                  {showSecret ? secret : '•'.repeat(secret.length)}
                </code>
                <button type="button" onClick={() => setShowSecret(v => !v)}
                        className="grid place-items-center w-8 h-8 rounded-lg bg-surface-2 text-muted hover:text-fg transition-colors ring-1 ring-line">
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button type="button" onClick={() => { navigator.clipboard.writeText(secret); toast.success('Secret copied'); }}
                        className="grid place-items-center w-8 h-8 rounded-lg bg-surface-2 text-muted hover:text-fg transition-colors ring-1 ring-line">
                  <Copy size={14} />
                </button>
              </div>
            </div>
          </div>
          <Field label="Verify — enter the 6-digit code from your app">
            <div className="flex gap-2">
              <Input
                type="text" inputMode="numeric" autoComplete="one-time-code"
                value={confirmCode} onChange={e => setConfirmCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000" maxLength={6}
                className="text-center tracking-[0.3em] font-mono"
              />
              <Button variant="primary" onClick={() => doConfirm.mutate()}
                      disabled={confirmCode.length !== 6 || doConfirm.isPending}>
                {doConfirm.isPending ? 'Verifying…' : <><Check size={15} /> Verify & enable</>}
              </Button>
            </div>
          </Field>
          <button type="button" onClick={() => setStep('idle')} className="text-xs text-faint hover:text-muted transition-colors">
            Cancel
          </button>
        </div>
      )}

      {/* ---- ENABLED: show status + backup codes + controls ---- */}
      {status?.enabled && step === 'enabled' && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck size={15} className="text-success shrink-0" />
            <span className="text-fg font-medium">MFA is active.</span>
            <span className="text-muted">You need your authenticator app on every sign-in.</span>
          </div>

          {/* Backup codes — only shown after first enable or regen */}
          {backupCodes.length > 0 && (
            <div className="rounded-xl bg-surface-2/50 ring-1 ring-inset ring-warn/30 p-4 space-y-3 animate-fadein">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-warn uppercase tracking-wider">Backup codes — save these now</div>
                <button type="button" onClick={copyBackupCodes}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-fg transition-colors">
                  <Copy size={12} /> Copy all
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {backupCodes.map(c => (
                  <code key={c} className="rounded-lg bg-surface/80 px-3 py-1.5 text-xs font-mono text-fg text-center tracking-widest ring-1 ring-line">
                    {c}
                  </code>
                ))}
              </div>
              <p className="text-2xs text-faint">
                Each code can only be used once. Store them in a password manager or printed sheet.
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setStep('regen'); setRegenCode(''); }}>
              <RefreshCcw size={13} /> Regenerate backup codes
            </Button>
            <Button variant="danger" size="sm" onClick={() => setShowDisable(v => !v)}>
              <ShieldOff size={13} /> Disable MFA
            </Button>
          </div>

          {/* Inline disable confirmation */}
          {showDisable && (
            <div className="rounded-xl bg-danger/5 ring-1 ring-inset ring-danger/20 p-4 space-y-3 animate-fadein">
              <p className="text-sm text-fg">Enter a TOTP code (or backup code) to confirm.</p>
              <div className="flex gap-2">
                <Input type="text" inputMode="numeric"
                       value={disableCode} onChange={e => setDisableCode(e.target.value.replace(/\s/g, ''))}
                       placeholder="000000 or BACKUP" className="font-mono tracking-wider" />
                <Button variant="danger" onClick={() => doDisable.mutate()}
                        disabled={disableCode.length < 6 || doDisable.isPending}>
                  {doDisable.isPending ? 'Disabling…' : 'Confirm'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- REGEN: regenerate backup codes ---- */}
      {step === 'regen' && (
        <div className="space-y-4 animate-fadein">
          <p className="text-sm text-muted">Enter your current TOTP code to generate new backup codes. All existing codes will be invalidated.</p>
          <Field label="TOTP code (6 digits)">
            <div className="flex gap-2">
              <Input type="text" inputMode="numeric"
                     value={regenCode} onChange={e => setRegenCode(e.target.value.replace(/\D/g, ''))}
                     placeholder="000000" maxLength={6} className="font-mono tracking-[0.3em] text-center" />
              <Button variant="primary" onClick={() => doRegen.mutate()}
                      disabled={regenCode.length !== 6 || doRegen.isPending}>
                {doRegen.isPending ? 'Generating…' : <><RefreshCcw size={14} /> Generate</>}
              </Button>
            </div>
          </Field>
          <button type="button" onClick={() => setStep('enabled')} className="text-xs text-faint hover:text-muted transition-colors">
            Cancel
          </button>
        </div>
      )}
    </Panel>
  );
}

// -----------------------------------------------------------------------

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

      {/* ---------------- MFA ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '360ms' }}>
        <MFAPanel />
      </div>

      {/* ---------------- Preferences ---------------- */}
      <div className="animate-slideup" style={{ animationDelay: '420ms' }}>
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
