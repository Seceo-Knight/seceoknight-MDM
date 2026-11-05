// Management-mode display helpers. The agent reports its current privilege
// level on every heartbeat as 'owner' | 'admin' | 'none'; the UI renders a live
// badge and a capability matrix so operators can see exactly what the device
// can and can't do in its current mode.

import { Gauge, ShieldCheck as ShieldCheckIcon, AlertTriangle } from 'lucide-react';
import { Hairline } from './ui';

export type MgmtMode = 'owner' | 'profile' | 'admin' | 'none' | 'stealth';

export function normalizeMode(m?: string | null): MgmtMode {
  if (m === 'owner' || m === 'admin' || m === 'stealth') return m;
  // The agent reports 'profile' on heartbeat; the device record's
  // management_mode column uses 'profile_owner'. Accept both.
  if (m === 'profile' || m === 'profile_owner') return 'profile';
  return 'none';
}

// Stealth is a Device Owner with a hidden footprint (a stealth-enrolled device) —
// identical capabilities, so for capability checks it resolves to 'owner'. Only
// the label/badge differ.
function capMode(m: MgmtMode): Exclude<MgmtMode, 'stealth'> {
  return m === 'stealth' ? 'owner' : m;
}

const MODE_LABEL: Record<MgmtMode, string> = {
  owner: 'Device Owner',
  profile: 'Work Profile',
  admin: 'Device Admin',
  none: 'Enrolled only',
  stealth: 'Stealth'
};

const MODE_TONE: Record<MgmtMode, string> = {
  owner: 'bg-success/12 text-success ring-1 ring-inset ring-success/20',
  profile: 'bg-accent/12 text-accent ring-1 ring-inset ring-accent/20',
  admin: 'bg-warn/15 text-warn ring-1 ring-inset ring-warn/25',
  none: 'bg-surface-2 text-muted ring-1 ring-inset ring-line',
  stealth: 'bg-fg/10 text-fg ring-1 ring-inset ring-fg/20'
};

const MODE_BLURB: Record<MgmtMode, string> = {
  owner: 'Full Device Owner control — every remote action and policy works, and camera/mic/location are auto-granted for headless use.',
  profile: 'BYOD Work Profile (Profile Owner) — full control over the managed work profile (apps, restrictions, clipboard/sharing isolation, work-profile policies) and the profile can be removed cleanly. Personal side and whole-device actions (factory wipe, reboot) are out of scope.',
  admin: 'Legacy Device Admin — lock, wipe and password policy work, but silent app management, restrictions, VPN/proxy and headless sensors do not.',
  none: 'Installed and enrolled with no admin/owner rights. Read-only inventory + telemetry only; sensors work only if the user grants the runtime permission. No enforcement.',
  stealth: 'Stealth-enrolled — a Device Owner with a minimised on-screen footprint (hidden launcher icon, generic notification, no agent/company branding). Same full Device-Owner capability set; the device just doesn’t advertise that it’s managed. Company-owned, disclosed devices only.'
};

export function modeLabel(m?: string | null) { return MODE_LABEL[normalizeMode(m)]; }

// --- Attestation / posture ---
export const POSTURE_THRESHOLD = 60; // mirrors server service.PostureThreshold

export function postureTone(score?: number | null): { label: string; cls: string } {
  const base = 'ring-1 ring-inset';
  if (score == null) return { label: 'Unknown', cls: `bg-surface-2 text-muted ${base} ring-line` };
  if (score >= POSTURE_THRESHOLD) return { label: 'Compliant', cls: `bg-success/12 text-success ${base} ring-success/20` };
  if (score >= 40) return { label: 'At risk', cls: `bg-warn/15 text-warn ${base} ring-warn/25` };
  return { label: 'Critical', cls: `bg-danger/12 text-danger ${base} ring-danger/20` };
}

