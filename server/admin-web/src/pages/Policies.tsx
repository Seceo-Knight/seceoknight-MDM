import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignPolicy, deletePolicy, listAssignmentsFor, listPolicies, savePolicy, type Policy
} from '../api/policies';
import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Select, Badge, Skeleton, cn, PageHero, HeroStat, SectionHeading, Input, Textarea, Hairline, Modal, ModalBody } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import {
  Shield as ShieldIcon, ShieldCheck, Plus, Ban, Globe, Camera,
  Lock, ScrollText, Layers, Eye, Pencil, Send, Trash2, X, Sparkles,
  FileJson, KeyRound, Clock, type LucideIcon
} from 'lucide-react';

// The Android agent (PolicySpec.kt) decodes with ignoreUnknownKeys=true, so any
// field placed at the wrong nesting level is silently dropped. We learned this
// the hard way: a hand-written policy with top-level url_blocklist looked like
// it saved fine, but the device never blocked anything because the agent's
// AppPolicy expects apps.url_blocklist. The structured editor below builds the
// JSON in the canonical shape so users can't put things in the wrong place.

const RESTRICTIONS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'disable_camera', label: 'Disable camera' },
  { key: 'disable_screen_capture', label: 'Disable screen capture' },
  { key: 'disable_usb_file_transfer', label: 'Disable USB file transfer' },
  { key: 'disable_bluetooth', label: 'Disable Bluetooth' },
  { key: 'disable_nfc', label: 'Disable NFC' },
  { key: 'disable_hotspot', label: 'Disable Wi-Fi hotspot' },
  { key: 'disable_location', label: 'Disable location' },
  { key: 'disable_unknown_sources', label: 'Block installs from unknown sources' },
  { key: 'disable_accessibility', label: 'Disable accessibility services' },
  { key: 'disable_factory_reset', label: 'Block factory reset' },
  { key: 'disable_safe_boot', label: 'Block safe boot' },
  { key: 'disable_add_user', label: 'Block adding users' }
];

const TEMPLATES: Array<{ label: string; spec: Record<string, unknown> }> = [
  {
    label: 'Disable camera + 4-digit PIN',
    spec: {
      restrictions: { disable_camera: true },
      password: { complexity: 65536, minimum_length: 4 }
    }
  },
  {
    label: 'Lockdown (no camera, no USB, no unknown sources)',
    spec: {
      restrictions: {
        disable_camera: true, disable_usb_file_transfer: true,
        disable_unknown_sources: true, disable_screen_capture: true
      }
    }
  },
  {
    label: 'Block YouTube (app + Chrome URLs)',
    spec: {
      apps: {
        blocklist: [
          'com.google.android.youtube',
          'com.google.android.apps.youtube.kids',
          'com.google.android.apps.youtube.music'
        ],
        url_blocklist: [
          'youtube.com', '*.youtube.com', 'youtu.be', '*.googlevideo.com'
        ]
      }
    }
  },
  {
    label: 'Block social media (Instagram, FB, X, TikTok)',
    spec: {
      apps: {
        blocklist: [
          'com.instagram.android', 'com.facebook.katana', 'com.facebook.lite',
          'com.twitter.android', 'com.zhiliaoapp.musically'
        ],
        url_blocklist: [
          '*.instagram.com', 'instagram.com',
          '*.facebook.com', 'facebook.com',
          '*.twitter.com', 'twitter.com', '*.x.com', 'x.com',
          '*.tiktok.com', 'tiktok.com'
        ]
      }
    }
  },
  { label: 'Capture front photo on every unlock', spec: { security: { capture_on_unlock: true } } },
  {
    label: 'Compliance baseline',
    spec: { compliance: { require_encryption: true, block_rooted: true } }
  }
];

