import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listGroups, createGroup, updateGroup, deleteGroup, type DeviceGroup } from '../api/groups';
import { listPolicies, listAssignmentsFor, assignPolicy, unassignPolicy } from '../api/policies';
import { broadcastCommand } from '../api/devices';
import { useCan } from '../lib/rbac';
import { toast } from '../components/toast';
import { Card, Button, IconButton, Badge, Panel, SectionHeading, Field, Input, Textarea, Select, PageHero, HeroStat, Hairline, Modal, ModalHeader, ModalBody, ModalFooter } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { Donut, chartColor } from '../components/charts';
import { Layers, Smartphone, ShieldCheck, Plus, Users, MessageSquare, Pencil, Trash2, FileCheck2, X, Send, PieChart, Lock, Power, RefreshCw, Radio, Bell } from 'lucide-react';

export function Groups() {
  const qc = useQueryClient();
  const canEdit = useCan('group:manage');
  const canAssign = useCan('policy:assign');
  const canMessage = useCan('command:issue:basic');

  const { data: groups, isLoading } = useQuery({ queryKey: ['groups'], queryFn: listGroups, refetchInterval: 8000 });
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });

  // Fetch every policy's assignments once, then index group_id → [policies] so
  // each group card can show (and unassign) the policies targeting it.
  const policyIDs = (policies ?? []).map(p => p.id);
  const { data: assignments } = useQuery({
    queryKey: ['all-policy-assignments', policyIDs],
    enabled: policyIDs.length > 0,
    refetchInterval: 8000,
    queryFn: async () => {
      const rows = await Promise.all(policyIDs.map(id => listAssignmentsFor(id).then(items => ({ id, items }))));
      return rows;
    }
  });
  const policyName = useMemo(() => new Map((policies ?? []).map(p => [p.id, `${p.name} (v${p.version})`])), [policies]);
  const groupPolicies = useMemo(() => {
    const m = new Map<string, { policyID: string }[]>();
    (assignments ?? []).forEach(({ id, items }) => {
      items.filter(a => a.target_kind === 'group' && a.target_id).forEach(a => {
        const arr = m.get(a.target_id!) ?? [];
        arr.push({ policyID: id });
        m.set(a.target_id!, arr);
      });
    });
    return m;
  }, [assignments]);

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  const create = useMutation({
    mutationFn: () => createGroup(name.trim(), desc.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['groups'] }); setName(''); setDesc(''); toast.success('Group created'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Create failed')
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['groups'] }); toast.success('Group deleted'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Delete failed')
  });

  const groupCount = groups?.length ?? 0;
  const deviceTotal = (groups ?? []).reduce((acc, g) => acc + (g.device_count ?? 0), 0);
  const coveredGroups = (groups ?? []).filter(g => (groupPolicies.get(g.id) ?? []).length > 0).length;

  return (
    <div className="space-y-5">
      <PageHero
        icon={Layers}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" style={{ animation: 'onlinePulse 2s infinite' }} /> Fleet segmentation</>}
        title="Groups"
        subtitle="Classify devices (e.g. Employees, Interns). A policy assigned to a group applies to every device in it."
        stats={<>
          <HeroStat icon={Layers} label="Groups" value={groupCount} tone="accent" />
          <HeroStat icon={Smartphone} label="Devices" value={deviceTotal} tone="info" />
          <HeroStat icon={ShieldCheck} label="With policy" value={coveredGroups} tone="success" />
        </>}
      />

      {canEdit && (
        <Panel
          icon={Plus}
          title="Create a group"
          subtitle="Name a segment, then assign it a policy below."
          className="card-grad overflow-hidden ring-1 ring-inset ring-line animate-slideup [animation-delay:60ms]"
          bodyClassName="relative"
        >
          <Hairline />
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <Field label="Name">
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Employees" />
              </Field>
            </div>
            <div className="flex-1 min-w-[200px]">
              <Field label="Description" hint="Optional — what kind of devices belong here.">
                <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Full-time staff devices" />
              </Field>
            </div>
            <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              <Plus size={15} />
              Create group
            </Button>
          </div>
        </Panel>
      )}

      {!isLoading && groupCount > 0 && (
        <Panel
          icon={PieChart}
          title="Policy coverage"
          subtitle="How many of your groups have at least one policy assigned."
          className="card-grad overflow-hidden ring-1 ring-inset ring-line animate-slideup [animation-delay:90ms]"
          bodyClassName="relative"
        >
          <Hairline />
          <div className="flex flex-wrap items-center gap-6">
            <Donut
              segments={[
                { value: coveredGroups, color: chartColor.accent, label: 'With policy' },
                { value: groupCount - coveredGroups, color: chartColor.muted, label: 'No policy' },
              ]}
              center={<>
                <div className="text-xl font-semibold text-fg tabular-nums leading-none">{Math.round((coveredGroups / groupCount) * 100)}%</div>
                <div className="text-2xs text-faint mt-1">covered</div>
              </>}
            />
            <ul className="space-y-2.5 min-w-[160px]">
              <li className="flex items-center justify-between gap-6">
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  <span className="h-2.5 w-2.5 rounded-sm bg-accent" />
                  With policy
                </span>
                <span className="text-fg font-medium tabular-nums">{coveredGroups}</span>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  <span className="h-2.5 w-2.5 rounded-sm bg-faint" />
                  No policy
                </span>
                <span className="text-fg font-medium tabular-nums">{groupCount - coveredGroups}</span>
              </li>
              <li className="flex items-center justify-between gap-6 border-t border-line pt-2.5">
                <span className="inline-flex items-center gap-2 text-2xs uppercase tracking-wider text-faint">
                  <Layers size={12} />
                  Total groups
                </span>
                <span className="text-fg font-medium tabular-nums">{groupCount}</span>
              </li>
            </ul>
          </div>
        </Panel>
      )}

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-3">
                <div className="skeleton h-10 w-10 rounded-xl shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-32 rounded" />
                  <div className="skeleton h-3 w-48 rounded" />
                  <div className="skeleton h-5 w-20 rounded-full" />
                </div>
              </div>
              <div className="mt-4 h-px bg-line" />
              <div className="mt-3 space-y-1.5">
                <div className="skeleton h-3 w-24 rounded" />
                <div className="skeleton h-8 w-full rounded-lg" />
              </div>
            </Card>
          ))}
        </div>
      )}
      {!isLoading && groups?.length === 0 && (
        <Card className="card-grad relative overflow-hidden ring-1 ring-inset ring-line animate-fadein">
          <Hairline />
          <div className="flex flex-col items-center justify-center text-center py-14 px-6">
            <div className="grid place-items-center h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_10px_28px_-8px_rgba(99,102,241,0.7)] ring-1 ring-white/20 mb-3">
              <Layers size={20} />
            </div>
            <div className="text-sm font-medium text-fg">No groups yet</div>
            <p className="text-xs text-muted mt-1 max-w-sm">{canEdit ? 'Create one above to start classifying your devices — then assign it a policy.' : 'Groups will appear here once an admin creates them.'}</p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {groups?.map((g, i) => (
          <GroupCard
            key={g.id}
            group={g}
            index={i}
            canEdit={canEdit}
            canAssign={canAssign}
            canMessage={canMessage}
            policyOptions={(policies ?? []).map(p => ({ id: p.id, label: `${p.name} (v${p.version})` }))}
            assignedPolicies={(groupPolicies.get(g.id) ?? []).map(x => ({ id: x.policyID, label: policyName.get(x.policyID) ?? x.policyID.slice(0, 8) }))}
            onDelete={async () => {
              if (await confirmDialog({
                title: `Delete group “${g.name}”?`,
                message: 'Devices in this group will fall back to the tenant-level policy.',
                confirmLabel: 'Delete group', icon: Trash2,
              })) remove.mutate(g.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function GroupCard({ group, index, canEdit, canAssign, canMessage, policyOptions, assignedPolicies, onDelete }: {
  group: DeviceGroup;
  index: number;
  canEdit: boolean;
  canAssign: boolean;
  canMessage: boolean;
  policyOptions: { id: string; label: string }[];
  assignedPolicies: { id: string; label: string }[];
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [pick, setPick] = useState('');
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgTitle, setMsgTitle] = useState('Message from IT');
  const [msgBody, setMsgBody] = useState('');

  const broadcast = useMutation({
    mutationFn: () => broadcastCommand(group.id, 'SHOW_MESSAGE', { title: msgTitle.trim() || 'Message', message: msgBody.trim() }),
    onSuccess: (n) => { setMsgOpen(false); setMsgBody(''); toast.success(`Message sent to ${n} device${n === 1 ? '' : 's'}`); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Send failed')
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['all-policy-assignments'] });
  };
  const save = useMutation({
    mutationFn: () => updateGroup(group.id, { name: name.trim(), description: desc.trim() }),
    onSuccess: () => { invalidate(); setEditing(false); toast.success('Group updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'group', group.id),
    onSuccess: () => { invalidate(); setPick(''); toast.success('Policy assigned to group — devices will reconcile'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Assign failed')
  });
  const unassign = useMutation({
    mutationFn: (policyID: string) => unassignPolicy(policyID, 'group', group.id),
    onSuccess: () => { invalidate(); toast.success('Policy unassigned'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Unassign failed')
  });

  const assignedIDs = new Set(assignedPolicies.map(p => p.id));
  const available = policyOptions.filter(p => !assignedIDs.has(p.id));

  return (
    <Card
      className="card-grad group relative overflow-hidden p-4 space-y-3 ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md animate-slideup"
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <Hairline className="opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      {!editing ? (
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <span className="grid place-items-center h-10 w-10 shrink-0 rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 transition-colors group-hover:bg-accent/15">
              <Users size={18} />
            </span>
            <div className="min-w-0">
              <div className="font-medium text-fg truncate">{group.name}</div>
              {group.description && <div className="text-xs text-muted truncate">{group.description}</div>}
              <div className="mt-1.5">
                <Badge tone={group.device_count > 0 ? 'info' : 'muted'}>
                  <Smartphone size={11} />
                  <span className="tabular-nums">{group.device_count}</span> device{group.device_count === 1 ? '' : 's'}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex gap-1 shrink-0">
            {canMessage && (
              <IconButton label="Message group" onClick={() => { setMsgTitle('Message from IT'); setMsgOpen(true); }}>
                <MessageSquare size={15} />
              </IconButton>
            )}
            {canEdit && (
              <>
                <IconButton label="Edit group" onClick={() => { setName(group.name); setDesc(group.description ?? ''); setEditing(true); }}>
                  <Pencil size={15} />
                </IconButton>
                <IconButton label="Delete group" onClick={onDelete} className="hover:text-danger hover:bg-danger/10">
                  <Trash2 size={15} />
                </IconButton>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid place-items-center h-10 w-10 shrink-0 rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/15">
              <Pencil size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-fg leading-tight">Editing group</div>
              <div className="text-2xs text-faint truncate">Update the name or description, then save.</div>
            </div>
          </div>
          <Field label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Group name" />
          </Field>
          <Field label="Description" hint="Optional — what kind of devices belong here.">
            <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Full-time staff devices" />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="border-t border-line pt-3">
        <SectionHeading
          icon={ShieldCheck}
          title="Policies on this group"
          hint={assignedPolicies.length > 0 ? `${assignedPolicies.length} assigned · applies to every device` : undefined}
          className="mb-2.5"
        />
        {assignedPolicies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface-2/30 px-3 py-2.5 text-xs text-faint">
            No policy assigned — devices fall back to the tenant-level policy.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {assignedPolicies.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-accent/[0.06] ring-1 ring-inset ring-accent/20 px-2.5 py-1.5 text-sm">
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className="grid place-items-center h-5 w-5 shrink-0 rounded-md bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
                    <FileCheck2 size={11} />
                  </span>
                  <span className="truncate text-fg font-medium">{p.label}</span>
                </span>
                {canAssign && (
                  <button onClick={() => unassign.mutate(p.id)} disabled={unassign.isPending}
                          className="inline-flex items-center gap-1 text-2xs text-faint hover:text-danger transition-colors shrink-0 disabled:opacity-40">
                    <X size={12} />remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAssign && available.length > 0 && (
          <div className="flex items-center gap-2 mt-2.5">
            <Select value={pick} onChange={e => setPick(e.target.value)} className="flex-1">
              <option value="">Assign a policy…</option>
              {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <Button variant="primary" size="sm" disabled={!pick || assign.isPending} onClick={() => assign.mutate(pick)}>
              <Plus size={14} />Assign
            </Button>
          </div>
        )}
      </div>

      {/* ── Group bulk actions ── */}
      {canMessage && group.device_count > 0 && (
        <GroupActions group={group} />
      )}

      {msgOpen && (
        <Modal onClose={() => setMsgOpen(false)} label={`Message everyone in ${group.name}`} width="max-w-md">
          <ModalHeader
            icon={MessageSquare}
            title={<>Message everyone in “{group.name}”</>}
            subtitle={
              <span className="flex items-center gap-1.5">
                <Smartphone size={12} className="text-faint" />
                <span className="tabular-nums">{group.device_count}</span> device{group.device_count === 1 ? '' : 's'} will receive a pop-up.
              </span>
            }
            onClose={() => setMsgOpen(false)}
          />
          <ModalBody className="space-y-3 p-5">
            <Field label="Title">
              <Input value={msgTitle} onChange={e => setMsgTitle(e.target.value)} placeholder="Message from IT" />
            </Field>
            <Field label="Message" hint="Shown as a pop-up dialog on each device.">
              <Textarea autoFocus value={msgBody} onChange={e => setMsgBody(e.target.value)} placeholder="Message…" rows={4} />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="sm" onClick={() => setMsgOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!msgBody.trim() || broadcast.isPending} onClick={() => broadcast.mutate()}>
              <Send size={14} />
              {broadcast.isPending ? 'Sending…' : 'Send to group'}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </Card>
  );
}

// ─── Group bulk action buttons ───────────────────────────────────────────────

type BulkAction = {
  kind: string;
  label: string;
  icon: React.ReactNode;
  confirm: (groupName: string, count: number) => { title: string; message: string };
  payload?: Record<string, unknown>;
  danger?: boolean;
};

const BULK_ACTIONS: BulkAction[] = [
  {
    kind: 'SYNC_POLICY',
    label: 'Sync policy',
    icon: <RefreshCw size={13} />,
    confirm: (n, c) => ({
      title: `Sync policy on ${n}?`,
      message: `Sends SYNC_POLICY to all ${c} device${c === 1 ? '' : 's'} — each will re-fetch and re-apply the latest assigned policy.`,
    }),
  },
  {
    kind: 'PUSH_TELEMETRY',
    label: 'Push telemetry',
    icon: <Radio size={13} />,
    confirm: (n, c) => ({
      title: `Request telemetry from ${n}?`,
      message: `Sends PUSH_TELEMETRY to ${c} device${c === 1 ? '' : 's'} — each will immediately upload a fresh heartbeat snapshot.`,
    }),
  },
  {
    kind: 'PLAY_SOUND',
    label: 'Ring devices',
    icon: <Bell size={13} />,
    confirm: (n, c) => ({
      title: `Ring all devices in ${n}?`,
      message: `Plays a loud alert on ${c} device${c === 1 ? '' : 's'}. Use to locate misplaced devices.`,
    }),
    payload: { duration_ms: 10000 },
  },
  {
    kind: 'LOCK',
    label: 'Lock all',
    icon: <Lock size={13} />,
    danger: true,
    confirm: (n, c) => ({
      title: `Lock all devices in ${n}?`,
      message: `Locks the screen on ${c} device${c === 1 ? '' : 's'} immediately. Users will need their PIN to unlock.`,
    }),
  },
  {
    kind: 'REBOOT',
    label: 'Reboot all',
    icon: <Power size={13} />,
    danger: true,
    confirm: (n, c) => ({
      title: `Reboot all devices in ${n}?`,
      message: `Reboots ${c} device${c === 1 ? '' : 's'}. All running apps will close. Device Owner only — others will silently skip.`,
    }),
  },
];

function GroupActions({ group }: { group: DeviceGroup }) {
  const [busy, setBusy] = useState<string | null>(null);

  const fire = async (action: BulkAction) => {
    const { title, message } = action.confirm(group.name, group.device_count);
    const ok = await confirmDialog({ title, message, confirmLabel: action.label });
    if (!ok) return;
    setBusy(action.kind);
    try {
      const n = await broadcastCommand(group.id, action.kind, action.payload ?? {});
      toast.success(`${action.label}: dispatched to ${n} device${n === 1 ? '' : 's'}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || `${action.label} failed`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-line pt-3">
      <SectionHeading
        icon={Layers}
        title="Group actions"
        hint="Apply a command to every device in this group at once."
        className="mb-2.5"
      />
      <div className="flex flex-wrap gap-1.5">
        {BULK_ACTIONS.map(a => (
          <button
            key={a.kind}
            disabled={busy !== null}
            onClick={() => fire(a)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              a.danger
                ? 'border-danger/30 bg-danger/5 text-danger hover:bg-danger/15'
                : 'border-line bg-surface-2 text-fg hover:bg-surface-3'
            }`}
          >
            {busy === a.kind ? <RefreshCw size={12} className="animate-spin" /> : a.icon}
            {busy === a.kind ? `${a.label}…` : a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
