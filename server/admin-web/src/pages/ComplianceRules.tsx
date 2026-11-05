import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, ShieldAlert, Activity, Zap, Clock, ToggleLeft, ToggleRight, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { toast } from '../components/toast';
import {
  listRules, createRule, updateRule, deleteRule, listEvents,
  type ComplianceRule, type ComplianceEvent, type RuleInput,
  type TriggerField, type Operator,
} from '../api/compliance';

// ─── Constants ────────────────────────────────────────────────────────────────

const TRIGGER_FIELDS: { value: TriggerField; label: string; desc: string }[] = [
  { value: 'posture_score',  label: 'Posture score',  desc: 'Device security attestation score (0–100; lower = riskier)' },
  { value: 'battery_level', label: 'Battery level',  desc: 'Device battery percentage (0–100)' },
];

const OPERATORS: { value: Operator; label: string; example: string }[] = [
  { value: 'lt',  label: 'is less than',             example: '< threshold' },
  { value: 'lte', label: 'is less than or equal to', example: '≤ threshold' },
  { value: 'gt',  label: 'is greater than',           example: '> threshold' },
  { value: 'gte', label: 'is greater than or equal',  example: '≥ threshold' },
  { value: 'eq',  label: 'is exactly',                example: '= threshold' },
];

const ACTIONS = [
  { value: 'LOCK',             label: 'Lock device',       risk: 'low'    },
  { value: 'REBOOT',           label: 'Reboot device',     risk: 'low'    },
  { value: 'PUSH_POLICY',      label: 'Re-push policy',    risk: 'low'    },
  { value: 'ENABLE_LOST_MODE', label: 'Enable lost mode',  risk: 'medium' },
  { value: 'RESET_PASSWORD',   label: 'Reset password',    risk: 'high'   },
  { value: 'WIPE',             label: 'Factory wipe',      risk: 'danger' },
];

const ACTION_RISK: Record<string, string> = {
  low:    'text-success bg-success/10 ring-success/20',
  medium: 'text-warn bg-warn/10 ring-warn/20',
  high:   'text-orange-400 bg-orange-500/10 ring-orange-400/20',
  danger: 'text-danger bg-danger/10 ring-danger/20',
};

const OP_LABELS: Record<string, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=' };
const STATUS_STYLES: Record<string, string> = {
  triggered: 'text-danger bg-danger/10 ring-danger/20',
  skipped:   'text-warn bg-warn/10 ring-warn/20',
  failed:    'text-muted bg-surface-2 ring-line',
};

// ─── Empty form ───────────────────────────────────────────────────────────────

const emptyForm = (): RuleInput => ({
  name: '',
  description: '',
  trigger_field: 'posture_score',
  operator: 'lt',
  threshold: 60,
  action: 'LOCK',
  action_payload: {},
  cooldown_minutes: 60,
  enabled: true,
});

// ─── RuleForm modal ───────────────────────────────────────────────────────────

function RuleForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: RuleInput;
  onSave: (v: RuleInput) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<RuleInput>(initial ?? emptyForm());
  const set = (patch: Partial<RuleInput>) => setForm(f => ({ ...f, ...patch }));

  const selectedAction = ACTIONS.find(a => a.value === form.action);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-2xl border border-line bg-surface shadow-overlay animate-scalein">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-fg">{initial ? 'Edit rule' : 'New compliance rule'}</h2>
            <p className="text-xs text-muted mt-0.5">Auto-actions trigger every 5 minutes when conditions are met</p>
          </div>
          <button onClick={onCancel} className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:bg-surface-2 text-lg leading-none">×</button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label="Rule name">
            <Input value={form.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Lock low-posture devices" autoFocus />
          </Field>

          <Field label="Description (optional)">
            <Input value={form.description} onChange={e => set({ description: e.target.value })} placeholder="What this rule does and why" />
          </Field>

          {/* Condition builder */}
          <div className="rounded-xl border border-line bg-surface-2/60 p-4 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-faint">Condition</div>

            <Field label="Metric">
              <select
                value={form.trigger_field}
                onChange={e => set({ trigger_field: e.target.value as TriggerField })}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {TRIGGER_FIELDS.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              <p className="text-2xs text-faint mt-1">
                {TRIGGER_FIELDS.find(f => f.value === form.trigger_field)?.desc}
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Operator">
                <select
                  value={form.operator}
                  onChange={e => set({ operator: e.target.value as Operator })}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  {OPERATORS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Threshold">
                <Input
                  type="number" min={0} max={100} step={1}
                  value={form.threshold}
                  onChange={e => set({ threshold: parseFloat(e.target.value) || 0 })}
                />
              </Field>
            </div>

            <div className="rounded-lg bg-accent/[0.07] border border-accent/20 px-3 py-2 text-xs text-accent/90 font-mono">
              IF {form.trigger_field} {OP_LABELS[form.operator] ?? form.operator} {form.threshold} → {form.action}
            </div>
          </div>

          {/* Action */}
          <div className="rounded-xl border border-line bg-surface-2/60 p-4 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-faint">Action</div>

            <Field label="Command to dispatch">
              <select
                value={form.action}
                onChange={e => set({ action: e.target.value })}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {ACTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              {selectedAction && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={`text-2xs font-medium px-2 py-0.5 rounded-full ring-1 ring-inset ${ACTION_RISK[selectedAction.risk]}`}>
                    {selectedAction.risk} risk
                  </span>
                  {selectedAction.risk === 'danger' && (
                    <span className="text-2xs text-danger/80">⚠ This will erase all device data</span>
                  )}
                </div>
              )}
            </Field>
          </div>

          {/* Cooldown */}
          <Field label="Cooldown between actions (minutes)" hint="Prevents the same device from being actioned repeatedly">
            <Input
              type="number" min={1} max={10080}
              value={form.cooldown_minutes}
              onChange={e => set({ cooldown_minutes: parseInt(e.target.value) || 60 })}
            />
          </Field>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-fg">Rule enabled</div>
              <div className="text-2xs text-muted">Disabled rules are stored but never evaluated</div>
            </div>
            <button
              type="button"
              onClick={() => set({ enabled: !form.enabled })}
              className={`transition-colors ${form.enabled ? 'text-accent' : 'text-faint'}`}
            >
              {form.enabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-line px-6 py-4">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : initial ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ComplianceRules() {
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ComplianceRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    setLoadingRules(true);
    try { setRules(await listRules()); } catch { toast.error('Failed to load rules'); } finally { setLoadingRules(false); }
  }, []);

  const fetchEvents = useCallback(async () => {
    setLoadingEvents(true);
    try { setEvents(await listEvents({ limit: 200 })); } catch { /* silent */ } finally { setLoadingEvents(false); }
  }, []);

  useEffect(() => { fetchRules(); fetchEvents(); }, [fetchRules, fetchEvents]);

  const handleSave = async (input: RuleInput) => {
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateRule(editing.id, input);
        setRules(r => r.map(x => x.id === updated.id ? updated : x));
        toast.success('Rule updated');
      } else {
        const created = await createRule(input);
        setRules(r => [created, ...r]);
        toast.success('Rule created');
      }
      setShowForm(false);
      setEditing(null);
    } catch {
      toast.error('Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rule: ComplianceRule) => {
    const ok = await confirmDialog({
      title: 'Delete compliance rule',
      message: `Delete "${rule.name}"? This cannot be undone. Any pending cooldowns will also be cleared.`,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteRule(rule.id);
      setRules(r => r.filter(x => x.id !== rule.id));
      toast.success('Rule deleted');
    } catch {
      toast.error('Failed to delete rule');
    }
  };

  const handleToggle = async (rule: ComplianceRule) => {
    try {
      const updated = await updateRule(rule.id, {
        name: rule.name,
        description: rule.description,
        trigger_field: rule.trigger_field,
        operator: rule.operator,
        threshold: rule.threshold,
        action: rule.action,
        action_payload: rule.action_payload,
        cooldown_minutes: rule.cooldown_minutes,
        enabled: !rule.enabled,
      });
      setRules(r => r.map(x => x.id === updated.id ? updated : x));
    } catch {
      toast.error('Failed to toggle rule');
    }
  };

  const ruleEvents = (ruleId: string) => events.filter(e => e.rule_id === ruleId);

  const totals = {
    enabled: rules.filter(r => r.enabled).length,
    triggered: events.filter(e => e.status === 'triggered').length,
    skipped: events.filter(e => e.status === 'skipped').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-fg flex items-center gap-2.5">
            <ShieldAlert className="text-accent" size={22} />
            Compliance rules
          </h1>
          <p className="text-sm text-muted mt-1">
            Automatically dispatch commands when device metrics cross thresholds. Evaluated every 5 minutes.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => { setEditing(null); setShowForm(true); }} className="shrink-0">
          <Plus size={15} className="mr-1.5" /> New rule
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Active rules',     value: totals.enabled,   icon: Zap,      color: 'text-accent' },
          { label: 'Actions fired',    value: totals.triggered, icon: Activity, color: 'text-danger'  },
          { label: 'Cooldown skips',   value: totals.skipped,   icon: Clock,    color: 'text-warn'    },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-line bg-surface px-4 py-3 flex items-center gap-3">
            <s.icon size={18} className={s.color} />
            <div>
              <div className="text-xl font-semibold text-fg tabular">{s.value}</div>
              <div className="text-2xs text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Rules list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Rules ({rules.length})</h2>
          <button onClick={() => { fetchRules(); fetchEvents(); }} className="flex items-center gap-1 text-xs text-muted hover:text-fg transition-colors">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {loadingRules ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="skeleton h-16 rounded-xl" />)}
          </div>
        ) : rules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface/60 py-14 text-center">
            <ShieldAlert size={28} className="mx-auto text-faint mb-3" />
            <div className="text-sm font-medium text-fg">No compliance rules yet</div>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              Create a rule to automatically lock or wipe devices when their posture score drops.
            </p>
            <Button variant="ghost" size="sm" className="mt-4" onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus size={14} className="mr-1" /> Create first rule
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map(rule => {
              const re = ruleEvents(rule.id);
              const lastFired = re.find(e => e.status === 'triggered');
              const isExpanded = expandedRule === rule.id;
              const actionInfo = ACTIONS.find(a => a.value === rule.action);

              return (
                <div key={rule.id} className="rounded-xl border border-line bg-surface overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* Enabled dot */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rule.enabled ? 'bg-success' : 'bg-faint'}`} />

                    {/* Rule summary */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-fg truncate">{rule.name}</span>
                        {actionInfo && (
                          <span className={`text-2xs font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset ${ACTION_RISK[actionInfo.risk]}`}>
                            {rule.action}
                          </span>
                        )}
                        {!rule.enabled && (
                          <span className="text-2xs text-faint bg-surface-2 px-1.5 py-0.5 rounded-full ring-1 ring-inset ring-line">disabled</span>
                        )}
                      </div>
                      <div className="text-xs text-muted mt-0.5 font-mono">
                        IF {rule.trigger_field} {OP_LABELS[rule.operator] ?? rule.operator} {rule.threshold}
                        <span className="ml-2 text-faint">· cooldown {rule.cooldown_minutes}m</span>
                        {lastFired && <span className="ml-2 text-faint">· last fired {new Date(lastFired.created_at).toLocaleDateString()}</span>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleToggle(rule)}
                        title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                        className={`w-7 h-7 grid place-items-center rounded-lg transition-colors ${rule.enabled ? 'text-accent hover:bg-accent/10' : 'text-faint hover:bg-surface-2'}`}
                      >
                        {rule.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      </button>
                      <button
                        onClick={() => { setEditing(rule); setShowForm(true); }}
                        className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(rule)}
                        className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                      {re.length > 0 && (
                        <button
                          onClick={() => setExpandedRule(isExpanded ? null : rule.id)}
                          className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded events for this rule */}
                  {isExpanded && re.length > 0 && (
                    <div className="border-t border-line bg-surface-2/50 px-4 py-3">
                      <div className="text-2xs font-semibold uppercase tracking-wider text-faint mb-2">Recent events</div>
                      <div className="space-y-1.5">
                        {re.slice(0, 10).map(ev => (
                          <div key={ev.id} className="flex items-center gap-3 text-xs">
                            <span className={`text-2xs font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset shrink-0 ${STATUS_STYLES[ev.status]}`}>
                              {ev.status}
                            </span>
                            <span className="text-muted font-mono shrink-0">
                              {ev.trigger_value != null ? `${rule.trigger_field}=${ev.trigger_value}` : '—'}
                            </span>
                            <span className="text-muted truncate">{ev.device_id.slice(0, 8)}…</span>
                            <span className="text-faint ml-auto shrink-0 tabular">
                              {new Date(ev.created_at).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Global events log */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-fg">All events (last 200)</h2>
        </div>
        {loadingEvents ? (
          <div className="space-y-1.5">
            {[1,2,3,4,5].map(i => <div key={i} className="skeleton h-9 rounded-lg" />)}
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface/60 py-8 text-center">
            <Activity size={20} className="mx-auto text-faint mb-2" />
            <div className="text-xs text-muted">No events yet — the engine runs every 5 minutes</div>
          </div>
        ) : (
          <div className="rounded-xl border border-line overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-2/60">
                  <th className="text-left text-2xs font-semibold uppercase tracking-wider text-faint px-4 py-2.5 w-24">Status</th>
                  <th className="text-left text-2xs font-semibold uppercase tracking-wider text-faint px-3 py-2.5">Rule</th>
                  <th className="text-left text-2xs font-semibold uppercase tracking-wider text-faint px-3 py-2.5">Device</th>
                  <th className="text-left text-2xs font-semibold uppercase tracking-wider text-faint px-3 py-2.5">Value</th>
                  <th className="text-left text-2xs font-semibold uppercase tracking-wider text-faint px-3 py-2.5">Action</th>
                  <th className="text-right text-2xs font-semibold uppercase tracking-wider text-faint px-4 py-2.5">Time</th>
                </tr>
              </thead>
              <tbody className="rail divide-y divide-line">
                {events.map(ev => {
                  const ruleName = rules.find(r => r.id === ev.rule_id)?.name ?? ev.rule_id.slice(0, 8) + '…';
                  return (
                    <tr key={ev.id} className="hover:bg-surface-2/50 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className={`text-2xs font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset ${STATUS_STYLES[ev.status]}`}>
                          {ev.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted truncate max-w-[180px]">{ruleName}</td>
                      <td className="px-3 py-2.5 font-mono text-faint">{ev.device_id.slice(0, 8)}…</td>
                      <td className="px-3 py-2.5 font-mono text-fg tabular">
                        {ev.trigger_value != null ? ev.trigger_value : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`text-2xs font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset ${ACTION_RISK[ACTIONS.find(a => a.value === ev.action)?.risk ?? 'low']}`}>
                          {ev.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-faint tabular whitespace-nowrap">
                        {new Date(ev.created_at).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rule form modal */}
      {showForm && (
        <RuleForm
          initial={editing ? {
            name: editing.name,
            description: editing.description,
            trigger_field: editing.trigger_field,
            operator: editing.operator,
            threshold: editing.threshold,
            action: editing.action,
            action_payload: editing.action_payload,
            cooldown_minutes: editing.cooldown_minutes,
            enabled: editing.enabled,
          } : undefined}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          saving={saving}
        />
      )}
    </div>
  );
}