// Work-profile (BYOD / Profile Owner) toggles. Mirrors spec.WorkProfilePolicy
// booleans. Only enforced on a Profile-Owner device; ignored elsewhere.
const WORK_PROFILE_TOGGLES: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'disable_screenshot', label: 'Block screenshots' },
  { key: 'clipboard_isolation', label: 'Clipboard isolation (no cross-profile copy/paste)' },
  { key: 'block_external_sharing', label: 'Block sharing into the work profile' },
  { key: 'block_app_install', label: 'Block app installs' },
  { key: 'block_uninstall', label: 'Block app uninstalls' },
  { key: 'block_profile_removal', label: 'Block the user removing the profile' },
  { key: 'separate_work_challenge', label: 'Require a separate work challenge (lock)' },
  { key: 'disable_cross_profile_contacts', label: 'Hide work contacts from personal search' },
  { key: 'disable_cross_profile_caller_id', label: 'Hide work caller-ID on personal side' },
  { key: 'disable_cross_profile_calendar', label: 'Block cross-profile calendar' },
  { key: 'suspend_on_noncompliant', label: 'Auto-suspend work apps when non-compliant' },
];

interface FormState {
  restrictions: Record<string, boolean>;
  appBlocklist: string;           // one package per line
  urlBlocklist: string;           // one pattern per line
  captureOnUnlock: boolean;
  workProfile: Record<string, boolean>; // BYOD work-profile toggles
  workSuspended: string;          // suspended_packages, one per line
  workMaxTimeOff: string;         // max_time_off_minutes (blank = unset)
  advancedJson: string;           // any fields the form doesn't cover
}

// Decompose a spec into form fields, peeling off whatever the structured UI
// represents and leaving the rest as advanced JSON. Round-trips losslessly:
// build(decompose(s)) ≅ s for any valid s.
function decompose(spec: Record<string, unknown>): FormState {
  const s: any = { ...spec };
  const restrictionsObj = (s.restrictions ?? {}) as Record<string, boolean>;
  const restrictions: Record<string, boolean> = {};
  for (const r of RESTRICTIONS) {
    if (restrictionsObj[r.key] === true) restrictions[r.key] = true;
  }
  delete s.restrictions;

  const apps: any = { ...(s.apps ?? {}) };
  const appBlocklist = Array.isArray(apps.blocklist) ? (apps.blocklist as string[]).join('\n') : '';
  const urlBlocklist = Array.isArray(apps.url_blocklist) ? (apps.url_blocklist as string[]).join('\n') : '';
  delete apps.blocklist;
  delete apps.url_blocklist;
  if (Object.keys(apps).length > 0) s.apps = apps; else delete s.apps;

  const security: any = { ...(s.security ?? {}) };
  const captureOnUnlock = security.capture_on_unlock === true;
  delete security.capture_on_unlock;
  if (Object.keys(security).length > 0) s.security = security; else delete s.security;

  const wp: any = { ...(s.work_profile ?? {}) };
  const workProfile: Record<string, boolean> = {};
  for (const t of WORK_PROFILE_TOGGLES) {
    if (wp[t.key] === true) workProfile[t.key] = true;
    delete wp[t.key];
  }
  const workSuspended = Array.isArray(wp.suspended_packages) ? (wp.suspended_packages as string[]).join('\n') : '';
  delete wp.suspended_packages;
  const workMaxTimeOff = typeof wp.max_time_off_minutes === 'number' ? String(wp.max_time_off_minutes) : '';
  delete wp.max_time_off_minutes;
  if (Object.keys(wp).length > 0) s.work_profile = wp; else delete s.work_profile;

  return {
    restrictions,
    appBlocklist,
    urlBlocklist,
    captureOnUnlock,
    workProfile,
    workSuspended,
    workMaxTimeOff,
    advancedJson: JSON.stringify(s, null, 2)
  };
}