export function PostureBadge({ score, className = '' }: { score?: number | null; className?: string }) {
  const t = postureTone(score);
  return (
    <span title={`Attestation posture ${score ?? '—'}/100 (compliant ≥ ${POSTURE_THRESHOLD})`}
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium ${t.cls} ${className}`}>
      Posture {score ?? '—'} · {t.label}
    </span>
  );
}

// PostureCard breaks down the attestation factors (what dinged the score).
export function PostureCard({ score, factors, at }: { score?: number | null; factors?: Record<string, unknown> | null; at?: string | null }) {
  const ded = (factors?.deductions as string[] | undefined) ?? [];
  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-xs">
      <Hairline tone="faint" />
      <div className="flex items-center gap-3 mb-1">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-success-soft text-success ring-1 ring-inset ring-success/15">
          <ShieldCheckIcon size={17} />
        </span>
        <h2 className="font-medium leading-tight">Attestation posture</h2>
        <PostureBadge score={score} />
      </div>
      <p className="text-xs text-muted mb-3">
        Continuously computed from device-health signals on each heartbeat. A device is the conditional-access gate's "compliant" iff score ≥ {POSTURE_THRESHOLD}. {at ? `Last attested ${new Date(at).toLocaleString()}.` : 'Not yet attested.'}
      </p>
      {score == null ? (
        <div className="text-sm text-muted">No attestation reported yet (the device hasn't heartbeated since posture was enabled).</div>
      ) : ded.length === 0 ? (
        <div className="text-sm text-success">No risk factors — full marks (100/100).</div>
      ) : (
        <ul className="text-sm space-y-1">
          {ded.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-danger">
              <span className="w-1.5 h-1.5 rounded-full bg-danger" /> {d}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Capability → modes that can perform it. Used to disable remote-action
// buttons that would just fail server-side in the device's current mode.
export type Capability =
  | 'lock' | 'reboot' | 'wipe' | 'reset_password'
  | 'app_uninstall' | 'app_manage' | 'remove_work_profile' | 'screen_mirror';

const CAP_MODES: Record<Capability, MgmtMode[]> = {
  lock:                ['admin', 'owner', 'profile'],
  wipe:                ['admin', 'owner'],          // factory reset — not a Profile Owner action
  reset_password:      ['admin', 'owner', 'profile'],
  reboot:              ['owner'],
  app_uninstall:       ['admin', 'owner', 'profile'],
  app_manage:          ['owner', 'profile'],        // hide/show, block/allow uninstall, clear data
  remove_work_profile: ['profile'],                 // only a work profile can be removed
  screen_mirror:       ['owner']                    // live screen capture — fully-managed only (stealth resolves to owner)
};

const CAP_REQ: Record<Capability, string> = {
  lock:                'Requires Device Admin, Work Profile, or Device Owner',
  wipe:                'Requires Device Admin or Device Owner (factory reset is not available on a work profile)',
  reset_password:      'Requires Device Admin, Work Profile, or Device Owner',
  reboot:              'Requires Device Owner',
  app_uninstall:       'Requires Device Admin, Work Profile, or Device Owner',
  app_manage:          'Requires Device Owner or Work Profile',
  remove_work_profile: 'Only available on a BYOD Work Profile (Profile Owner)',
  screen_mirror:       'Requires a fully-managed Device Owner enrollment'
};

export function modeAllows(mode: string | null | undefined, cap: Capability): boolean {
  return CAP_MODES[cap].includes(capMode(normalizeMode(mode)));
}

// Returns a tooltip explaining the requirement when the mode is insufficient,
// or undefined when the action is allowed.
export function modeRequirement(mode: string | null | undefined, cap: Capability): string | undefined {
  return modeAllows(mode, cap) ? undefined : CAP_REQ[cap];
}

export function ModeBadge({ mode, className = '' }: { mode?: string | null; className?: string }) {
  const k = normalizeMode(mode);
  return (
    <span title={MODE_BLURB[k]}
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium ${MODE_TONE[k]} ${className}`}>
      {MODE_LABEL[k]}
    </span>
  );
}

// Per-capability support across the three modes.
//   yes    — works headlessly / fully
//   manual — works only if the user has granted the runtime permission on-device
//   prompt — works but the user is prompted on-device (no silent action)
//   no     — unavailable in this mode
type Support = 'yes' | 'manual' | 'prompt' | 'no';

interface CapRow { label: string; none: Support; admin: Support; profile: Support; owner: Support }

