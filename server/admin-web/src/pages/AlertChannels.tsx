import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, Bell, Mail, Webhook, FlaskConical, RefreshCw, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { toast } from '../components/toast';
import {
  listChannels, createChannel, updateChannel, deleteChannel, testChannel, listLog,
  type AlertChannel, type AlertLogEntry, type ChannelInput, type ChannelKind,
} from '../api/alerts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const emptyEmailForm = (): ChannelInput => ({
  name: '',
  kind: 'email',
  smtp_host: '',
  smtp_port: 587,
  smtp_tls: true,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  smtp_to: [],
  on_compliance_trigger: true,
  on_device_offline: false,
  on_posture_drop: false,
  enabled: true,
});

const emptyWebhookForm = (): ChannelInput => ({
  name: '',
  kind: 'webhook',
  webhook_url: '',
  webhook_secret: '',
  on_compliance_trigger: true,
  on_device_offline: false,
  on_posture_drop: false,
  enabled: true,
});

function channelToInput(ch: AlertChannel): ChannelInput {
  return {
    name: ch.name,
    kind: ch.kind,
    smtp_host: ch.smtp_host,
    smtp_port: ch.smtp_port,
    smtp_tls: ch.smtp_tls,
    smtp_user: ch.smtp_user,
    smtp_pass: ch.smtp_pass,
    smtp_from: ch.smtp_from,
    smtp_to: ch.smtp_to ?? [],
    webhook_url: ch.webhook_url,
    webhook_secret: ch.webhook_secret,
    on_compliance_trigger: ch.on_compliance_trigger,
    on_device_offline: ch.on_device_offline,
    on_posture_drop: ch.on_posture_drop,
    enabled: ch.enabled,
  };
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ─── Channel form modal ───────────────────────────────────────────────────────

function ChannelForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: ChannelInput;
  onSave: (v: ChannelInput) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<ChannelInput>(initial ?? emptyEmailForm());
  const [smtpToRaw, setSmtpToRaw] = useState((initial?.smtp_to ?? []).join(', '));
  const [showPass, setShowPass] = useState(false);

  const set = (patch: Partial<ChannelInput>) => setForm(f => ({ ...f, ...patch }));

  const handleKindChange = (kind: ChannelKind) => {
    setForm(kind === 'email' ? { ...emptyEmailForm(), name: form.name } : { ...emptyWebhookForm(), name: form.name });
    setSmtpToRaw('');
  };

  function submit() {
    if (!form.name.trim()) { toast.error('Channel name is required'); return; }
    if (form.kind === 'email') {
      if (!form.smtp_host?.trim()) { toast.error('SMTP host is required'); return; }
      if (!form.smtp_from?.trim()) { toast.error('From address is required'); return; }
      const recipients = smtpToRaw.split(',').map(s => s.trim()).filter(Boolean);
      if (recipients.length === 0) { toast.error('At least one recipient email is required'); return; }
      onSave({ ...form, smtp_to: recipients });
    } else {
      if (!form.webhook_url?.trim()) { toast.error('Webhook URL is required'); return; }
      onSave(form);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-2xl border border-line bg-surface shadow-overlay animate-scalein">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-fg">{initial ? 'Edit channel' : 'New alert channel'}</h2>
            <p className="text-xs text-muted mt-0.5">Channels receive alerts when compliance rules fire or devices go offline</p>
          </div>
          <button onClick={onCancel} className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:bg-surface-2 text-lg leading-none">×</button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Channel name */}
          <Field label="Channel name">
            <Input value={form.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Ops Team Email" autoFocus />
          </Field>

          {/* Kind toggle */}
          <div>
            <p className="text-xs font-medium text-muted mb-2">Delivery method</p>
            <div className="grid grid-cols-2 gap-2">
              {(['email', 'webhook'] as ChannelKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => handleKindChange(k)}
                  className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-all ${
                    form.kind === k
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line bg-surface-2 text-muted hover:border-accent/50'
                  }`}
                >
                  {k === 'email' ? <Mail className="w-4 h-4" /> : <Webhook className="w-4 h-4" />}
                  {k === 'email' ? 'Email (SMTP)' : 'Webhook (HTTP)'}
                </button>
              ))}
            </div>
          </div>

          {/* Email fields */}
          {form.kind === 'email' && (
            <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Field label="SMTP host">
                    <Input value={form.smtp_host ?? ''} onChange={e => set({ smtp_host: e.target.value })} placeholder="smtp.gmail.com" />
                  </Field>
                </div>
                <div>
                  <Field label="Port">
                    <Input type="number" value={form.smtp_port ?? 587} onChange={e => set({ smtp_port: Number(e.target.value) })} />
                  </Field>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form.smtp_tls ?? true}
                    onChange={e => set({ smtp_tls: e.target.checked })}
                    className="accent-accent w-4 h-4"
                  />
                  Use TLS / STARTTLS
                </label>
              </div>
              <Field label="Username">
                <Input value={form.smtp_user ?? ''} onChange={e => set({ smtp_user: e.target.value })} placeholder="alerts@example.com" />
              </Field>
              <Field label="Password (app password recommended)">
                <div className="relative">
                  <Input
                    type={showPass ? 'text' : 'password'}
                    value={form.smtp_pass ?? ''}
                    onChange={e => set({ smtp_pass: e.target.value })}
                    placeholder="••••••••"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>
              <Field label="From address">
                <Input value={form.smtp_from ?? ''} onChange={e => set({ smtp_from: e.target.value })} placeholder="MDM Alerts <noreply@example.com>" />
              </Field>
              <Field label="Recipients (comma-separated)" hint="e.g. ops@example.com, ciso@example.com">
                <Input value={smtpToRaw} onChange={e => setSmtpToRaw(e.target.value)} placeholder="ops@example.com" />
              </Field>
            </div>
          )}

          {/* Webhook fields */}
          {form.kind === 'webhook' && (
            <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
              <Field label="Webhook URL">
                <Input value={form.webhook_url ?? ''} onChange={e => set({ webhook_url: e.target.value })} placeholder="https://hooks.slack.com/services/..." />
              </Field>
              <Field label="Signing secret (optional)" hint="When set, adds an X-SeceoKnight-Signature HMAC-SHA256 header">
                <div className="relative">
                  <Input
                    type={showPass ? 'text' : 'password'}
                    value={form.webhook_secret ?? ''}
                    onChange={e => set({ webhook_secret: e.target.value })}
                    placeholder="Leave blank to skip signing"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>
            </div>
          )}

          {/* Event subscriptions */}
          <div>
            <p className="text-xs font-medium text-muted mb-2">Notify on these events</p>
            <div className="space-y-2">
              {[
                { key: 'on_compliance_trigger', label: 'Compliance rule fired', desc: 'A rule evaluated to true and an action was dispatched' },
                { key: 'on_device_offline',     label: 'Device went offline',   desc: 'A device has not sent a heartbeat in the expected window' },
                { key: 'on_posture_drop',       label: 'Posture score dropped',  desc: 'A device posture score decreased significantly' },
              ].map(ev => (
                <label key={ev.key} className="flex items-start gap-3 cursor-pointer select-none rounded-lg border border-line bg-surface-2 px-4 py-3 hover:border-accent/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={!!(form as unknown as Record<string, unknown>)[ev.key]}
                    onChange={e => set({ [ev.key]: e.target.checked } as Partial<ChannelInput>)}
                    className="accent-accent w-4 h-4 mt-0.5 flex-shrink-0"
                  />
                  <div>
                    <p className="text-sm font-medium text-fg">{ev.label}</p>
                    <p className="text-xs text-muted">{ev.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Enabled toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.enabled ?? true}
              onChange={e => set({ enabled: e.target.checked })}
              className="accent-accent w-4 h-4"
            />
            <span className="text-sm text-fg">Channel enabled</span>
          </label>
        </div>

        <div className="flex justify-end gap-3 border-t border-line px-6 py-4">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save channel'}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Log drawer ───────────────────────────────────────────────────────────────

function LogDrawer({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [logs, setLogs] = useState<AlertLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listLog(channelId)
      .then(setLogs)
      .catch(() => toast.error('Failed to load delivery history'))
      .finally(() => setLoading(false));
  }, [channelId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-full max-h-screen rounded-2xl border border-line bg-surface shadow-overlay flex flex-col animate-slideinright">
        <div className="flex items-center justify-between border-b border-line px-6 py-4 flex-shrink-0">
          <h2 className="text-base font-semibold text-fg">Delivery history</h2>
          <button onClick={onClose} className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:bg-surface-2 text-lg leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <p className="text-sm text-muted text-center py-8">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted text-center py-8">No delivery records yet.</p>
          ) : logs.map(log => (
            <div key={log.id} className={`rounded-xl border px-4 py-3 text-xs space-y-1 ${
              log.status === 'sent' ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'
            }`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {log.status === 'sent'
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    : <XCircle className="w-3.5 h-3.5 text-danger" />}
                  <span className={`font-medium ${log.status === 'sent' ? 'text-success' : 'text-danger'}`}>{log.status}</span>
                  <span className="text-muted">·</span>
                  <span className="text-muted font-mono">{log.event_type}</span>
                </div>
                <span className="text-muted tabular-nums">{fmtDate(log.created_at)}</span>
              </div>
              {log.subject && <p className="text-fg/80 truncate">{log.subject}</p>}
              {log.error && <p className="text-danger/80 font-mono break-all">{log.error}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AlertChannels() {
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AlertChannel | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logChannelId, setLogChannelId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listChannels()
      .then(setChannels)
      .catch(() => toast.error('Failed to load channels'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(input: ChannelInput) {
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateChannel(editing.id, input);
        setChannels(cs => cs.map(c => c.id === updated.id ? updated : c));
        toast.success('Channel updated');
      } else {
        const created = await createChannel(input);
        setChannels(cs => [created, ...cs]);
        toast.success('Channel created');
      }
      setEditing(null);
      setCreating(false);
    } catch {
      toast.error('Failed to save channel');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(ch: AlertChannel) {
    const ok = await confirmDialog({
      title: 'Delete channel',
      message: `Delete "${ch.name}"? Delivery history for this channel will be preserved.`,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteChannel(ch.id);
      setChannels(cs => cs.filter(c => c.id !== ch.id));
      toast.success('Channel deleted');
    } catch {
      toast.error('Failed to delete channel');
    }
  }

  async function handleTest(ch: AlertChannel) {
    setTestingId(ch.id);
    try {
      const r = await testChannel(ch.id);
      toast.success(r.message ?? 'Test alert queued');
    } catch {
      toast.error('Test failed — check channel configuration');
    } finally {
      setTestingId(null);
    }
  }

  const showForm = creating || editing !== null;
  const formInitial = editing ? channelToInput(editing) : undefined;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bell className="w-5 h-5 text-accent" />
            <h1 className="text-xl font-bold text-fg">Alert Channels</h1>
          </div>
          <p className="text-sm text-muted">
            Configure email and webhook destinations for compliance events, device alerts, and posture changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4" /> New channel
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total channels', value: channels.length },
          { label: 'Email', value: channels.filter(c => c.kind === 'email').length },
          { label: 'Webhook', value: channels.filter(c => c.kind === 'webhook').length },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-line bg-surface-2 px-4 py-3">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="text-2xl font-bold text-fg tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Channel list */}
      {loading ? (
        <div className="text-center py-16 text-muted text-sm">Loading channels…</div>
      ) : channels.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-2 py-16 text-center">
          <Bell className="w-10 h-10 text-muted mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium text-fg">No channels configured</p>
          <p className="text-xs text-muted mt-1 mb-4">Add an email or webhook to start receiving alerts</p>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4" /> Create first channel
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map(ch => (
            <div key={ch.id} className={`rounded-2xl border bg-surface px-5 py-4 transition-all ${
              ch.enabled ? 'border-line hover:border-accent/30' : 'border-line/50 opacity-60'
            }`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    ch.kind === 'email' ? 'bg-blue-500/10' : 'bg-purple-500/10'
                  }`}>
                    {ch.kind === 'email'
                      ? <Mail className="w-4 h-4 text-blue-400" />
                      : <Webhook className="w-4 h-4 text-purple-400" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-fg truncate">{ch.name}</p>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 ${
                        ch.enabled
                          ? 'text-success bg-success/10 ring-success/20'
                          : 'text-muted bg-surface-2 ring-line'
                      }`}>{ch.enabled ? 'enabled' : 'disabled'}</span>
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 text-accent bg-accent/10 ring-accent/20">
                        {ch.kind}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-0.5 truncate">
                      {ch.kind === 'email'
                        ? `${ch.smtp_from || ch.smtp_host} → ${(ch.smtp_to ?? []).join(', ')}`
                        : ch.webhook_url}
                    </p>
                    {/* Subscriptions */}
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {ch.on_compliance_trigger && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-warn/10 text-warn ring-1 ring-warn/20">compliance</span>
                      )}
                      {ch.on_device_offline && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 ring-1 ring-orange-400/20">offline</span>
                      )}
                      {ch.on_posture_drop && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 ring-1 ring-blue-400/20">posture</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    onClick={() => setLogChannelId(ch.id)}
                    title="View delivery history"
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleTest(ch)}
                    disabled={testingId === ch.id}
                    title="Send test alert"
                  >
                    <FlaskConical className={`w-4 h-4 ${testingId === ch.id ? 'animate-pulse text-accent' : ''}`} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setEditing(ch)}
                    title="Edit channel"
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDelete(ch)}
                    title="Delete channel"
                  >
                    <Trash2 className="w-4 h-4 text-danger" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Channel form modal */}
      {showForm && (
        <ChannelForm
          initial={formInitial}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setCreating(false); }}
          saving={saving}
        />
      )}

      {/* Delivery log drawer */}
      {logChannelId && (
        <LogDrawer
          channelId={logChannelId}
          onClose={() => setLogChannelId(null)}
        />
      )}
    </div>
  );
}