function build(form: FormState): { ok: true; spec: Record<string, unknown> } | { ok: false; err: string } {
  let extras: Record<string, unknown> = {};
  const adv = form.advancedJson.trim();
  if (adv && adv !== '{}') {
    try {
      const parsed = JSON.parse(adv);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, err: 'Advanced JSON must be a JSON object.' };
      }
      extras = parsed;
    } catch (e: any) {
      return { ok: false, err: `Advanced JSON is invalid: ${e?.message ?? e}` };
    }
  }
  // Top-level legacy fields people sometimes hand-write — auto-nest them so
  // the agent actually sees them.
  if (Array.isArray((extras as any).url_blocklist) || Array.isArray((extras as any).blocklist)) {
    const a: any = { ...((extras as any).apps ?? {}) };
    if ((extras as any).url_blocklist) { a.url_blocklist = (extras as any).url_blocklist; delete (extras as any).url_blocklist; }
    if ((extras as any).blocklist) { a.blocklist = (extras as any).blocklist; delete (extras as any).blocklist; }
    (extras as any).apps = a;
  }

  const spec: Record<string, unknown> = { ...extras };

  const enabledRestrictions = Object.entries(form.restrictions)
    .filter(([, v]) => v).reduce((acc, [k]) => { acc[k] = true; return acc; }, {} as Record<string, boolean>);
  if (Object.keys(enabledRestrictions).length > 0) {
    spec.restrictions = { ...(spec.restrictions as object ?? {}), ...enabledRestrictions };
  }

  const apps: any = { ...((spec.apps as object) ?? {}) };
  const appList = form.appBlocklist.split('\n').map(s => s.trim()).filter(Boolean);
  const urlList = form.urlBlocklist.split('\n').map(s => s.trim()).filter(Boolean);
  if (appList.length) apps.blocklist = appList;
  if (urlList.length) apps.url_blocklist = urlList;
  if (Object.keys(apps).length > 0) spec.apps = apps;

  if (form.captureOnUnlock) {
    spec.security = { ...((spec.security as object) ?? {}), capture_on_unlock: true };
  }

  // Work profile: emit a full block (explicit true/false per toggle, so the
  // agent authoritatively enforces/clears) only when the section is in use.
  const suspended = form.workSuspended.split('\n').map(s => s.trim()).filter(Boolean);
  const maxOffRaw = form.workMaxTimeOff.trim();
  const maxOff = maxOffRaw === '' ? null : Number(maxOffRaw);
  if (maxOff != null && (!Number.isFinite(maxOff) || maxOff < 0)) {
    return { ok: false, err: 'Work profile: max time off must be a non-negative number of minutes.' };
  }
  const anyToggle = WORK_PROFILE_TOGGLES.some(t => form.workProfile[t.key]);
  if (anyToggle || suspended.length || maxOff != null) {
    const wp: Record<string, unknown> = { ...((spec.work_profile as object) ?? {}) };
    for (const t of WORK_PROFILE_TOGGLES) wp[t.key] = !!form.workProfile[t.key];
    if (suspended.length) wp.suspended_packages = suspended;
    if (maxOff != null) wp.max_time_off_minutes = maxOff;
    spec.work_profile = wp;
  }

  return { ok: true, spec };
}

/* ============================== Presentation helpers ============================== */

// Read-only, presentation-only inspection of a policy spec to surface at-a-glance
// chips on each card. Mirrors decompose() but never mutates and is purely visual.
interface SpecGlance {
  restrictions: number;
  apps: number;
  urls: number;
  captureOnUnlock: boolean;
  hasPassword: boolean;
  hasCompliance: boolean;
  empty: boolean;
}

function glance(spec: Record<string, unknown>): SpecGlance {
  const s: any = spec ?? {};
  const restrictions = s.restrictions && typeof s.restrictions === 'object'
    ? Object.values(s.restrictions).filter(Boolean).length : 0;
  const apps = Array.isArray(s.apps?.blocklist) ? s.apps.blocklist.length : 0;
  const urls = Array.isArray(s.apps?.url_blocklist) ? s.apps.url_blocklist.length : 0;
  const captureOnUnlock = s.security?.capture_on_unlock === true;
  const hasPassword = !!s.password && typeof s.password === 'object';
  const hasCompliance = !!s.compliance && typeof s.compliance === 'object';
  const empty = restrictions + apps + urls === 0 && !captureOnUnlock && !hasPassword && !hasCompliance;
  return { restrictions, apps, urls, captureOnUnlock, hasPassword, hasCompliance, empty };
}

// Small soft chip used inside policy cards to advertise what a spec enforces.
function SpecChip({ icon: Icon, label, tone = 'muted' }: {
  icon: LucideIcon; label: React.ReactNode; tone?: 'accent' | 'danger' | 'warn' | 'info' | 'success' | 'muted';
}) {
  return (
    <Badge tone={tone} className="gap-1">
      <Icon size={11} strokeWidth={2.2} />
      {label}
    </Badge>
  );
}

function SectionLabel({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-2">
      <span className="grid place-items-center h-5 w-5 rounded-md bg-accent/10 text-accent ring-1 ring-inset ring-accent/15">
        <Icon size={12} />
      </span>
      {children}
    </div>
  );
}