const CAPS: CapRow[] = [
  { label: 'Heartbeat, network/storage/battery telemetry', none: 'yes', admin: 'yes', profile: 'yes', owner: 'yes' },
  { label: 'App inventory listing', none: 'yes', admin: 'yes', profile: 'yes', owner: 'yes' },
  { label: 'Foreground-app activity log', none: 'manual', admin: 'manual', profile: 'manual', owner: 'manual' },
  { label: 'Location / Camera photo / Mic audio', none: 'manual', admin: 'manual', profile: 'yes', owner: 'yes' },
  { label: 'Lock screen', none: 'no', admin: 'yes', profile: 'yes', owner: 'yes' },
  { label: 'Factory wipe', none: 'no', admin: 'yes', profile: 'no', owner: 'yes' },
  { label: 'Password policy / reset', none: 'no', admin: 'prompt', profile: 'yes', owner: 'yes' },
  { label: 'Disable camera / screenshots (policy)', none: 'no', admin: 'yes', profile: 'yes', owner: 'yes' },
  { label: 'Reboot device', none: 'no', admin: 'no', profile: 'no', owner: 'yes' },
  { label: 'Install / uninstall apps', none: 'no', admin: 'prompt', profile: 'yes', owner: 'yes' },
  { label: 'Hide / show app, block uninstall', none: 'no', admin: 'no', profile: 'yes', owner: 'yes' },
  { label: 'User restrictions, clipboard isolation, CA certs', none: 'no', admin: 'no', profile: 'yes', owner: 'yes' },
  { label: 'Clear other apps’ data', none: 'no', admin: 'no', profile: 'yes', owner: 'yes' },
  { label: 'Remove work profile (no factory reset)', none: 'no', admin: 'no', profile: 'yes', owner: 'no' }
];

const CELL: Record<Support, { txt: string; cls: string }> = {
  yes:    { txt: '✓',       cls: 'text-success' },
  manual: { txt: 'if granted', cls: 'text-warn text-[10px]' },
  prompt: { txt: 'prompts',  cls: 'text-warn text-[10px]' },
  no:     { txt: '—',        cls: 'text-faint' }
};

export function ModeCapabilityCard({ mode }: { mode?: string | null }) {
  const k = normalizeMode(mode);
  const colCls = (m: MgmtMode) =>
    m === k ? 'bg-accent/8 font-medium' : '';
  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-xs">
      <Hairline tone="faint" />
      <div className="flex items-center gap-3 mb-1">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
          <Gauge size={17} />
        </span>
        <h2 className="font-medium leading-tight">Management mode</h2>
        <ModeBadge mode={mode} />
      </div>
      <p className="text-xs text-muted mb-3">{MODE_BLURB[k]}</p>
      {(k === 'none' || k === 'admin') && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span>
            {k === 'none'
              ? 'To enable enforcement, promote the agent to Device Admin (Settings → Security → Device admin apps) or, for full control, Device Owner.'
              : 'For silent app management, restrictions, VPN/proxy and headless camera/mic, provision as Device Owner (adb dpm set-device-owner on a freshly reset device, or QR enrollment).'}
            {' '}This updates here automatically within a heartbeat once changed.
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="text-left">
            <tr className="text-2xs font-semibold uppercase tracking-wider text-faint">
              <th className="py-1.5 font-semibold">Capability</th>
              <th className={`py-1.5 px-2 text-center font-semibold ${colCls('none')}`}>Enrolled</th>
              <th className={`py-1.5 px-2 text-center font-semibold ${colCls('admin')}`}>Admin</th>
              <th className={`py-1.5 px-2 text-center font-semibold ${colCls('profile')}`}>Work profile</th>
              <th className={`py-1.5 px-2 text-center font-semibold ${colCls('owner')}`}>Owner</th>
            </tr>
          </thead>
          <tbody>
            {CAPS.map(r => (
              <tr key={r.label} className="border-t border-line">
                <td className="py-1.5 pr-2">{r.label}</td>
                {(['none', 'admin', 'profile', 'owner'] as const).map(m => {
                  const c = CELL[r[m]];
                  return <td key={m} className={`py-1.5 px-2 text-center ${colCls(m)}`}><span className={c.cls}>{c.txt}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
