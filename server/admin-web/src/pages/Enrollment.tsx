import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  createEnrollmentToken, fetchQRPayload, EnrollmentToken,
  getEnrollmentConfig, saveEnrollmentConfig, type EnrollmentConfig,
  type ProvisioningMode,
} from '../api/enrollment';
import { Button, Panel, Field, Input, Select, PageHero, HeroStat, Badge, cn, Hairline } from '../components/ui';
import { QRCodeImage } from '../components/QRCode';
import { useCan } from '../lib/rbac';
import { toast } from '../components/toast';
import {
  QrCode, Smartphone, Sparkles, ScanLine, KeyRound, Clock, Link2,
  Server, Package, Wifi, SlidersHorizontal, Braces, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export function Enrollment() {
  const canConfig = useCan('enroll:create'); // admin + super_admin only
  const [created, setCreated] = useState<EnrollmentToken | null>(null);
  const [mode, setMode] = useState<ProvisioningMode>('device_owner');
  const create = useMutation({
    mutationFn: () => createEnrollmentToken({ one_shot: false, max_uses: 50, expires_in: '24h', provisioning_mode: mode }),
    onSuccess: t => setCreated(t)
  });

  const MODE_OPTS: { value: ProvisioningMode; label: string; hint: string }[] = [
    { value: 'device_owner', label: 'Device Owner (fully managed)', hint: 'Factory-reset device, QR at setup or adb. Full control.' },
    { value: 'work_profile', label: 'Work Profile (BYOD)', hint: 'Creates an isolated managed work profile. Scan at setup, or in-app on an existing device.' },
    { value: 'stealth', label: 'Stealth (hidden Device Owner)', hint: 'Provisions like Device Owner (full control) but the agent comes up hidden — no launcher icon, generic notification, no branding. Company-owned, disclosed devices only.' },
    { value: 'device_admin', label: 'Device Admin (legacy)', hint: 'Limited: lock/wipe/password only.' },
  ];
  const modeHint = MODE_OPTS.find(o => o.value === mode)?.hint ?? '';

  const { data: qrPayload } = useQuery({
    enabled: !!created,
    queryKey: ['qr', created?.id],
    queryFn: () => fetchQRPayload(created!.id)
  });

  return (
    <div className="space-y-6">
      {/* ---------------- Command-center hero ---------------- */}
      <PageHero
        icon={QrCode}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} /> Provisioning</>}
        title="Enroll a Device"
        subtitle="Mint a single-scan token and provision a factory-reset Android device into the fleet."
        actions={
          <div className="flex flex-col gap-1.5 min-w-[16rem]">
            <Select value={mode} onChange={e => setMode(e.target.value as ProvisioningMode)} aria-label="Provisioning mode">
              {MODE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending} className="justify-center">
              <Sparkles size={15} />
              {create.isPending ? 'Generating…' : created ? 'Generate another' : 'Generate token'}
            </Button>
            <span className="text-2xs text-muted leading-snug">{modeHint}</span>
          </div>
        }
        stats={<>
          <HeroStat icon={Clock} label="Valid for" value="24h" tone="info" />
          <HeroStat icon={ScanLine} label="Max uses" value="50" tone="accent" />
        </>}
      />

      {/* ---------------- Generated token / QR ---------------- */}
      {created ? (
        <section className="animate-slideup">
          <div className="card-grad group relative overflow-hidden rounded-2xl border border-line bg-surface shadow-xs ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-line-strong">
            <Hairline />
            <span className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />

            <div className="relative flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
              <div className="flex items-center gap-3 min-w-0">
                <span className="grid place-items-center h-7 w-7 rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15 shrink-0">
                  <KeyRound size={15} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-fg">Enrollment token issued</h2>
                  <p className="text-xs text-muted mt-0.5">
                    {mode === 'work_profile'
                      ? 'Scan at the setup wizard, or in-app (Scan QR) to create a BYOD work profile.'
                      : 'Encode the QR payload below to provision a factory-reset device.'}
                  </p>
                </div>
                <Badge tone={mode === 'work_profile' ? 'accent' : 'info'} className="hidden sm:inline-flex shrink-0">
                  {MODE_OPTS.find(o => o.value === mode)?.label}
                </Badge>
              </div>
              <Badge tone="success" className="hidden sm:inline-flex px-2.5 py-1 ring-1 ring-inset ring-success/20 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} />
                Active
              </Badge>
            </div>

            <div className="relative p-5 space-y-4">
              {/* Token + meta */}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-3">
                <TokenField icon={KeyRound} label="Token">
                  <div className="font-mono text-sm break-all text-fg">{created.token}</div>
                </TokenField>
                <TokenField icon={Clock} label="Expires">
                  <div className="text-sm text-fg whitespace-nowrap">{new Date(created.expires_at).toLocaleString()}</div>
                </TokenField>
                <TokenField icon={Link2} label="Provision URL">
                  <code className="text-xs break-all text-muted">{created.provision_url}</code>
                </TokenField>
              </div>

              {/* QR + payload */}
              {qrPayload && (
                <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 pt-1">
                  {/* Elegant QR plate */}
                  <div className="relative animate-fadein">
                    <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-b from-surface-2/70 to-surface p-4 shadow-xs ring-1 ring-inset ring-line">
                      <Hairline tone="faint" />
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="grid place-items-center h-6 w-6 rounded-md bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
                            <ScanLine size={13} />
                          </span>
                          <span className="text-2xs font-semibold uppercase tracking-wider text-faint">Scan to provision</span>
                        </div>
                        <QrCode size={14} className="text-faint" />
                      </div>
                      {/* Single white surface: QRCodeImage renders its own tile —
                          reticles overlay that real module grid (no box-in-box). */}
                      <div className="relative w-fit mx-auto">
                        {/* Corner reticles hug the QR tile (its own p-3 padding) */}
                        <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 h-3 w-3 border-l-2 border-t-2 border-accent/40 rounded-tl-sm" />
                        <span className="pointer-events-none absolute right-1.5 top-1.5 z-10 h-3 w-3 border-r-2 border-t-2 border-accent/40 rounded-tr-sm" />
                        <span className="pointer-events-none absolute left-1.5 bottom-8 z-10 h-3 w-3 border-l-2 border-b-2 border-accent/40 rounded-bl-sm" />
                        <span className="pointer-events-none absolute right-1.5 bottom-8 z-10 h-3 w-3 border-r-2 border-b-2 border-accent/40 rounded-br-sm" />
                        <QRCodeImage value={JSON.stringify(qrPayload)} size={248} />
                      </div>
                    </div>
                    <p className="text-xs text-muted mt-3 max-w-[18rem] leading-relaxed">
                      On a <strong className="text-fg">factory-reset</strong> device, tap the welcome screen six times to open the QR reader, then scan this.
                    </p>
                  </div>

                  {/* Steps + payload */}
                  <div className="min-w-0 space-y-4">
                    <div className="rounded-xl border border-line bg-surface-2/40 p-3.5 ring-1 ring-inset ring-line">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="grid place-items-center h-6 w-6 rounded-md bg-info-soft text-info ring-1 ring-inset ring-info/15">
                          <Smartphone size={13} />
                        </span>
                        <span className="text-2xs font-semibold uppercase tracking-wider text-faint">Provisioning steps</span>
                      </div>
                      <ol className="space-y-2.5">
                        <Step n={1} i={0} text="Factory-reset the target Android device." />
                        <Step n={2} i={1} text="Tap the welcome screen six times to launch the QR reader." />
                        <Step n={3} i={2} text="Scan the code — the agent downloads and self-provisions." />
                      </ol>
                    </div>

                    <div className="rounded-xl border border-line bg-surface-2/40 p-3.5 ring-1 ring-inset ring-line">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="grid place-items-center h-6 w-6 rounded-md bg-surface-3 text-muted ring-1 ring-inset ring-line">
                          <Braces size={13} />
                        </span>
                        <span className="text-2xs font-semibold uppercase tracking-wider text-faint">QR JSON payload</span>
                      </div>
                      <pre className="text-xs bg-bg border border-line rounded-lg p-3 overflow-auto max-h-72 max-w-full shadow-inner">{JSON.stringify(qrPayload, null, 2)}</pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : (
        /* Polished empty/idle state */
        <section className="animate-fadein">
          <div className="card-grad relative overflow-hidden rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-14 text-center">
            <Hairline tone="faint" />
            <span className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
            <div className="relative mx-auto mb-4 grid place-items-center h-14 w-14 rounded-2xl bg-gradient-to-br from-accent-soft to-accent/10 text-accent ring-1 ring-inset ring-accent/15 shadow-sm">
              <QrCode size={26} />
            </div>
            <div className="relative text-sm font-medium text-fg">No active token</div>
            <p className="relative text-xs text-muted mt-1 max-w-sm mx-auto">
              Generate a token to mint a fresh QR code. Each code can enroll up to 50 devices and expires after 24 hours.
            </p>
            <div className="relative mt-4 flex items-center justify-center gap-2">
              <Badge tone="info"><Clock size={11} /> 24h validity</Badge>
              <Badge tone="accent"><ScanLine size={11} /> 50 uses</Badge>
            </div>
            <div className="relative mt-5">
              <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                <Sparkles size={15} />
                {create.isPending ? 'Generating…' : 'Generate token'}
              </Button>
            </div>
          </div>
        </section>
      )}

      {canConfig && <ProvisioningConfig />}
    </div>
  );
}

const SECURITY = ['WPA', 'WEP', 'EAP', 'NONE'];

function ProvisioningConfig() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['enroll-config'], queryFn: getEnrollmentConfig });
  const [form, setForm] = useState<EnrollmentConfig | null>(null);
  useEffect(() => { if (data && !form) setForm(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (cfg: EnrollmentConfig) => saveEnrollmentConfig(cfg),
    onSuccess: (cfg) => {
      qc.setQueryData(['enroll-config'], cfg);
      qc.invalidateQueries({ queryKey: ['qr'] });
      toast.success('Provisioning config saved');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Save failed'),
  });

  const set = <K extends keyof EnrollmentConfig>(k: K, v: EnrollmentConfig[K]) =>
    setForm(f => f ? { ...f, [k]: v } : f);

  if (isLoading || !form) {
    return (
      <Panel icon={SlidersHorizontal} title="Provisioning configuration" subtitle="Drives every enrollment QR for this tenant.">
        <div className="space-y-3 animate-pulse">
          <div className="h-9 rounded-lg bg-surface-2" />
          <div className="h-9 rounded-lg bg-surface-2 w-3/4" />
          <div className="h-9 rounded-lg bg-surface-2 w-1/2" />
        </div>
      </Panel>
    );
  }

  const wifiSecured = form.wifi_security_type !== 'NONE';

  return (
    <section className="animate-slideup" style={{ animationDelay: '60ms' }}>
      <div className="card-grad group relative overflow-hidden rounded-2xl border border-line bg-surface shadow-xs ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
        <Hairline tone="faint" className="opacity-60" />

        <div className="relative flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="flex items-center gap-3 min-w-0">
            <span className="grid place-items-center h-7 w-7 rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15 shrink-0">
              <SlidersHorizontal size={15} />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg">Provisioning configuration</h2>
              <p className="text-xs text-muted mt-0.5">Drives every enrollment QR for this tenant. Editable by admins and super admins.</p>
            </div>
          </div>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(form)} className="shrink-0">
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <div className="relative p-5 space-y-5">
          {/* Server */}
          <ConfigSection icon={Server} title="Server" tone="accent" i={0}>
            <Field label="Server base URL" hint="Where enrolled devices phone home — must be reachable from the device (a LAN IP or domain, with port). 'localhost' only works on the same machine, never on a real phone.">
              <Input value={form.server_base_url} onChange={e => set('server_base_url', e.target.value)}
                     placeholder="http://192.168.1.50:8080" />
            </Field>
          </ConfigSection>

          {/* Agent APK */}
          <ConfigSection icon={Package} title="Agent APK" tone="info" i={1}>
            <Field label="APK download URL" hint="Direct HTTPS link to the agent .apk — e.g. a GitHub Release asset, or your file-service URL. Google Drive share links do NOT work. Blank ⇒ defaults to {server}/api/v1/files/agent/latest.apk.">
              <Input value={form.apk_download_url} onChange={e => set('apk_download_url', e.target.value)}
                     placeholder="https://github.com/org/repo/releases/download/v1/agent.apk" />
            </Field>
            <Field label="Signing-cert SHA-256 checksum (optional)" hint="Leave blank to skip. Note: Android still requires a checksum to install an APK it downloads during QR provisioning — skip only when the agent is preinstalled or you provision via adb. URL-safe base64 of the SHA-256 of the signing cert.">
              <Input value={form.apk_signature_checksum} onChange={e => set('apk_signature_checksum', e.target.value)}
                     className="font-mono" placeholder="(skipped)" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="DPC package name">
                <Input value={form.dpc_package_name} onChange={e => set('dpc_package_name', e.target.value)} className="font-mono" placeholder="com.mdm.agent" />
              </Field>
              <Field label="Admin component" hint="package/Receiver">
                <Input value={form.dpc_component_name} onChange={e => set('dpc_component_name', e.target.value)}
                       className="font-mono" placeholder="com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver" />
              </Field>
            </div>
          </ConfigSection>

          {/* WiFi for offline factory-reset devices */}
          <ConfigSection
            icon={Wifi}
            title="Setup WiFi"
            tone="success"
            i={2}
            description="A factory-reset device has no network. These credentials let it join WiFi during setup, before it downloads the agent. Leave SSID blank to have the operator pick a network manually."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="WiFi SSID"><Input value={form.wifi_ssid} onChange={e => set('wifi_ssid', e.target.value)} placeholder="Provisioning-WiFi" /></Field>
              <Field label="Security">
                <Select value={form.wifi_security_type} onChange={e => set('wifi_security_type', e.target.value)}>
                  {SECURITY.map(s => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="WiFi password" hint={wifiSecured ? 'Anyone who photographs the QR can read this — prefer a dedicated provisioning network.' : 'Not required for an open (NONE) network.'}>
              <Input type="text" value={form.wifi_password} onChange={e => set('wifi_password', e.target.value)}
                     disabled={!wifiSecured} placeholder={wifiSecured ? '••••••••' : '— open network —'} />
            </Field>
            <Toggle label="Hidden network" checked={form.wifi_hidden} onChange={v => set('wifi_hidden', v)} />
          </ConfigSection>

          {/* Provisioning options */}
          <ConfigSection icon={ShieldCheck} title="Options" tone="warn" i={3}>
            <Toggle label="Skip storage encryption" hint="Faster setup; most production fleets leave this off." checked={form.skip_encryption} onChange={v => set('skip_encryption', v)} />
            <Toggle label="Leave all system apps enabled" hint="Keep OEM/system apps after provisioning." checked={form.leave_system_apps} onChange={v => set('leave_system_apps', v)} />
          </ConfigSection>
        </div>
      </div>
    </section>
  );
}

/* ============================== Presentational sub-components ============================== */

function TokenField({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-3 ring-1 ring-inset ring-line/60 transition-colors hover:border-line-strong hover:bg-surface-2/60 min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-faint" />
        <span className="text-2xs font-semibold uppercase tracking-wider text-faint">{label}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Step({ n, text, i = 0 }: { n: number; text: string; i?: number }) {
  return (
    <li className="flex items-start gap-2.5 animate-fadein" style={{ animationDelay: `${i * 60}ms` }}>
      <span className="grid place-items-center h-5 w-5 shrink-0 rounded-full bg-accent/12 text-accent text-2xs font-semibold ring-1 ring-inset ring-accent/20 tabular-nums">{n}</span>
      <span className="text-xs text-muted leading-relaxed pt-0.5">{text}</span>
    </li>
  );
}

const sectionTones: Record<string, string> = {
  accent: 'text-accent bg-accent-soft ring-accent/15',
  info: 'text-info bg-info-soft ring-info/15',
  success: 'text-success bg-success-soft ring-success/15',
  warn: 'text-warn bg-warn/12 ring-warn/20',
};

function ConfigSection({ icon: Icon, title, tone, description, children, i = 0 }: {
  icon: LucideIcon; title: string; tone: 'accent' | 'info' | 'success' | 'warn'; description?: string; children: React.ReactNode; i?: number;
}) {
  return (
    <section
      className="relative rounded-xl border border-line bg-surface-2/30 p-4 ring-1 ring-inset ring-line/60 transition-colors hover:border-line-strong animate-fadein"
      style={{ animationDelay: `${i * 50}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className={cn('grid place-items-center h-6 w-6 rounded-md ring-1 ring-inset', sectionTones[tone])}>
          <Icon size={13} />
        </span>
        <span className="text-2xs font-semibold uppercase tracking-wider text-faint">{title}</span>
      </div>
      {description && <p className="text-xs text-muted mt-2 leading-relaxed">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`mt-0.5 relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-accent' : 'bg-surface-3'}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-2xs text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}