export function Policies() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const [editor, setEditor] = useState<{ id?: string; name: string; form: FormState } | null>(null);
  const [view, setView] = useState<Policy | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!editor) throw new Error('no editor');
      if (!editor.name.trim()) throw new Error('Policy name is required.');
      const built = build(editor.form);
      if (!built.ok) throw new Error(built.err);
      return savePolicy({ id: editor.id, name: editor.name.trim(), spec: built.spec });
    },
    onMutate: () => setSaveErr(null),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['policies'] }); setEditor(null); },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? e?.message ?? String(e);
      setSaveErr(msg);
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePolicy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });
  const assignTenant = useMutation({
    mutationFn: (id: string) => assignPolicy(id, 'tenant'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });

  function openNew(name = '', spec: Record<string, unknown> = {}) {
    setSaveErr(null);
    setEditor({ name, form: decompose(spec) });
  }

  const policies = data ?? [];
  const totalRestrictions = policies.reduce((n, p) => n + glance(p.spec).restrictions, 0);
  const withBlocklists = policies.filter(p => { const g = glance(p.spec); return g.apps + g.urls > 0; }).length;

  return (
    <div className="space-y-5">
      <PageHero
        icon={ShieldCheck}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" style={{ animation: 'onlinePulse 2s infinite' }} /> Enforcement profiles</>}
        title="Policies"
        subtitle="Configuration profiles enforced on devices, groups or the whole tenant."
        actions={<>
          <Select
            onChange={e => {
              const t = TEMPLATES[+e.target.value];
              if (t) openNew(t.label, t.spec);
              e.currentTarget.value = '';
            }}
            className="h-9 w-48">
            <option value="">From template…</option>
            {TEMPLATES.map((t, i) => <option key={t.label} value={i}>{t.label}</option>)}
          </Select>
          <Button variant="primary" size="sm" onClick={() => openNew()}>
            <Plus size={15} /> New policy
          </Button>
        </>}
        stats={<>
          <HeroStat icon={ShieldCheck} label="Policies" value={isLoading ? '—' : policies.length} tone="accent" />
          <HeroStat icon={Lock} label="Restrictions" value={isLoading ? '—' : totalRestrictions} tone="info" />
          <HeroStat icon={Ban} label="Blocklists" value={isLoading ? '—' : withBlocklists} tone="warn" />
        </>}
      />

      {editor && (
        <PolicyEditor
          editor={editor}
          setEditor={setEditor}
          saving={save.isPending}
          saveErr={saveErr}
          onCancel={() => { setEditor(null); setSaveErr(null); }}
          onSave={() => save.mutate()}
        />
      )}

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="p-4 space-y-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-8 w-full" />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && policies.length === 0 && (
        <Card className="relative overflow-hidden">
          <Hairline tone="faint" />
          <div className="flex flex-col items-center justify-center text-center py-14 px-6">
            <span className="grid place-items-center h-12 w-12 rounded-2xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
              <ShieldIcon size={22} />
            </span>
            <div className="mt-3 text-sm font-medium text-fg">No policies yet</div>
            <p className="mt-1 max-w-sm text-xs text-muted">
              Create one from a template, or start from scratch — restrictions, app/URL blocklists and advanced JSON all live in the editor.
            </p>
            <div className="mt-4">
              <Button variant="primary" onClick={() => openNew()}><Plus size={15} /> New policy</Button>
            </div>
          </div>
        </Card>
      )}

      {!isLoading && policies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {policies.map((p, i) => (
            <PolicyCard
              key={p.id}
              p={p}
              index={i}
              onView={() => setView(p)}
              onEdit={() => { setSaveErr(null); setEditor({ id: p.id, name: p.name, form: decompose(p.spec) }); }}
              onAssign={async () => {
                if (await confirmDialog({
                  title: `Assign “${p.name}” to the whole tenant?`,
                  message: 'Every device in your tenant will receive and enforce this policy on its next check-in.',
                  confirmLabel: 'Assign to all devices', tone: 'accent', icon: Send,
                })) assignTenant.mutate(p.id);
              }}
              onDelete={async () => {
                if (await confirmDialog({
                  title: `Delete policy “${p.name}”?`,
                  message: 'All assignments to this policy will be removed and devices will reconcile to their remaining policies.',
                  confirmLabel: 'Delete policy', icon: Trash2,
                })) remove.mutate(p.id);
              }}
            />
          ))}
        </div>
      )}

      {view && <PolicyViewer p={view} onClose={() => setView(null)} />}
    </div>
  );
}

function PolicyCard({ p, index, onView, onEdit, onAssign, onDelete }: {
  p: Policy; index: number;
  onView: () => void; onEdit: () => void; onAssign: () => void; onDelete: () => void;
}) {
  const g = glance(p.spec);
  return (
    <Card
      className="card-grad group relative flex flex-col overflow-hidden p-4 ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-line-strong animate-slideup"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="flex items-start gap-3">
        <span className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15 transition-colors group-hover:bg-accent/15">
          <ShieldCheck size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-fg">{p.name}</div>
          <div className="mt-1 flex items-center gap-2 text-2xs text-faint">
            <Badge tone="accent" className="px-1.5 tabular-nums">v{p.version}</Badge>
            <span className="inline-flex items-center gap-1 truncate tabular-nums">
              <Clock size={11} className="shrink-0 text-faint" />
              {new Date(p.updated_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      {/* Spec glance chips */}
      <div className="mt-3.5 flex flex-wrap gap-1.5 min-h-[1.5rem]">
        {g.empty && (
          <span className="inline-flex items-center gap-1.5 text-2xs text-faint italic">
            <ScrollText size={11} /> Empty profile
          </span>
        )}
        {g.restrictions > 0 && <SpecChip icon={Lock} label={`${g.restrictions} restriction${g.restrictions === 1 ? '' : 's'}`} tone="info" />}
        {g.apps > 0 && <SpecChip icon={Ban} label={`${g.apps} app${g.apps === 1 ? '' : 's'}`} tone="danger" />}
        {g.urls > 0 && <SpecChip icon={Globe} label={`${g.urls} URL${g.urls === 1 ? '' : 's'}`} tone="warn" />}
        {g.captureOnUnlock && <SpecChip icon={Camera} label="Capture" tone="accent" />}
        {g.hasPassword && <SpecChip icon={KeyRound} label="Password" tone="muted" />}
        {g.hasCompliance && <SpecChip icon={ShieldCheck} label="Compliance" tone="success" />}
      </div>

      <div className="mt-auto pt-3.5" />
      <div className="flex items-center gap-1.5 border-t border-line pt-3">
        <Button size="sm" variant="subtle" onClick={onView}><Eye size={13} /> View</Button>
        <Button size="sm" variant="secondary" onClick={onEdit}><Pencil size={13} /> Edit</Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onAssign} title="Assign to all devices in tenant"><Send size={13} /></Button>
          <Button size="sm" variant="danger" onClick={onDelete} title="Delete policy"><Trash2 size={13} /></Button>
        </div>
      </div>
    </Card>
  );
}

function PolicyEditor({
  editor, setEditor, saving, saveErr, onCancel, onSave
}: {
  editor: { id?: string; name: string; form: FormState };
  setEditor: (e: { id?: string; name: string; form: FormState }) => void;
  saving: boolean;
  saveErr: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(editor.form.advancedJson.trim() !== '{}');
  const setForm = (patch: Partial<FormState>) =>
    setEditor({ ...editor, form: { ...editor.form, ...patch } });

  const previewSpec = useMemo(() => {
    const built = build(editor.form);
    return built.ok ? JSON.stringify(built.spec, null, 2) : `// ${built.err}`;
  }, [editor.form]);

  // Escape cancels the editor, matching the read-only viewer's affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Shared field token for the mono code areas (blocklists / advanced JSON);
  // the bg-bg + h-32 are layered on via className on the imported Textarea.
  const codeCls = 'h-32 bg-bg font-mono text-xs';

  const enabledCount = Object.values(editor.form.restrictions).filter(Boolean).length;

  return (
    <Card className="card-grad relative overflow-hidden ring-1 ring-inset ring-line animate-scalein">
      <Hairline />
      <span className="pointer-events-none absolute -top-16 -right-12 h-40 w-40 rounded-full bg-accent/8 blur-3xl" />

      {/* Editor header */}
      <div className="relative flex items-center gap-3 px-4 py-3.5 border-b border-line">
        <span className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm ring-1 ring-inset ring-white/15">
          {editor.id ? <Pencil size={16} /> : <Sparkles size={16} />}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg">{editor.id ? 'Edit policy' : 'New policy'}</div>
          <div className="text-2xs text-muted">
            {editor.id ? 'Saving creates a new version, leaving history intact.' : 'Build a profile from structured controls or raw JSON.'}
          </div>
        </div>
        {editor.id && <Badge tone="accent" dot className="ml-auto">Editing</Badge>}
      </div>

      <div className="relative p-4 space-y-6 max-h-[78vh] overflow-auto">
        <div>
          <SectionHeading icon={ScrollText} title="Policy name" hint="Shown across the console and on every assignment." />
          <Input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}
                 placeholder="e.g. Block social media" />
        </div>

        <div>
          <SectionHeading
            icon={Lock}
            title="Restrictions"
            hint="Device-level controls enforced by the agent."
            actions={enabledCount > 0
              ? <Badge tone="info" className="tabular-nums">{enabledCount} on</Badge>
              : <span className="text-2xs text-faint">None selected</span>}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {RESTRICTIONS.map(r => {
              const on = !!editor.form.restrictions[r.key];
              return (
                <label key={r.key}
                  className={cn(
                    'group/tile flex items-center gap-2.5 cursor-pointer rounded-lg border px-3 py-2 text-sm transition-[transform,background-color,border-color] duration-150 active:translate-y-px',
                    on ? 'border-accent/40 bg-accent/8 text-fg ring-1 ring-inset ring-accent/15'
                       : 'border-line bg-surface text-muted hover:border-line-strong hover:bg-surface-2'
                  )}>
                  <input type="checkbox" className="sr-only"
                         checked={on}
                         onChange={e => setForm({ restrictions: { ...editor.form.restrictions, [r.key]: e.target.checked } })} />
                  <span className={cn(
                    'grid place-items-center h-5 w-5 shrink-0 rounded-md transition-colors',
                    on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-faint ring-1 ring-inset ring-line group-hover/tile:text-muted'
                  )}>
                    <Lock size={11} strokeWidth={2.4} />
                  </span>
                  <span className="leading-tight">{r.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <SectionHeading icon={Ban} title="Blocklists" hint="Packages and browser URL patterns to deny on device." />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-line bg-surface-2/40 p-3 ring-1 ring-inset ring-line/60">
              <SectionLabel icon={Ban}>App blocklist</SectionLabel>
              <div className="text-2xs text-muted mb-2">One Android package name per line. E.g. <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg ring-1 ring-inset ring-line">com.instagram.android</code>.</div>
              <Textarea value={editor.form.appBlocklist} onChange={e => setForm({ appBlocklist: e.target.value })}
                        placeholder="com.example.app"
                        className={codeCls} />
            </div>
            <div className="rounded-xl border border-line bg-surface-2/40 p-3 ring-1 ring-inset ring-line/60">
              <SectionLabel icon={Globe}>URL blocklist (Chrome / Edge / Brave)</SectionLabel>
              <div className="text-2xs text-muted mb-2">One pattern per line. E.g. <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg ring-1 ring-inset ring-line">youtube.com</code>, <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg ring-1 ring-inset ring-line">*.youtube.com</code>.</div>
              <Textarea value={editor.form.urlBlocklist} onChange={e => setForm({ urlBlocklist: e.target.value })}
                        placeholder="example.com"
                        className={codeCls} />
            </div>
          </div>
        </div>

        <label className={cn(
          'group/cap flex items-center gap-2.5 cursor-pointer rounded-lg border px-3 py-2.5 text-sm transition-[transform,background-color,border-color] duration-150 active:translate-y-px w-fit',
          editor.form.captureOnUnlock ? 'border-accent/40 bg-accent/8 text-fg ring-1 ring-inset ring-accent/15'
                                      : 'border-line bg-surface text-muted hover:border-line-strong hover:bg-surface-2'
        )}>
          <span className={cn(
            'grid place-items-center h-5 w-5 shrink-0 rounded-md transition-colors',
            editor.form.captureOnUnlock ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-faint ring-1 ring-inset ring-line group-hover/cap:text-muted'
          )}>
            <Camera size={11} strokeWidth={2.4} />
          </span>
          <input type="checkbox" className="sr-only"
                 checked={editor.form.captureOnUnlock}
                 onChange={e => setForm({ captureOnUnlock: e.target.checked })} />
          <span>Capture front-camera photo on every unlock</span>
        </label>

        <div>
          <SectionHeading
            icon={ShieldCheck}
            title="Work profile (BYOD)"
            hint="Applied only on Profile-Owner (work-profile) devices; ignored on Device Owner / Admin."
            actions={(() => {
              const n = WORK_PROFILE_TOGGLES.filter(t => editor.form.workProfile[t.key]).length;
              return n > 0 ? <Badge tone="info" className="tabular-nums">{n} on</Badge> : <span className="text-2xs text-faint">None selected</span>;
            })()}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {WORK_PROFILE_TOGGLES.map(t => {
              const on = !!editor.form.workProfile[t.key];
              return (
                <label key={t.key}
                  className={cn(
                    'group/tile flex items-center gap-2.5 cursor-pointer rounded-lg border px-3 py-2 text-sm transition-[transform,background-color,border-color] duration-150 active:translate-y-px',
                    on ? 'border-accent/40 bg-accent/8 text-fg ring-1 ring-inset ring-accent/15'
                       : 'border-line bg-surface text-muted hover:border-line-strong hover:bg-surface-2'
                  )}>
                  <input type="checkbox" className="sr-only" checked={on}
                         onChange={e => setForm({ workProfile: { ...editor.form.workProfile, [t.key]: e.target.checked } })} />
                  <span className={cn(
                    'grid place-items-center h-5 w-5 shrink-0 rounded-md transition-colors',
                    on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-faint ring-1 ring-inset ring-line group-hover/tile:text-muted'
                  )}>
                    <ShieldCheck size={11} strokeWidth={2.4} />
                  </span>
                  <span className="leading-tight">{t.label}</span>
                </label>
              );
            })}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <div className="rounded-xl border border-line bg-surface-2/40 p-3 ring-1 ring-inset ring-line/60">
              <SectionLabel icon={Ban}>Suspended work apps</SectionLabel>
              <div className="text-2xs text-muted mb-2">Frozen (not uninstalled). One package per line.</div>
              <Textarea value={editor.form.workSuspended} onChange={e => setForm({ workSuspended: e.target.value })}
                        placeholder="com.example.app" className={codeCls} />
            </div>
            <div className="rounded-xl border border-line bg-surface-2/40 p-3 ring-1 ring-inset ring-line/60">
              <SectionLabel icon={Clock}>Auto-pause after (minutes off)</SectionLabel>
              <div className="text-2xs text-muted mb-2">Pause the work profile once it's been off this long (0 / blank = never). API 31+.</div>
              <Input type="number" min={0} value={editor.form.workMaxTimeOff}
                     onChange={e => setForm({ workMaxTimeOff: e.target.value })} placeholder="e.g. 4320 (3 days)" />
              <div className="text-2xs text-faint mt-2">Allowed-app list and managed app configs are set via advanced JSON (<code className="font-mono">apps.install</code>, <code className="font-mono">managed_app_configs</code>).</div>
            </div>
          </div>
        </div>

        <div>
          <button onClick={() => setShowAdvanced(v => !v)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover transition-colors">
            <Layers size={13} />
            {showAdvanced ? 'Hide' : 'Show'} advanced JSON (password, network, compliance, etc.)
          </button>
          {showAdvanced && (
            <Textarea value={editor.form.advancedJson} onChange={e => setForm({ advancedJson: e.target.value })}
                      placeholder='{"password": {"complexity": 65536}}'
                      className={cn(codeCls, 'mt-2 animate-fadein')} />
          )}
        </div>

        <div>
          <SectionHeading icon={FileJson} title="Effective JSON sent to device" hint="Live preview of the canonical spec the agent receives." />
          <div className="relative overflow-hidden rounded-xl border border-line bg-bg ring-1 ring-inset ring-line">
            <Hairline tone="faint" />
            <pre className="text-xs text-fg p-3 overflow-auto max-h-40">{previewSpec}</pre>
          </div>
        </div>

        {saveErr && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger animate-fadein">
            <Ban size={15} className="mt-0.5 shrink-0" />
            <span>{saveErr}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : (
              <>
                {editor.id ? <Layers size={15} /> : <ShieldCheck size={15} />}
                {editor.id ? 'Save new version' : 'Save policy'}
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PolicyViewer({ p, onClose }: { p: Policy; onClose: () => void }) {
  const { data: assignments } = useQuery({
    queryKey: ['policy-assignments', p.id],
    queryFn: () => listAssignmentsFor(p.id)
  });

  const g = glance(p.spec);
  const assignTone: Record<string, 'accent' | 'info' | 'success'> = { tenant: 'accent', group: 'info', device: 'success' };
  return (
    <Modal onClose={onClose} label={`Policy ${p.name}`} width="max-w-[40rem]">
        {/* Header */}
        <div className="relative flex shrink-0 items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="absolute -top-12 -left-8 h-32 w-32 rounded-full bg-accent/8 blur-3xl pointer-events-none" />
          <div className="relative flex items-start gap-3">
            <span className="grid place-items-center h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
              <ShieldCheck size={19} />
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-lg text-fg leading-tight truncate">{p.name}</div>
              <div className="mt-1 flex items-center gap-2 text-2xs text-muted">
                <Badge tone="muted" className="px-1.5">v{p.version}</Badge>
                <span className="tabular-nums">updated {new Date(p.updated_at).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="relative grid place-items-center h-8 w-8 rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors">
            <X size={16} />
          </button>
        </div>

        <ModalBody className="p-5 space-y-4">
          {!g.empty && (
            <div className="flex flex-wrap gap-1.5">
              {g.restrictions > 0 && <SpecChip icon={Lock} label={`${g.restrictions} restriction${g.restrictions === 1 ? '' : 's'}`} tone="info" />}
              {g.apps > 0 && <SpecChip icon={Ban} label={`${g.apps} app${g.apps === 1 ? '' : 's'}`} tone="danger" />}
              {g.urls > 0 && <SpecChip icon={Globe} label={`${g.urls} URL${g.urls === 1 ? '' : 's'}`} tone="warn" />}
              {g.captureOnUnlock && <SpecChip icon={Camera} label="Capture on unlock" tone="accent" />}
              {g.hasPassword && <SpecChip icon={KeyRound} label="Password" tone="muted" />}
              {g.hasCompliance && <SpecChip icon={ShieldCheck} label="Compliance" tone="success" />}
            </div>
          )}
          <div>
            <SectionLabel icon={FileJson}>Spec</SectionLabel>
            <div className="relative overflow-hidden rounded-xl border border-line bg-bg ring-1 ring-inset ring-line">
              <Hairline tone="faint" />
              <pre className="text-xs text-fg p-3 overflow-auto max-h-80">{JSON.stringify(p.spec, null, 2)}</pre>
            </div>
          </div>
          <div>
            <SectionLabel icon={Send}>Assignments</SectionLabel>
            {!assignments?.length && (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface-2/40 px-3 py-6 text-center">
                <span className="grid place-items-center h-10 w-10 rounded-2xl bg-accent-soft text-accent">
                  <Send size={16} />
                </span>
                <span className="text-sm text-faint">No active assignments.</span>
              </div>
            )}
            {!!assignments?.length && (
              <ul className="space-y-1.5">
                {assignments.map(a => (
                  <li key={a.id} className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm transition-colors hover:bg-surface-2">
                    <span className={cn(
                      'grid place-items-center h-7 w-7 shrink-0 rounded-lg',
                      a.target_kind === 'tenant' ? 'bg-accent-soft text-accent'
                        : a.target_kind === 'group' ? 'bg-info/12 text-info'
                        : 'bg-success/12 text-success'
                    )}>
                      {a.target_kind === 'tenant' ? <Globe size={13} /> : a.target_kind === 'group' ? <Layers size={13} /> : <ShieldCheck size={13} />}
                    </span>
                    <Badge tone={assignTone[a.target_kind] ?? 'muted'} dot>{a.target_kind}</Badge>
                    {a.target_id && <span className="font-mono text-2xs text-muted">{a.target_id.slice(0, 8)}…</span>}
                    <span className="ml-auto text-2xs text-faint tabular-nums">{new Date(a.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ModalBody>
    </Modal>
  );
}
