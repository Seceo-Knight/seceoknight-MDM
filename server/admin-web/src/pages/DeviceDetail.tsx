import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deviceTelemetryLatest, getDevice, issueCommand,
  latestResultByKind, listDeviceCommands, listDeviceEvents, retireDevice,
  updateDeviceAlias,
  type ActivityEvent, type CommandRow, type Device
} from '../api/devices';
import {
  assignPolicy, listAssignmentsForDevice, listPolicies, resolvedPolicyForDevice,
  unassignPolicy, type PolicyAssignment
} from '../api/policies';
import { listDevicePhotos, presignPhoto, deletePhoto } from '../api/photos';
import { listDeviceAudios, presignAudio, deleteAudio, deleteAudioSession, parseAudioName, newSessionId, sessionAudioUrl } from '../api/audio';
import { uploadFile, type FileObject } from '../api/files';
import { listGroups, setDeviceGroup } from '../api/groups';
import { getEnrollmentConfig } from '../api/enrollment';
import { formatRelative, isOnline } from '../components/online';
import { toast } from '../components/toast';
import { ModeBadge, ModeCapabilityCard, PostureBadge, PostureCard, modeAllows, modeRequirement, normalizeMode } from '../components/DeviceMode';
import { useCan } from '../lib/rbac';
import {
  cn, Badge, Button, Input, Select, Textarea, SectionHeading, Skeleton as UiSkeleton,
  Modal, ModalBody, ModalFooter, Hairline
} from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { ScreenTab } from '../components/ScreenTab';
import { useColumnWidths, ColResizeHandle } from '../components/ResizableColumns';
import {
  Smartphone, ChevronRight, BatteryCharging, BatteryMedium, Wifi, ShieldCheck,
  Clock, Lock, RefreshCw, Power, KeyRound, Eraser, Flashlight, BellRing,
  MapPin, ScanLine, PackageSearch, MessageSquare, LayoutGrid, ShieldHalf,
  AppWindow, Camera, Mic, Activity as ActivityIcon, Terminal, HardDrive, MonitorSmartphone,
  Cpu, Network, Fingerprint, AlertTriangle, MoreHorizontal, Square, Pause, Play,
  DownloadCloud, Trash2, UploadCloud, Github, ArrowUp, ArrowDown, ArrowUpDown
} from 'lucide-react';

type TabId = 'overview' | 'policy' | 'apps' | 'photos' | 'audio' | 'screen' | 'activity' | 'commands';
// Mirrors the (unexported) Badge tone union in ../components/ui.
type BadgeTone = 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'muted';

export function DeviceDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('overview');

  const { data: device } = useQuery({
    queryKey: ['device', id], queryFn: () => getDevice(id), refetchInterval: 5000
  });
  const { data: commands } = useQuery({
    queryKey: ['commands', id], queryFn: () => listDeviceCommands(id), refetchInterval: 3000
  });
  const { data: telemetry } = useQuery({
    queryKey: ['telemetry', id], queryFn: () => deviceTelemetryLatest(id).catch(() => null),
    refetchInterval: 15000
  });

  const cmd = useMutation({
    mutationFn: ({ kind, payload }: { kind: string; payload?: Record<string, unknown> }) =>
      issueCommand(id, kind, payload),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['commands', id] });
      toast.info(`${vars.kind} queued`);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || `Failed to queue command`)
  });
  const retire = useMutation({
    mutationFn: () => retireDevice(id),
    onSuccess: () => {
      toast.success('Device retired');
      // The device we're viewing is now retired (soft-deleted) and the detail
      // query will start 404ing — send the operator back to the list instead
      // of stranding them on a dead page.
      qc.invalidateQueries({ queryKey: ['devices'] });
      navigate('/devices');
    },
    onError:   () => toast.error('Retire failed')
  });

  // Auto-fetch device info on first load if missing
  const deviceInfo  = latestResultByKind(commands, 'FETCH_DEVICE_INFO');
  const appInventory = latestResultByKind(commands, 'FETCH_APP_INVENTORY');
  const appUsage    = latestResultByKind(commands, 'FETCH_APP_USAGE');
  useEffect(() => {
    if (!commands || !device || deviceInfo) return;
    const recent = commands.find(c =>
      c.kind === 'FETCH_DEVICE_INFO' &&
      Date.now() - new Date(c.created_at).getTime() < 60_000
    );
    if (!recent) cmd.mutate({ kind: 'FETCH_DEVICE_INFO' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands?.length, device?.id]);

  const online = isOnline(device?.last_heartbeat_at);

  if (!device) return <Skeleton />;

  const heroName = device.alias?.trim() || `${device.manufacturer || 'Device'} ${device.model || ''}`.trim();
  const heroIdentity = `${device.manufacturer || ''} ${device.model || ''}`.trim();

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-sm animate-fadein">
        {/* static aura wash */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.6] dark:opacity-50">
          <div className="absolute -top-24 -left-16 h-64 w-64 rounded-full bg-gradient-to-br from-indigo-500/30 to-violet-600/20 blur-3xl" />
          <div className="absolute -bottom-28 right-0 h-72 w-72 rounded-full bg-gradient-to-tr from-violet-600/20 to-sky-500/10 blur-3xl" />
        </div>
        <div className="relative p-5 sm:p-6">
          <div className="text-2xs text-muted flex items-center gap-1">
            <Link to="/devices" className="hover:text-fg transition-colors">Devices</Link>
            <ChevronRight className="w-3 h-3 text-faint" />
            <span className="text-faint truncate">{heroName}</span>
          </div>

          <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-4 min-w-0">
              {/* device icon chip */}
              <div className="relative shrink-0">
                <div className="grid place-items-center h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md">
                  <Smartphone className="w-7 h-7" />
                </div>
                <span className={cn(
                  'absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-surface',
                  online ? 'bg-success' : 'bg-faint'
                )} />
              </div>
              <div className="min-w-0">
                <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight truncate"
                   >
                  {heroName}
                </h1>
                <div className="text-sm text-muted mt-1 flex items-center gap-2 flex-wrap">
                  {heroIdentity && <span>{heroIdentity}</span>}
                  {heroIdentity && <span className="text-faint">·</span>}
                  <span className="font-mono text-2xs px-1.5 py-0.5 rounded bg-surface-2 text-muted">{device.serial_number ?? device.id}</span>
                  {device.created_at && <span className="text-faint">·</span>}
                  {device.created_at && (
                    <span title={`Added to the platform ${new Date(device.created_at).toLocaleString()}`}>
                      Enrolled {new Date(device.created_at).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                  <ConnectionPill online={online} lastHeartbeat={device.last_heartbeat_at} />
                  <StateBadge state={device.state} />
                  <ModeBadge mode={device.last_mgmt_mode ?? device.management_mode} />
                  {device.enrollment_channel && <ChannelBadge channel={device.enrollment_channel} />}
                  <PostureBadge score={device.last_posture_score} />
                </div>
              </div>
            </div>

            <Button
              variant="danger"
              onClick={async () => {
                if (await confirmDialog({
                  title: 'Retire this device?',
                  message: 'The device is removed from management and stops receiving policies and commands. This cannot be undone from the console.',
                  confirmLabel: 'Retire device', icon: Eraser,
                })) retire.mutate();
              }}
              disabled={retire.isPending}>
              <Eraser className="w-4 h-4" /> Retire
            </Button>
          </div>

          {/* at-a-glance chips */}
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <HeroChip
              icon={device.last_charging ? <BatteryCharging className="w-4 h-4" /> : <BatteryMedium className="w-4 h-4" />}
              label="Battery"
              value={device.last_battery_pct != null ? `${device.last_battery_pct}%` : '—'}
              sub={device.last_charging ? 'charging' : undefined}
              tone={device.last_battery_pct != null && device.last_battery_pct <= 15 ? 'danger' : 'accent'}
            />
            <HeroChip
              icon={<Wifi className="w-4 h-4" />}
              label="Network"
              value={device.last_network_type ?? '—'}
              sub={device.last_wifi_ssid ?? undefined}
              tone="info"
            />
            <HeroChip
              icon={<ShieldCheck className="w-4 h-4" />}
              label="Posture"
              value={device.last_posture_score != null ? `${device.last_posture_score}` : '—'}
              tone={device.last_posture_score != null && device.last_posture_score < 60 ? 'warn' : 'success'}
            />
            <HeroChip
              icon={<Clock className="w-4 h-4" />}
              label="Last seen"
              value={device.last_heartbeat_at ? formatRelative(device.last_heartbeat_at) : 'never'}
              tone="muted"
            />
          </div>

          <div className="mt-4 pt-4 border-t border-line/70 flex items-center gap-4 flex-wrap">
            <AliasEditor device={device} />
            <GroupSelector device={device} />
          </div>
        </div>
      </section>

      <Tabs current={tab} onSelect={setTab} commands={commands} mode={device.last_mgmt_mode} />

      {tab === 'overview' && <OverviewTab device={device} info={deviceInfo} cmd={cmd} telemetry={telemetry ?? null} />}
      {tab === 'policy'   && <PolicyTab   deviceID={id} cmd={cmd} />}
      {tab === 'apps'     && <AppsTab    deviceID={id} inventory={appInventory} cmd={cmd} mode={device.last_mgmt_mode} />}
      {tab === 'photos'   && <PhotosTab  deviceID={id} cmd={cmd} />}
      {tab === 'audio'    && <AudiosTab  deviceID={id} cmd={cmd} />}
      {tab === 'screen'   && <ScreenTab  deviceID={id} cmd={cmd} mode={device.last_mgmt_mode} />}
      {tab === 'activity' && <ActivityTab deviceID={id} usage={appUsage} cmd={cmd} mode={device.last_mgmt_mode} />}
      {tab === 'commands' && <CommandsTab commands={commands} />}
    </div>
  );
}

// AliasEditor renders the device's friendly name inline. super_admin/admin get
// an editable field; everyone else sees it read-only (matching the server route
// guard). Saving fires PATCH /devices/:id, which audit-logs who made the change.
function AliasEditor({ device }: { device: Device }) {
  const qc = useQueryClient();
  const canEdit = useCan('device:update');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.alias ?? '');

  const save = useMutation({
    mutationFn: (alias: string) => updateDeviceAlias(device.id, alias),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device', device.id] });
      qc.invalidateQueries({ queryKey: ['devices'] });
      toast.success('Alias updated');
      setEditing(false);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to update alias')
  });

  if (!canEdit) {
    // Read-only: only show a line if an alias actually exists.
    if (!device.alias?.trim()) return null;
    return <div className="text-xs text-faint mt-1">Alias set by an administrator.</div>;
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setValue(device.alias ?? ''); setEditing(true); }}
        className="text-xs text-accent hover:underline mt-1 inline-block">
        {device.alias?.trim() ? 'Edit alias' : '+ Add an alias'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-1.5">
      <Input
        autoFocus
        value={value}
        maxLength={120}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save.mutate(value);
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder="e.g. Reception iPad"
        className="w-56 h-8 py-1.5" />
      <Button variant="primary" size="sm" onClick={() => save.mutate(value)} disabled={save.isPending}>Save</Button>
      <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
    </div>
  );
}

// GroupSelector shows (and, for super_admin/admin, lets you change) the device's
// group. Assigning a group makes any group-level policy apply to this device —
// visible immediately in the Policy tab's layered assignments.
function GroupSelector({ device }: { device: Device }) {
  const qc = useQueryClient();
  const canEdit = useCan('device:update');
  const { data: groups } = useQuery({ queryKey: ['groups'], queryFn: listGroups });

  const change = useMutation({
    mutationFn: (groupID: string) => setDeviceGroup(device.id, groupID),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device', device.id] });
      qc.invalidateQueries({ queryKey: ['device-assignments', device.id] });
      qc.invalidateQueries({ queryKey: ['resolved-policy', device.id] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      toast.success('Group updated');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to set group')
  });

  const current = groups?.find(g => g.id === device.group_id);

  if (!canEdit) {
    return <span className="text-xs text-muted">Group: <b>{current?.name ?? 'none'}</b></span>;
  }
  return (
    <label className="text-xs text-muted flex items-center gap-1.5">
      Group:
      <Select
        value={device.group_id ?? ''}
        onChange={e => change.mutate(e.target.value)}
        disabled={change.isPending}
        className="w-auto h-8 py-1.5">
        <option value="">none</option>
        {groups?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </Select>
    </label>
  );
}

function Tabs({ current, onSelect, commands, mode }: {
  current: TabId;
  onSelect: (t: TabId) => void;
  commands: CommandRow[] | undefined;
  mode?: string | null;
}) {
  const pendingCount = (commands || []).filter(c =>
    c.state === 'pending' || c.state === 'dispatched' || c.state === 'acknowledged'
  ).length;
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; hint?: string }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutGrid className="w-4 h-4" /> },
    { id: 'policy',   label: 'Policy',   icon: <ShieldHalf className="w-4 h-4" /> },
    { id: 'apps',     label: 'Apps',     icon: <AppWindow className="w-4 h-4" /> },
    { id: 'photos',   label: 'Photos & Location', icon: <Camera className="w-4 h-4" /> },
    { id: 'audio',    label: 'Audio',    icon: <Mic className="w-4 h-4" /> },
    // Live screen mirror — fully-managed (Device Owner / Stealth) only.
    ...(modeAllows(mode, 'screen_mirror')
      ? [{ id: 'screen' as TabId, label: 'Screen', icon: <MonitorSmartphone className="w-4 h-4" /> }]
      : []),
    { id: 'activity', label: 'Activity', icon: <ActivityIcon className="w-4 h-4" /> },
    { id: 'commands', label: 'Commands', icon: <Terminal className="w-4 h-4" />, hint: pendingCount > 0 ? `${pendingCount}` : undefined }
  ];
  return (
    // Negative margins mirror the page container's responsive padding exactly
    // (px-5 / sm:px-6 / lg:px-8) so the sticky bar bleeds edge-to-edge without
    // causing horizontal overflow on small screens.
    <div className="sticky top-0 z-10 -mx-5 px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 py-2 bg-bg/80 backdrop-blur-md">
      <nav role="tablist" aria-label="Device sections"
           className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface-2/60 p-1 shadow-xs">
        {tabs.map(t => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(t.id)}
              className={cn(
                'relative inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm whitespace-nowrap transition-all',
                active
                  ? 'bg-surface text-accent font-medium shadow-xs ring-1 ring-line'
                  : 'text-muted hover:text-fg hover:bg-surface/60'
              )}>
              <span className={cn('transition-colors', active ? 'text-accent' : 'text-faint')}>{t.icon}</span>
              {t.label}
              {t.hint && (
                <span className="ml-0.5 text-2xs px-1.5 py-0.5 rounded-full bg-accent text-accent-fg font-semibold">{t.hint}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ============================== Overview Tab ============================== */

function OverviewTab({
  device, info, telemetry, cmd
}: {
  device: Device;
  info: Record<string, unknown> | null;
  telemetry: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  // Prefer the live heartbeat mode; fall back to the enroll-time role until the
  // first heartbeat lands (so work-profile gating is correct immediately).
  const m = device.last_mgmt_mode ?? device.management_mode;
  const canBasic = useCan('command:issue:basic');
  const canPriv = useCan('command:issue:privileged');
  // Combine device-capability (mode) gating with user-permission (RBAC) gating.
  const gate = (modeOK: boolean, permOK: boolean, modeMsg?: string) => ({
    disabled: !modeOK || !permOK,
    title: !permOK ? 'Your role cannot issue this command' : modeMsg
  });
  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="OS" value={device.os_version ?? '—'} hint={device.security_patch_level ? `patch ${device.security_patch_level}` : undefined} />
        <Stat label="Applied policy" value={`v${device.applied_policy_version}`} />
        <Stat
          label="Battery"
          // device.last_battery_pct is refreshed by the agent's 60s heartbeat
          // and re-fetched by the parent useQuery every 5s, so this updates
          // live. The FETCH_DEVICE_INFO `info` snapshot is a one-shot run on
          // page load and would otherwise show stale values forever.
          value={device.last_battery_pct != null ? `${device.last_battery_pct}%` : (info ? `${info.battery_pct}%` : '—')}
          hint={device.last_charging ?? info?.charging ? 'charging' : undefined}
        />
        <Stat label="Network" value={device.last_network_type ?? (info?.network as string) ?? '—'} />
        <Stat
          label="Agent version"
          value={device.agent_version ?? (info?.agent_version as string) ?? '—'}
          hint={device.agent_version_code != null ? `build ${device.agent_version_code}` : undefined}
        />
      </section>

      <ModeCapabilityCard mode={device.last_mgmt_mode ?? device.management_mode} />

      <PostureCard score={device.last_posture_score} factors={device.last_posture_factors} at={device.last_posture_at} />

      <PolicyCard deviceID={device.id} cmd={cmd} />

      {/* Remote actions */}
      <SectionCard icon={<Terminal className="w-[18px] h-[18px]" />} title="Remote actions"
                   subtitle="Commands queue immediately and execute on next device check-in">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-x-5 gap-y-4">
          <ActionGroup title="Maintenance" icon={<RefreshCw className="w-3.5 h-3.5" />}>
            <ActionBtn label="Lock screen" icon={<Lock className="w-4 h-4" />} onClick={() => cmd.mutate({ kind: 'LOCK' })}
                       {...gate(modeAllows(m, 'lock'), canBasic, modeRequirement(m, 'lock'))} />
            <ActionBtn label="Reboot" icon={<Power className="w-4 h-4" />} onClick={() => cmd.mutate({ kind: 'REBOOT' })}
                       {...gate(modeAllows(m, 'reboot'), canPriv, modeRequirement(m, 'reboot'))} />
            <UpdateAgentBtn cmd={cmd}
                       {...gate(modeAllows(m, 'app_manage'), canPriv, modeRequirement(m, 'app_manage'))} />
          </ActionGroup>
          <ActionGroup title="Security" icon={<ShieldHalf className="w-3.5 h-3.5" />}>
            <ResetPasswordBtn onSubmit={(pw) => cmd.mutate({ kind: 'RESET_PASSWORD', payload: { password: pw } })}
                              {...gate(modeAllows(m, 'reset_password'), canPriv, modeRequirement(m, 'reset_password'))} />
            <WipeBtn onConfirm={() => cmd.mutate({ kind: 'WIPE', payload: { external_storage: true, reset_protection: true } })}
                     {...gate(modeAllows(m, 'wipe'), canPriv, modeRequirement(m, 'wipe'))} />
            <RemoveWorkProfileBtn onConfirm={() => cmd.mutate({ kind: 'REMOVE_WORK_PROFILE' })}
                     {...gate(modeAllows(m, 'remove_work_profile'), canPriv, modeRequirement(m, 'remove_work_profile'))} />
          </ActionGroup>
          <ActionGroup title="Asset recovery" icon={<MapPin className="w-3.5 h-3.5" />}>
            <FlashlightToggle cmd={cmd} disabled={!canBasic} />
            <ActionBtn label="Play alarm sound" icon={<BellRing className="w-4 h-4" />} onClick={() => cmd.mutate({ kind: 'PLAY_SOUND', payload: { duration_ms: 15000 } })}
                       {...gate(true, canBasic)} />
            <ActionBtn label="Get location" icon={<MapPin className="w-4 h-4" />} onClick={() => cmd.mutate({ kind: 'GET_LOCATION' })}
                       {...gate(true, canBasic)} />
          </ActionGroup>
          <ActionGroup title="Inventory" icon={<PackageSearch className="w-3.5 h-3.5" />}>
            <ActionBtn label="Refresh device info" icon={<ScanLine className="w-4 h-4" />}   onClick={() => cmd.mutate({ kind: 'FETCH_DEVICE_INFO' })}
                       {...gate(true, canBasic)} />
            <ActionBtn label="Refresh app inventory" icon={<PackageSearch className="w-4 h-4" />} onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })}
                       {...gate(true, canBasic)} />
            <SendMessageBtn
              disabled={!canBasic}
              title={canBasic ? undefined : 'Your role cannot send messages'}
              onSend={(t, m) => cmd.mutate({ kind: 'SHOW_MESSAGE', payload: { title: t, message: m } })} />
          </ActionGroup>
        </div>
      </SectionCard>

      <LiveLocationCard device={device} />

      <AgentPermissionsCard info={info} cmd={cmd} canFetch={canBasic} />

      <DeviceInfoCard device={device} info={info} />

      {telemetry && Object.keys(telemetry).length > 0 && (
        <SectionCard icon={<ActivityIcon className="w-[18px] h-[18px]" />} title="Latest telemetry" tone="info">
          <pre className="text-xs bg-bg rounded-xl border border-line p-3 overflow-auto max-h-64">{JSON.stringify(telemetry, null, 2)}</pre>
        </SectionCard>
      )}
    </div>
  );
}

function PolicyCard({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const { data: assignedPolicy, refetch } = useQuery({
    queryKey: ['assignedPolicy', deviceID],
    queryFn: () => resolvedPolicyForDevice(deviceID)
  });
  const [pick, setPick] = useState('');
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'device', deviceID),
    onSuccess: () => { refetch(); qc.invalidateQueries({ queryKey: ['device', deviceID] }); toast.success('Policy assigned'); }
  });
  const unassign = useMutation({
    mutationFn: (policyID: string) => unassignPolicy(policyID, 'device', deviceID),
    onSuccess: () => { refetch(); toast.success('Device-level override removed'); }
  });

  return (
    <SectionCard
      icon={<ShieldHalf className="w-[18px] h-[18px]" />} title="Policy"
      actions={assignedPolicy && (
        <Button size="sm" variant="secondary" onClick={() => unassign.mutate(assignedPolicy.id)}>
          Unassign device override
        </Button>
      )}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xs uppercase tracking-wider text-faint">Resolved</span>
        <span className="text-sm font-medium">
          {assignedPolicy ? `${assignedPolicy.name} (v${assignedPolicy.version})` : 'none'}
        </span>
        <div className="flex-1 min-w-[140px]" />
        <Select value={pick} onChange={e => setPick(e.target.value)} className="w-auto">
          <option value="">Pick a policy…</option>
          {policies?.map(p => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}
        </Select>
        <Button variant="primary" disabled={!pick}
                onClick={async () => { await assign.mutateAsync(pick); cmd.mutate({ kind: 'APPLY_POLICY' }); setPick(''); }}>
          Assign + apply
        </Button>
        <Button variant="secondary" disabled={!assignedPolicy}
                onClick={() => cmd.mutate({ kind: 'APPLY_POLICY' })}>
          Re-apply
        </Button>
      </div>
    </SectionCard>
  );
}

function FlashlightToggle({ cmd, disabled }: {
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  disabled?: boolean;
}) {
  const [on, setOn] = useState(false);
  return (
    <ActionTile
      icon={<Flashlight className="w-4 h-4" />}
      label={`Flashlight: ${on ? 'ON' : 'off'}`}
      active={on}
      disabled={disabled}
      title={disabled ? 'Your role cannot issue this command' : undefined}
      onClick={() => { setOn(!on); cmd.mutate({ kind: 'SET_FLASHLIGHT', payload: { on: !on } }); }}
    />
  );
}

/* ===================== Agent (MDM) permissions ===================== */

// A single permission shown as a pill: green when granted, muted/red when not.
function PermPill({ name, granted }: { name: string; granted: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs',
      granted
        ? 'border-accent/30 bg-accent/10 text-fg'
        : 'border-danger/30 bg-danger/8 text-muted'
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', granted ? 'bg-accent' : 'bg-danger')} />
      {name}
    </span>
  );
}

const PERM_GROUPS: Array<{ kind: string; label: string }> = [
  { kind: 'admin',   label: 'Management role' },
  { kind: 'runtime', label: 'Runtime permissions' },
  { kind: 'special', label: 'Special access' },
];

// What the MDM agent ITSELF has been granted on this device — shown for every
// device regardless of management mode. Data comes from FETCH_DEVICE_INFO's
// `mdm_permissions` (added to the agent); degrades gracefully on older agents.
function AgentPermissionsCard({ info, cmd, canFetch }: {
  info: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  canFetch: boolean;
}) {
  const perms = (info?.mdm_permissions as Array<{ name: string; granted: boolean; kind: string }> | undefined) ?? [];
  const granted = perms.filter(p => p.granted).length;
  return (
    <SectionCard
      icon={<KeyRound className="w-[18px] h-[18px]" />}
      title="Agent permissions"
      subtitle="What the CyberSentinel agent itself is allowed to do on this device"
      actions={perms.length > 0 && (
        <Badge tone={granted === perms.length ? 'accent' : 'warn'}>{granted}/{perms.length} granted</Badge>
      )}>
      {perms.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span>{info ? 'This agent build doesn’t report its permissions yet — update the agent.' : 'Fetch device info to read the agent’s granted permissions.'}</span>
          <Button size="sm" variant="secondary" disabled={!canFetch} onClick={() => cmd.mutate({ kind: 'FETCH_DEVICE_INFO' })}>
            <ScanLine className="w-3.5 h-3.5" /> Refresh device info
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {PERM_GROUPS.map(g => {
            const items = perms.filter(p => p.kind === g.kind);
            if (items.length === 0) return null;
            return (
              <div key={g.kind}>
                <div className="text-2xs uppercase tracking-wider text-faint mb-1.5">{g.label}</div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map(p => <PermPill key={p.name} name={p.name} granted={p.granted} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

/* ============================== Apps Tab ============================== */

// Lenses over the SAME inventory — none of them drop apps from the underlying
// list, they just narrow what's shown. "All" is the default so nothing is ever
// hidden by surprise. In a work profile every one of these apps lives inside
// the managed profile (personal apps are invisible to the agent by design).
type AppView = 'all' | 'work' | 'launchable' | 'system';

const VIEW_PRED: Record<AppView, (a: Record<string, unknown>) => boolean> = {
  all:        () => true,
  work:       a => !a.preinstalled,        // genuinely provisioned into the profile (not an inherited OEM app)
  launchable: a => !!a.launchable,         // user-facing, has a launcher icon
  system:     a => !!a.system,             // headless OS components / services
};

const VIEW_META: Array<{ key: AppView; label: string; hint: string }> = [
  { key: 'all',        label: 'All',        hint: 'Every app visible inside the work profile' },
  { key: 'work',       label: 'Work-installed', hint: 'Apps provisioned into the profile (not inherited from the device image)' },
  { key: 'launchable', label: 'Launchable', hint: 'User-facing apps with a launcher icon' },
  { key: 'system',     label: 'System',     hint: 'Headless OS components and services' },
];

// Device Owner (fully-managed) classification — kept DELIBERATELY SEPARATE from
// the work-profile lenses above. A fully-managed device has no work/personal
// split, so there is no "work app" concept; instead we classify by where each
// app came from (OEM image vs installed onto the device) and its current state.
type DAView = 'all' | 'user' | 'preinstalled' | 'system' | 'disabled';

const DA_VIEW_PRED: Record<DAView, (a: Record<string, unknown>) => boolean> = {
  all:          () => true,
  user:         a => !a.preinstalled,                 // installed onto the device (Play / sideload / pushed by MDM)
  preinstalled: a => !!a.preinstalled && !a.system,   // user-facing apps bundled in the OEM image
  system:       a => !!a.system,                      // headless OS components / services
  disabled:     a => a.enabled === false,             // currently disabled / hidden on the device
};

const DA_VIEW_META: Array<{ key: DAView; label: string; hint: string }> = [
  { key: 'all',          label: 'All',           hint: 'Every installed package on the device' },
  { key: 'user',         label: 'User-installed', hint: 'Apps installed onto the device (Play, sideload, or pushed by MDM) — not part of the OEM image' },
  { key: 'preinstalled', label: 'Preinstalled',  hint: 'User-facing apps bundled in the device’s OEM image' },
  { key: 'system',       label: 'System',        hint: 'Headless OS components and services' },
  { key: 'disabled',     label: 'Disabled',      hint: 'Apps currently disabled or hidden on the device' },
];

// Segmented "lens" control over an inventory. The lens SET (labels + predicates)
// differs by provisioning mode — work profile vs Device Owner each pass their
// own meta — but the widget itself is shared so the two never drift in styling.
function LensBar({ meta, counts, view, onSelect }: {
  meta: Array<{ key: string; label: string; hint: string }>;
  counts: Record<string, number>;
  view: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface p-1">
      {meta.map(v => (
        <button key={v.key} type="button" title={v.hint} onClick={() => onSelect(v.key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 h-8 text-xs font-medium transition-colors',
            view === v.key ? 'bg-accent-soft text-accent ring-1 ring-inset ring-accent/20' : 'text-muted hover:bg-surface-2'
          )}>
          {v.label}
          <span className="tabular-nums text-2xs text-faint">{counts[v.key] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

type AppSort = { key: 'label' | 'package' | 'version'; dir: 'asc' | 'desc' };

// Clickable, resizable column header. Click toggles asc/desc on its key (and
// makes it the active sort); the arrow shows the current direction.
function SortTH({ label, sortKey, sort, onSort, onResize }: {
  label: string;
  sortKey: AppSort['key'];
  sort: AppSort;
  onSort: (updater: (s: AppSort) => AppSort) => void;
  onResize: (e: React.MouseEvent) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="relative px-4 py-2.5 font-medium">
      <button type="button"
        onClick={() => onSort(s => s.key === sortKey
          ? { key: sortKey, dir: s.dir === 'asc' ? 'desc' : 'asc' }
          : { key: sortKey, dir: 'asc' })}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-fg transition-colors">
        {label}
        {active
          ? (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-40" />}
      </button>
      <ColResizeHandle onMouseDown={onResize} />
    </th>
  );
}

// Per-app scope chip. Work-installed apps are highlighted; the rest are tagged
// by what they are so it's obvious nothing personal leaked in.
function AppScopeBadge({ app }: { app: Record<string, unknown> }) {
  if (!app.preinstalled) return <Badge tone="accent">work app</Badge>;
  if (app.system)        return <Badge tone="muted">system</Badge>;
  return <Badge tone="default">preinstalled</Badge>;
}

// Plain flags for fully-managed (Device Owner / Admin) devices — no work-profile
// "work app" framing, just what the app is on the device.
function DefaultAppFlags({ app }: { app: Record<string, unknown> }) {
  if (app.system)         return <Badge tone="muted">system</Badge>;
  if (!app.preinstalled)  return <Badge tone="accent">user installed</Badge>;
  return <Badge tone="default">preinstalled</Badge>;
}

// Compact "granted/requested permissions" chip — click to open the app's full
// permission breakdown. Hidden for apps that request nothing (or older agents
// that didn't report permissions).
function PermCountBadge({ app, onClick }: { app: Record<string, unknown>; onClick: () => void }) {
  const total = app.perm_count as number | undefined;
  if (typeof total !== 'number' || total === 0) return null;
  const granted = (app.perm_granted as number | undefined) ?? 0;
  return (
    <button type="button" onClick={onClick} title="View this app’s permissions"
      className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-2xs text-muted hover:bg-surface-2 hover:text-fg transition-colors">
      <KeyRound className="w-3 h-3" />
      <span className="tabular-nums">{granted}/{total}</span>
    </button>
  );
}

// Explains BYOD scoping right where the apps are listed, so the operator
// understands the list is the work profile (not the whole device).
function WorkProfileScopeBanner({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/10 p-3 text-xs text-muted">
      <ShieldHalf className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
      <span>
        <strong className="text-fg">Work Profile scope.</strong> All {count} app{count === 1 ? '' : 's'} below live inside
        the managed work profile, so each one is a work-profile app. The user's <b>personal</b> apps are private to them
        and never visible to MDM (Android BYOD isolation) — nothing here is reduced or filtered out by default.
      </span>
    </div>
  );
}

function AppsTab({ deviceID: _deviceID, inventory, cmd, mode }: {
  deviceID: string;
  inventory: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  mode?: string | null;
}) {
  // App management commands are privileged — require both the device mode AND
  // the user's command:issue:privileged permission.
  const canPrivCmd = useCan('command:issue:privileged');
  const canManage = modeAllows(mode, 'app_manage') && canPrivCmd;
  const canUninstall = modeAllows(mode, 'app_uninstall') && canPrivCmd;
  const manageReq = !canPrivCmd ? 'Your role cannot manage apps' : modeRequirement(mode, 'app_manage');
  const uninstallReq = !canPrivCmd ? 'Your role cannot uninstall apps' : modeRequirement(mode, 'app_uninstall');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<string>('all');
  const [actOn, setActOn] = useState<Record<string, unknown> | null>(null);
  // The agent returns packages in PackageManager order (effectively arbitrary),
  // so sort client-side. Default A→Z by label; columns are clickable to re-sort.
  const [sort, setSort] = useState<{ key: 'label' | 'package' | 'version'; dir: 'asc' | 'desc' }>({ key: 'label', dir: 'asc' });
  // Profile Owner ⇒ this whole inventory is the work profile. Prefer the live
  // value the agent stamps on the result, falling back to the device's mode.
  const isWorkProfile = inventory?.profile_scoped === true || normalizeMode(mode) === 'profile';
  // Each provisioning mode classifies its inventory with its OWN lens set:
  // work profile by work/personal scope, Device Owner by image-origin + state.
  const lensMeta = isWorkProfile ? VIEW_META : DA_VIEW_META;
  const lensPred: Record<string, (a: Record<string, unknown>) => boolean> =
    isWorkProfile ? VIEW_PRED : DA_VIEW_PRED;
  // Drag-to-resize columns: Label, Package, Version, Flags, Actions.
  const { widths, startResize, total } = useColumnWidths([240, 260, 150, 130, 290]);

  // Kick a fresh inventory fetch when the tab opens with no cached result.
  useEffect(() => {
    if (!inventory) cmd.mutate({ kind: 'FETCH_APP_INVENTORY' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Counts per lens, computed once over the full list so the segmented control
  // can show how many apps fall in each view without re-filtering on render.
  const counts = useMemo(() => {
    const list = (inventory?.apps as Array<Record<string, unknown>>) || [];
    const out: Record<string, number> = {};
    for (const v of lensMeta) out[v.key] = list.filter(lensPred[v.key]).length;
    return out;
  }, [inventory, lensMeta, lensPred]);

  const apps = useMemo(() => {
    const list = (inventory?.apps as Array<Record<string, unknown>>) || [];
    const q = filter.trim().toLowerCase();
    const pred = lensPred[view] ?? (() => true);
    const cmp = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      let c: number;
      if (sort.key === 'version') {
        c = (Number(a.version_code) || 0) - (Number(b.version_code) || 0);
      } else {
        c = String(a[sort.key] ?? '').toLowerCase().localeCompare(String(b[sort.key] ?? '').toLowerCase());
      }
      return sort.dir === 'asc' ? c : -c;
    };
    return list
      .filter(pred)
      .filter(a => !q ||
        String(a.label ?? '').toLowerCase().includes(q) ||
        String(a.package ?? '').toLowerCase().includes(q))
      .sort(cmp);
  }, [inventory, filter, view, lensPred, sort]);

  if (!inventory) {
    return (
      <EmptyTile icon={<AppWindow className="w-7 h-7" />} title="No app inventory yet"
                 hint="Fetch the installed-package list from this device to manage apps.">
        <Button variant="primary" onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })}>
          <PackageSearch className="w-4 h-4" /> Fetch app inventory
        </Button>
      </EmptyTile>
    );
  }

  return (
    <div className="space-y-4">
      {isWorkProfile && <WorkProfileScopeBanner count={counts.all} />}

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[220px]">
          <PackageSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint" />
          <Input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="Filter by label or package…"
                 className="pl-9 h-9" />
        </div>
        <Button variant="secondary" size="sm" className="h-9" onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })}>
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Classification lenses. Each provisioning mode gets its OWN set (the two
          are intentionally not merged): work profile frames by work/personal
          scope, Device Owner / Device Admin by OEM-image origin + app state. */}
      <LensBar meta={lensMeta} counts={counts} view={view} onSelect={setView} />

      <div className="rounded-2xl border border-line bg-surface shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-sm" style={{ tableLayout: 'fixed', width: total, minWidth: '100%' }}>
            <colgroup>
              {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead>
              <tr className="bg-surface-2/40 text-left text-2xs uppercase tracking-wider text-faint">
                <SortTH label="Label"   sortKey="label"   sort={sort} onSort={setSort} onResize={e => startResize(0, e)} />
                <SortTH label="Package" sortKey="package" sort={sort} onSort={setSort} onResize={e => startResize(1, e)} />
                <SortTH label="Version" sortKey="version" sort={sort} onSort={setSort} onResize={e => startResize(2, e)} />
                <th className="relative px-4 py-2.5 font-medium">Flags<ColResizeHandle onMouseDown={e => startResize(3, e)} /></th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="rail">
              {apps.map((a, i) => {
                const pkg = a.package as string;
                return (
                  <tr key={pkg + i} className="border-t border-line/70 hover:bg-surface-2 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="grid place-items-center h-7 w-7 rounded-lg bg-accent-soft text-accent shrink-0">
                          <AppWindow className="w-3.5 h-3.5" />
                        </span>
                        <span className="font-medium truncate">{a.label as string}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted truncate" title={pkg}>{pkg}</td>
                    <td className="px-4 py-2.5 tabular-nums truncate">{a.version_name as string} <span className="text-faint text-xs">({String(a.version_code ?? '')})</span></td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {isWorkProfile ? <AppScopeBadge app={a} /> : <DefaultAppFlags app={a} />}
                        {a.enabled === false ? <Badge tone="danger" dot>disabled</Badge> : null}
                        <PermCountBadge app={a} onClick={() => setActOn(a)} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex gap-1 items-center">
                        <Button size="sm" variant="secondary" className="h-7 px-2"
                          title={manageReq ?? 'Hide from launcher'}
                          disabled={!canManage}
                          onClick={() => cmd.mutate({ kind: 'HIDE_APP', payload: { package_name: pkg } })}>Hide</Button>
                        <Button size="sm" variant="secondary" className="h-7 px-2"
                          title={manageReq ?? 'Block uninstall'}
                          disabled={!canManage}
                          onClick={() => cmd.mutate({ kind: 'BLOCK_UNINSTALL', payload: { package_name: pkg } })}>Block</Button>
                        <Button size="sm" variant="danger" className="h-7 px-2"
                          title={uninstallReq ?? 'Uninstall this app'}
                          disabled={!canUninstall}
                          onClick={async () => {
                            if (await confirmDialog({
                              title: `Uninstall ${a.label}?`,
                              message: 'Removed silently in Device Owner mode; the user is prompted in Device Admin mode.',
                              confirmLabel: 'Uninstall',
                            })) cmd.mutate({ kind: 'UNINSTALL_APP', payload: { package_name: pkg } });
                          }}>Uninstall</Button>
                        <Button size="sm" variant="secondary" className="h-7 px-2"
                          title="All actions (Show, Allow uninstall, Clear data…)"
                          aria-label="All actions"
                          onClick={() => setActOn(a)}><MoreHorizontal className="w-4 h-4" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {apps.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-faint">
                  {counts.all === 0 ? 'No apps in this inventory.' : `No apps in the "${lensMeta.find(v => v.key === view)?.label}" view match your filter.`}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-muted tabular-nums">
        Showing {apps.length} {view !== 'all' ? `(${lensMeta.find(v => v.key === view)?.label})` : ''} of {(inventory.count as number) ?? counts.all} {isWorkProfile ? 'work-profile ' : ''}apps ·
        Fetched {inventory.fetched_at ? new Date(inventory.fetched_at as string).toLocaleString() : '—'}
      </p>
      {isWorkProfile ? <WorkProfileAppNotice /> : <DAModeNotice />}
      {actOn && <AppActionModal app={actOn} onClose={() => setActOn(null)} cmd={cmd} mode={mode} />}
    </div>
  );
}

function DAModeNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-muted">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
      <span>
        <strong className="text-fg">Heads-up:</strong> Hide / Block uninstall / Clear data / silent install require the agent to be running as <b>Device Owner</b>.
        In <b>Device Admin</b> mode the OS prompts the user on the device to approve uninstall and silent install isn't possible.
      </span>
    </div>
  );
}

function WorkProfileAppNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/10 p-3 text-xs text-muted">
      <ShieldHalf className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
      <span>
        <strong className="text-fg">Work-profile management:</strong> Hide / Block uninstall / Uninstall / Clear data all act
        <b> only on the work profile</b> and run silently as Profile Owner — the user's personal apps are untouched and out of reach.
        Whole-device actions (factory wipe, reboot) are intentionally unavailable on a work profile.
      </span>
    </div>
  );
}

function AppActionModal({ app, onClose, cmd, mode }: {
  app: Record<string, unknown>;
  onClose: () => void;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  mode?: string | null;
}) {
  const pkg = app.package as string;
  const canPrivCmd = useCan('command:issue:privileged');
  const canManage = modeAllows(mode, 'app_manage') && canPrivCmd;
  const canUninstall = modeAllows(mode, 'app_uninstall') && canPrivCmd;
  const fire = (kind: string, payload?: Record<string, unknown>) => {
    cmd.mutate({ kind, payload: { package_name: pkg, ...(payload || {}) } });
    onClose();
  };
  return (
    <Modal onClose={onClose} label={`Actions for ${app.label}`} width="max-w-md">
      <ModalBody className="space-y-3 p-5">
        <div className="flex items-center gap-3">
          <span className="grid place-items-center h-10 w-10 rounded-xl bg-accent-soft text-accent shrink-0">
            <AppWindow className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <div className="font-display font-semibold text-lg leading-tight truncate">{app.label as string}</div>
            <div className="font-mono text-xs text-muted truncate">{pkg}</div>
          </div>
        </div>
        {!canManage && (
          <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-xl p-2.5">
            Most app-management actions require Device Owner. This device is in <b>{normalizeMode(mode) === 'admin' ? 'Device Admin' : 'Enrolled only'}</b> mode.
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <ModalBtn label="Hide from launcher"  desc="App icon removed, package stays installed" disabled={!canManage} onClick={() => fire('HIDE_APP')} />
          <ModalBtn label="Show in launcher"    desc="Reverse of hide"                            disabled={!canManage} onClick={() => fire('SHOW_APP')} />
          <ModalBtn label="Block uninstall"     desc="Prevent user from uninstalling"             disabled={!canManage} onClick={() => fire('BLOCK_UNINSTALL')} />
          <ModalBtn label="Allow uninstall"     desc="Reverse of block"                           disabled={!canManage} onClick={() => fire('ALLOW_UNINSTALL')} />
          <ModalBtn label="Clear app data"      desc="Wipe sharedPrefs, DB, cache (DO only)"      disabled={!canManage} onClick={() => fire('CLEAR_APP_DATA')} />
          <ModalBtn label="Uninstall"           desc="Remove the package (DO silent / DA prompt)" tone="danger" disabled={!canUninstall}
                    onClick={async () => {
                      if (await confirmDialog({ title: `Uninstall ${app.label}?`, confirmLabel: 'Uninstall' })) fire('UNINSTALL_APP');
                    }} />
        </div>
        <AppPermissionsSection app={app} />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

// Full per-app permission breakdown (every permission the app requested + its
// live grant state), from the inventory's `permissions` field. Searchable and
// scrollable; collapses to a granted/total summary on older agents that didn't
// report permissions.
function AppPermissionsSection({ app }: { app: Record<string, unknown> }) {
  const perms = (app.permissions as Array<{ name: string; granted: boolean }> | undefined) ?? [];
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  if (perms.length === 0) {
    return (
      <div className="pt-1 text-xs text-muted border-t border-line/60 mt-1">
        No permission data for this app {typeof app.perm_count === 'number' ? '' : '(update the agent to see per-app permissions)'}.
      </div>
    );
  }
  const granted = perms.filter(p => p.granted).length;
  const shown = perms
    .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.granted) - Number(a.granted) || a.name.localeCompare(b.name));
  return (
    <div className="border-t border-line/60 pt-3 mt-1">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="w-4 h-4 text-accent" /> Permissions
        </span>
        <span className="flex items-center gap-2">
          <Badge tone={granted === perms.length ? 'accent' : 'muted'}>{granted}/{perms.length} granted</Badge>
          <ChevronRight className={cn('w-4 h-4 text-faint transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <div className="mt-2.5 space-y-2">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter permissions…" className="h-8 text-xs" />
          <div className="max-h-56 overflow-y-auto rounded-xl border border-line divide-y divide-line/60">
            {shown.map(p => (
              <div key={p.name} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="font-mono truncate text-muted" title={p.name}>{p.name}</span>
                <span className={cn('shrink-0 inline-flex items-center gap-1 font-medium',
                  p.granted ? 'text-accent' : 'text-faint')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', p.granted ? 'bg-accent' : 'bg-faint')} />
                  {p.granted ? 'granted' : 'denied'}
                </span>
              </div>
            ))}
            {shown.length === 0 && <div className="px-3 py-3 text-center text-faint text-xs">No permissions match “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ModalBtn({ label, desc, onClick, tone, disabled }: { label: string; desc: string; onClick: () => void; tone?: 'danger'; disabled?: boolean }) {
  const cls = tone === 'danger'
    ? 'border-danger/30 text-danger hover:bg-danger/10 hover:border-danger/50'
    : 'border-line hover:bg-surface-2 hover:border-line-strong';
  return (
    <button onClick={onClick} disabled={disabled}
            className={cn('text-left rounded-xl border p-2.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed', cls)}>
      <div className="font-medium text-sm">{label}</div>
      <div className={cn('mt-0.5', tone === 'danger' ? 'text-danger/70' : 'text-muted')}>{desc}</div>
    </button>
  );
}

/* ============================== Photos Tab ============================== */

function PhotosTab({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: photos, isLoading } = useQuery({
    queryKey: ['photos', deviceID],
    queryFn: () => listDevicePhotos(deviceID),
    refetchInterval: 5000
  });
  const [lens, setLens] = useState<'BACK' | 'FRONT'>('BACK');
  const [withFlash, setWithFlash] = useState(false);
  const [preview, setPreview] = useState<{ url: string; id: string } | null>(null);
  const canCapture = useCan('command:issue:surveillance');

  const remove = useMutation({
    mutationFn: (id: string) => deletePhoto(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['photos', deviceID] }); toast.success('Photo deleted'); }
  });

  return (
    <div className="space-y-4">
      <SectionCard icon={<Camera className="w-[18px] h-[18px]" />} title="Capture photo">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl border border-line bg-surface-2/50 p-1 text-sm">
            {(['BACK', 'FRONT'] as const).map(l => (
              <button key={l} onClick={() => setLens(l)}
                      className={cn('px-3 py-1.5 rounded-lg transition-all',
                        lens === l ? 'bg-surface text-accent font-medium shadow-xs ring-1 ring-line' : 'text-muted hover:text-fg')}>
                {l === 'BACK' ? 'Rear camera' : 'Front (selfie)'}
              </button>
            ))}
          </div>
          <label className="text-sm flex items-center gap-1.5 select-none text-muted">
            <input type="checkbox" checked={withFlash} onChange={e => setWithFlash(e.target.checked)} className="accent-[var(--accent)]" />
            Flash
          </label>
          <Button
            variant="primary"
            onClick={() => cmd.mutate({ kind: 'CAPTURE_PHOTO', payload: { lens, with_flash: withFlash } })}
            disabled={!canCapture}
            title={canCapture ? undefined : 'Your role cannot capture photos (surveillance permission required)'}>
            <Camera className="w-4 h-4" /> Capture now
          </Button>
        </div>
        <p className="text-xs text-muted mt-3">
          Captures a single JPEG. Requires CAMERA permission — auto-granted in Device Owner mode, prompts the user in Device Admin mode.
          Privacy indicator dot appears briefly on Android 12+.
        </p>
      </SectionCard>

      <section>
        <SectionHeading icon={LayoutGrid} title="Gallery"
                        hint={photos && photos.length > 0 ? `${photos.length} captured` : undefined} />
        <div className="mt-3">
          {isLoading && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => <UiSkeleton key={i} className="aspect-[4/3] rounded-xl" />)}
            </div>
          )}
          {!isLoading && photos?.length === 0 && (
            <EmptyTile icon={<Camera className="w-7 h-7" />} title="No photos captured yet"
                       hint='Click "Capture now" above to take a remote photo.' />
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {photos?.map((p, i) => (
              <div key={p.id} className="animate-slideup" style={{ animationDelay: `${i * 40}ms` }}>
                <PhotoThumb photo={p} onOpen={(url) => setPreview({ url, id: p.id })} onDelete={async () => {
                  if (await confirmDialog({ title: 'Delete this photo?', message: 'The capture is removed from storage permanently.', confirmLabel: 'Delete photo' })) remove.mutate(p.id);
                }} />
              </div>
            ))}
          </div>
        </div>
      </section>
      {preview && <ImagePreview url={preview.url} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PhotoThumb({ photo, onOpen, onDelete }: {
  photo: { id: string; created_at: string; size_bytes: number };
  onOpen: (url: string) => void;
  onDelete: () => void;
}) {
  const { data } = useQuery({
    queryKey: ['photo-url', photo.id],
    queryFn: () => presignPhoto(photo.id),
    staleTime: 8 * 60 * 1000
  });
  return (
    <div className="group rounded-xl border border-line bg-surface overflow-hidden shadow-xs transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <button onClick={() => data && onOpen(data.url)} className="block w-full aspect-[4/3] bg-surface-2 overflow-hidden">
        {data ? <img src={data.url} alt="" className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" /> : <div className="w-full h-full animate-pulse bg-surface-2" />}
      </button>
      <div className="p-2.5 text-xs flex items-center justify-between gap-2">
        <span className="text-muted truncate">{new Date(photo.created_at).toLocaleString()}</span>
        <button onClick={onDelete} className="text-danger hover:underline shrink-0">delete</button>
      </div>
    </div>
  );
}

function ImagePreview({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <Modal onClose={onClose} label="Photo preview" bare>
      <img src={url} alt="" className="max-w-[95vw] max-h-[90vh] rounded-2xl shadow-overlay" />
    </Modal>
  );
}

/* ============================== Audio Tab ============================== */

const SEGMENT_SEC = 5;     // length of each uploaded chunk
const MAX_SESSION_SEC = 300; // hard cap so a forgotten session can't record forever

function AudiosTab({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  // While a session is live we poll fast so new segments surface quickly for
  // near-live playback; otherwise the archive can refresh lazily.
  const [session, setSession] = useState<string | null>(null);
  const canCapture = useCan('command:issue:surveillance');
  const { data: audios, isLoading } = useQuery({
    queryKey: ['audios', deviceID],
    queryFn: () => listDeviceAudios(deviceID),
    refetchInterval: session ? 2500 : 8000
  });
  const [preview, setPreview] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (fid: string) => deleteAudio(fid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['audios', deviceID] }); toast.success('Segment deleted'); }
  });
  const removeSession = useMutation({
    mutationFn: (sid: string) => deleteAudioSession(sid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['audios', deviceID] }); toast.success('Recording deleted'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Delete failed')
  });

  // Segments of the currently-live session, ordered by sequence.
  const liveSegments = useMemo(() => {
    if (!session) return [];
    return (audios ?? [])
      .map(a => ({ a, p: parseAudioName(a.name) }))
      .filter(x => x.p.session === session)
      .sort((x, y) => (x.p.seq ?? 0) - (y.p.seq ?? 0))
      .map(x => x.a);
  }, [audios, session]);

  // Group every stored recording by session for the archive list.
  const groups = useMemo(() => groupAudios(audios ?? []), [audios]);

  const startListening = () => {
    const sid = newSessionId();
    setSession(sid);
    cmd.mutate({
      kind: 'START_AUDIO_STREAM',
      payload: { session_id: sid, segment_sec: SEGMENT_SEC, max_sec: MAX_SESSION_SEC, source: 'MIC' }
    });
  };
  const stopListening = () => {
    if (session) cmd.mutate({ kind: 'STOP_AUDIO_STREAM', payload: { session_id: session } });
    setSession(null);
  };

  return (
    <div className="space-y-4">
      <SectionCard icon={<Mic className="w-[18px] h-[18px]" />} title="Live audio"
                   tone={session ? 'danger' : 'accent'}
                   actions={session
            ? <Button variant="danger-solid" size="sm" onClick={stopListening}><Square className="w-3.5 h-3.5 fill-current" /> Stop listening</Button>
            : <Button variant="primary" size="sm" onClick={startListening} disabled={!canCapture}
                      title={canCapture ? undefined : 'Your role cannot capture audio (surveillance permission required)'}><Mic className="w-4 h-4" /> Start listening</Button>}>
        {session ? (
          <div className="mt-3">
            <div className="inline-flex items-center gap-2 text-xs text-danger font-medium mb-2">
              <span className="w-2 h-2 rounded-full bg-danger animate-pulse" /> LIVE — recording the mic in {SEGMENT_SEC}s segments
            </div>
            <LiveAudioPlayer segments={liveSegments} />
            <p className="text-xs text-muted mt-2">
              Playback runs ~{SEGMENT_SEC}–{SEGMENT_SEC * 2}s behind real time (each segment must finish recording and upload first).
              Auto-stops after {MAX_SESSION_SEC / 60} min. Every segment is saved below.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted mt-2">
            Streams the device microphone to your browser in short segments and archives every one.
            Requires RECORD_AUDIO — auto-granted in Device Owner mode. A mic privacy indicator shows on the device (Android 12+).
          </p>
        )}
      </SectionCard>

      <section>
        <SectionHeading icon={Mic} title="Recordings"
                        hint={groups.length > 0 ? `${groups.length} session${groups.length === 1 ? '' : 's'}` : undefined} />
        <div className="mt-3 space-y-3">
        {isLoading && <div className="text-sm text-muted">Loading…</div>}
        {!isLoading && groups.length === 0 && (
          <EmptyTile icon={<Mic className="w-7 h-7" />} title="No recordings yet"
                     hint='Click "Start listening" above to stream and archive the device microphone.' />
        )}
          {groups.map(g => (
            <AudioSessionCard
              key={g.key}
              group={g}
              activeSession={session}
              onPlay={setPreview}
              onDelete={async (fid) => {
                if (await confirmDialog({ title: 'Delete this recording segment?', confirmLabel: 'Delete segment' })) remove.mutate(fid);
              }}
              onDeleteSession={async () => {
                if (!await confirmDialog({
                  title: 'Delete this entire recording?',
                  message: 'Every segment of this session is removed permanently. This cannot be undone.',
                  confirmLabel: 'Delete recording',
                })) return;
                if (g.session) removeSession.mutate(g.session);
                else g.segments.forEach(s => remove.mutate(s.id)); // legacy/standalone
              }}
            />
          ))}
        </div>
      </section>
      {preview && <AudioPreview url={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

interface AudioGroup { key: string; session: string | null; startedAt: string; segments: FileObject[]; totalBytes: number }

// groupAudios buckets segments by session id (newest session first), so a live
// listen session shows up as one collapsible recording rather than N rows.
function groupAudios(list: FileObject[]): AudioGroup[] {
  const byKey = new Map<string, AudioGroup>();
  for (const a of list) {
    const { session, seq } = parseAudioName(a.name);
    const key = session ?? a.id; // unrecognised names stand alone
    let g = byKey.get(key);
    if (!g) { g = { key, session, startedAt: a.created_at, segments: [], totalBytes: 0 }; byKey.set(key, g); }
    g.segments.push(a);
    g.totalBytes += a.size_bytes;
    if (new Date(a.created_at) < new Date(g.startedAt)) g.startedAt = a.created_at;
    void seq;
  }
  const groups = Array.from(byKey.values());
  for (const g of groups) {
    g.segments.sort((x, y) => (parseAudioName(x.name).seq ?? 0) - (parseAudioName(y.name).seq ?? 0));
  }
  groups.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return groups;
}

// LiveAudioPlayer plays a session's segments back-to-back. As new segments are
// uploaded they're appended; when the current one ends we advance. If we're
// caught up (idle at the end) and a new segment lands, an effect resumes play.
function LiveAudioPlayer({ segments }: { segments: FileObject[] }) {
  const [idx, setIdx] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const seg = segments[idx];

  const { data: presign } = useQuery({
    queryKey: ['audio-url', seg?.id],
    queryFn: () => presignAudio(seg!.id),
    enabled: !!seg,
    staleTime: 8 * 60 * 1000
  });

  // New src → attempt to play (best-effort; browser may require the user to
  // press play once if autoplay-with-sound is blocked).
  useEffect(() => {
    if (presign?.url && audioRef.current) audioRef.current.play().catch(() => {});
  }, [presign?.url]);

  // If more segments arrived while we were stalled at the very end, step to the
  // next unplayed one to keep the live feed flowing.
  useEffect(() => {
    if (idx < segments.length - 1 && audioRef.current?.ended) setIdx(idx + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length]);

  if (segments.length === 0) {
    return <div className="text-sm text-muted">Waiting for the first segment from the device…</div>;
  }

  return (
    <div className="flex items-center gap-3">
      <audio
        ref={audioRef}
        src={presign?.url}
        controls
        autoPlay
        onEnded={() => { if (idx < segments.length - 1) setIdx(idx + 1); }}
        className="flex-1" />
      <div className="text-xs text-muted whitespace-nowrap">
        segment {Math.min(idx + 1, segments.length)} / {segments.length}
        <button onClick={() => setIdx(segments.length - 1)} className="ml-2 text-accent hover:underline">jump to live</button>
      </div>
    </div>
  );
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Plays a whole recording session as one continuous track: a single Play/Pause
// that auto-advances through the session's segments, with the next segment
// prefetched so the hand-off is near-seamless. The user never clicks per
// segment.
function ContinuousSessionPlayer({ segments }: { segments: FileObject[] }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // seconds within the current segment
  const audioRef = useRef<HTMLAudioElement>(null);

  const cur = segments[idx];
  const next = segments[idx + 1];
  const { data: curUrl } = useQuery({
    queryKey: ['audio-url', cur?.id], queryFn: () => presignAudio(cur!.id),
    enabled: !!cur, staleTime: 8 * 60 * 1000
  });
  // Prefetch the next segment's URL so advancing is instant.
  useQuery({
    queryKey: ['audio-url', next?.id], queryFn: () => presignAudio(next!.id),
    enabled: !!next, staleTime: 8 * 60 * 1000
  });

  // Whenever the source (current segment) changes while playing, keep playing.
  useEffect(() => {
    if (playing && curUrl?.url && audioRef.current) audioRef.current.play().catch(() => {});
  }, [curUrl?.url, idx, playing]);

  const totalApprox = segments.length * SEGMENT_SEC;
  const elapsedApprox = idx * SEGMENT_SEC + Math.min(pos, SEGMENT_SEC);

  const toggle = () => {
    if (playing) { audioRef.current?.pause(); setPlaying(false); }
    else { setPlaying(true); audioRef.current?.play().catch(() => {}); }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        className="shrink-0 w-9 h-9 rounded-full bg-accent text-accent-fg hover:bg-accent-hover flex items-center justify-center"
        aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 transition-[width] duration-300"
               style={{ width: `${totalApprox ? Math.min(100, (elapsedApprox / totalApprox) * 100) : 0}%` }} />
        </div>
      </div>
      <span className="text-xs text-muted whitespace-nowrap tabular-nums">
        {fmtSec(elapsedApprox)} / ~{fmtSec(totalApprox)}
      </span>
      <audio
        ref={audioRef}
        src={curUrl?.url}
        className="hidden"
        onTimeUpdate={e => setPos((e.currentTarget as HTMLAudioElement).currentTime)}
        onEnded={() => {
          if (idx < segments.length - 1) { setIdx(idx + 1); setPos(0); }
          else { setPlaying(false); setIdx(0); setPos(0); }
        }} />
    </div>
  );
}

// StitchedSessionPlayer plays a whole session as one continuous file. The
// server concatenates the session's AAC/ADTS segments on demand (cached), so
// this is a single native <audio> with real scrubbing — no segment hand-off.
function StitchedSessionPlayer({ sessionId, live }: { sessionId: string; live?: boolean }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['audio-session', sessionId],
    queryFn: () => sessionAudioUrl(sessionId),
    staleTime: 60 * 1000,
    refetchInterval: live ? 5000 : false, // a live session keeps growing
    retry: false
  });
  if (isLoading) return <div className="text-xs text-muted">Preparing recording…</div>;
  if (isError || !data) return <div className="text-xs text-danger">Couldn't assemble this recording.</div>;
  return <audio controls src={data.url} className="w-full" preload="metadata" />;
}

function AudioSessionCard({ group, activeSession, onPlay, onDelete, onDeleteSession }: {
  group: AudioGroup;
  activeSession: string | null;
  onPlay: (url: string) => void;
  onDelete: (fileID: string) => void;
  onDeleteSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isLive = group.session != null && group.session === activeSession;
  const dur = group.segments.length * SEGMENT_SEC;
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 space-y-3 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className={cn('grid place-items-center h-9 w-9 rounded-lg shrink-0', isLive ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent')}>
            <Mic className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium flex items-center gap-2">
              {new Date(group.startedAt).toLocaleString()}
              {isLive && <Badge tone="danger" dot>LIVE</Badge>}
            </div>
            <div className="text-xs text-muted tabular-nums">
              ~{dur}s · {group.segments.length} segment{group.segments.length === 1 ? '' : 's'} · {(group.totalBytes / 1024).toFixed(0)} KB
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => setOpen(o => !o)} className="text-xs text-faint hover:text-muted dark:hover:text-faint">
            {open ? 'hide segments' : 'segments'}
          </button>
          <Button size="sm" variant="danger" className="h-7 px-2.5" onClick={onDeleteSession}>
            Delete recording
          </Button>
        </div>
      </div>

      {/* One player for the whole session. New (AAC/ADTS) sessions are stitched
          server-side into a single scrubbable file; legacy MP4 sessions fall
          back to the gapless-ish sequential player. */}
      {group.session && group.segments.every(s => s.name.toLowerCase().endsWith('.aac'))
        ? <StitchedSessionPlayer sessionId={group.session} live={isLive} />
        : <ContinuousSessionPlayer segments={group.segments} />}

      {open && (
        <ul className="border-t border-line divide-y divide-line -mx-3 -mb-3">
          {group.segments.map((s, i) => (
            <AudioSegmentRow key={s.id} segment={s} index={i} onPlay={onPlay} onDelete={() => onDelete(s.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AudioSegmentRow({ segment, index, onPlay, onDelete }: {
  segment: FileObject; index: number; onPlay: (url: string) => void; onDelete: () => void;
}) {
  const { data } = useQuery({
    queryKey: ['audio-url', segment.id],
    queryFn: () => presignAudio(segment.id),
    staleTime: 8 * 60 * 1000
  });
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-2/60 transition-colors">
      <span className="text-muted tabular-nums">#{index + 1} · {new Date(segment.created_at).toLocaleTimeString()} · {(segment.size_bytes / 1024).toFixed(0)} KB</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" className="h-7 px-2.5" onClick={() => data && onPlay(data.url)} disabled={!data}>
          <Play className="w-3 h-3 fill-current" /> Play
        </Button>
        {data && <a href={data.url} download className="inline-flex h-7 items-center rounded-lg border border-line px-2.5 text-xs font-medium transition-colors hover:bg-surface-2 hover:border-line-strong">Download</a>}
        <Button size="sm" variant="danger" className="h-7 px-2.5" onClick={onDelete}>Delete</Button>
      </div>
    </li>
  );
}

function AudioPreview({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <Modal onClose={onClose} label="Play recording" width="max-w-md">
      <ModalBody className="p-6">
        <h3 className="font-display font-semibold mb-4 flex items-center gap-2">
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-accent-soft text-accent"><Mic className="w-4 h-4" /></span>
          Play recording
        </h3>
        <audio controls autoPlay src={url} className="w-full" />
      </ModalBody>
      <ModalFooter>
        <a href={url} download className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs font-medium transition-colors hover:bg-surface-2 hover:border-line-strong">Download</a>
        <Button variant="subtle" size="sm" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

/* ============================== Policy Tab ================================ */

function PolicyTab({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: effective } = useQuery({
    queryKey: ['resolved-policy', deviceID],
    queryFn:  () => resolvedPolicyForDevice(deviceID),
    refetchInterval: 5000
  });
  const { data: assignments } = useQuery({
    queryKey: ['device-assignments', deviceID],
    queryFn:  () => listAssignmentsForDevice(deviceID),
    refetchInterval: 5000
  });
  const { data: policies } = useQuery({
    queryKey: ['policies'], queryFn: listPolicies
  });

  const [picking, setPicking] = useState(false);
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'device', deviceID),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resolved-policy', deviceID] });
      qc.invalidateQueries({ queryKey: ['device-assignments', deviceID] });
      qc.invalidateQueries({ queryKey: ['commands', deviceID] });
      toast.success('Policy assigned + APPLY_POLICY queued');
      setPicking(false);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Assign failed')
  });
  const unassign = useMutation({
    mutationFn: (a: PolicyAssignment) => unassignPolicy(a.policy_id, a.target_kind, a.target_id ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resolved-policy', deviceID] });
      qc.invalidateQueries({ queryKey: ['device-assignments', deviceID] });
      qc.invalidateQueries({ queryKey: ['commands', deviceID] });
      toast.success('Unassigned — device will reconcile shortly');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Unassign failed')
  });

  // Cross-reference assignment.policy_id → policy name/version using the
  // listPolicies result so each row reads as "PolicyName (v3)" instead of an
  // opaque UUID.
  const policyByID = new Map<string, { name: string; version: number }>();
  (policies ?? []).forEach(p => policyByID.set(p.id, { name: p.name, version: p.version }));

  // Set of policy IDs already bound to this device — so the picker can
  // disable them (re-assigning the same policy is a no-op anyway).
  const boundIDs = new Set<string>((assignments ?? []).map(a => a.policy_id));
  const available = (policies ?? []).filter(p => !boundIDs.has(p.id));

  const kindBadge = (kind: string): BadgeTone => {
    const map: Record<string, BadgeTone> = { device: 'success', group: 'info', tenant: 'default' };
    return map[kind] ?? 'default';
  };

  return (
    <SectionCard icon={<ShieldHalf className="w-[18px] h-[18px]" />} title="Policy enforcement"
                 subtitle="Multiple policies can be layered. Device-level overrides group-level overrides tenant-level; array fields (URL/app blocklists) union across all layers."
                 actions={
                   <>
                     <Button size="sm" variant="secondary" onClick={() => cmd.mutate({ kind: 'APPLY_POLICY' })}>
                       Re-apply now
                     </Button>
                     <Button size="sm" variant="secondary"
                       className="border-warn/40 text-warn hover:bg-warn/10"
                       onClick={async () => {
                         if (await confirmDialog({
                           title: 'Force-clear policy on device?',
                           message: 'Every policy-applied setting (camera, restrictions, blocklists, surveillance) is reset on the device.',
                           confirmLabel: 'Force clear', tone: 'warn',
                         })) cmd.mutate({ kind: 'CLEAR_POLICY' });
                       }}
                       title="Reset every policy-applied setting (camera, restrictions, blocklists, surveillance) on the device.">
                       Force clear on device
                     </Button>
                   </>
                 }>
      <div className="space-y-4">

      {/* Layered assignments list */}
      <div className="rounded-xl border border-line overflow-hidden">
        <div className="px-3 py-2.5 bg-surface-2/40 border-b border-line flex items-center justify-between">
          <div className="text-2xs font-medium uppercase tracking-wider text-faint">
            Bound policies <span className="text-faint">({assignments?.length ?? 0})</span>
          </div>
          <Button size="sm" variant="primary" className="h-7 px-3" onClick={() => setPicking(p => !p)}>
            {picking ? 'Cancel' : '+ Assign another'}
          </Button>
        </div>
        {(!assignments || assignments.length === 0) ? (
          <div className="px-3 py-6 text-sm text-muted text-center">
            No policies bound to this device. Tenant-wide assignments still apply automatically.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {assignments.map(a => {
              const meta = policyByID.get(a.policy_id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-2/60 transition-colors">
                  <div className="min-w-0 flex items-center gap-2.5">
                    <Badge tone={kindBadge(a.target_kind)}>{a.target_kind}</Badge>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {meta?.name ?? a.policy_id.slice(0, 8)}
                      </div>
                      <div className="text-xs text-muted">
                        {meta ? `v${meta.version} • ` : ''}assigned {new Date(a.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <Button size="sm" variant="danger" className="shrink-0"
                    onClick={async () => {
                      if (await confirmDialog({
                        title: `Unassign “${meta?.name ?? a.policy_id}”?`,
                        message: 'If this is the last policy covering the device it receives CLEAR_POLICY and rolls back every setting; otherwise it reconciles to the remaining layered policies.',
                        confirmLabel: 'Unassign',
                      })) unassign.mutate(a);
                    }}
                    disabled={unassign.isPending}>
                    Unassign
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Picker */}
      {picking && (
        <div className="rounded-xl border border-line bg-surface-2/30 p-3 animate-slideup">
          <div className="text-sm font-medium mb-2">Choose a policy to add</div>
          {available.length === 0 ? (
            <div className="text-sm text-muted py-2">
              {(policies ?? []).length === 0
                ? 'No policies exist. Create one from the Policies page first.'
                : 'Every existing policy is already bound to this device.'}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {available.map(p => (
                <li key={p.id} className="flex items-center justify-between py-2 gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs text-muted tabular-nums">v{p.version}</div>
                  </div>
                  <Button size="sm" variant="primary" className="h-7 px-3"
                    onClick={() => assign.mutate(p.id)}
                    disabled={assign.isPending}>
                    Assign
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Effective merged spec */}
      {effective && (
        <details className="rounded-xl border border-line bg-bg/40 p-3">
          <summary className="text-2xs font-medium uppercase tracking-wider text-faint cursor-pointer">
            Effective merged spec — {effective.name} (v{effective.version})
          </summary>
          <pre className="text-xs mt-2 overflow-auto max-h-72 whitespace-pre-wrap break-all">{JSON.stringify(effective.spec, null, 2)}</pre>
        </details>
      )}
      </div>
    </SectionCard>
  );
}

/* ============================== Activity Tab ============================== */

// Categories over the activity feed. The agent emits a location ping every
// ~30–60s, so an unfiltered feed is ~60% GPS noise that buries the meaningful
// events — and location already has its own map on the Overview. So we default
// to "Key activity" (everything except location) and offer per-type lenses.
type ActCat = 'key' | 'apps' | 'device' | 'network' | 'packages' | 'security' | 'location' | 'all';

const ACT_PRED: Record<ActCat, (k: string) => boolean> = {
  key:      k => !k.startsWith('activity.location'),
  apps:     k => k.startsWith('activity.app.'),
  device:   k => k.startsWith('activity.screen') || k.startsWith('activity.power') || k.startsWith('activity.user') || k === 'activity.boot',
  network:  k => k.startsWith('activity.network'),
  packages: k => k.startsWith('activity.package'),
  security: k => k.startsWith('activity.permission') || k.startsWith('activity.tamper') || k.startsWith('activity.unlock_photo') || k.startsWith('activity.monitor'),
  location: k => k.startsWith('activity.location'),
  all:      () => true,
};

const ACT_META: Array<{ key: ActCat; label: string; hint: string }> = [
  { key: 'key',      label: 'Key activity', hint: 'App usage, screen, power, network, installs and security — excludes routine location pings' },
  { key: 'apps',     label: 'App usage',    hint: 'Foreground app changes (which app is open)' },
  { key: 'device',   label: 'Screen & power', hint: 'Screen on/off, unlocks and charger connect/disconnect' },
  { key: 'network',  label: 'Network',      hint: 'Connectivity / transport changes' },
  { key: 'packages', label: 'Installs',     hint: 'App installs, updates and removals' },
  { key: 'security', label: 'Security',     hint: 'Permission changes, tamper and unlock-photo events' },
  { key: 'location', label: 'Location',     hint: 'GPS position reports (also shown on the Overview map)' },
  { key: 'all',      label: 'All',          hint: 'Every activity event, including location pings' },
];

function ActivityTab({ deviceID, usage, cmd, mode }: {
  deviceID: string;
  usage: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  mode?: string | null;
}) {
  // Fetch a generous window so the filtered (non-location) lenses still have
  // plenty of history once the location pings are set aside.
  const { data: events, isLoading } = useQuery({
    queryKey: ['device-events', deviceID],
    queryFn:  () => listDeviceEvents(deviceID, 'activity.', 500),
    refetchInterval: 5000
  });
  const [zoom, setZoom] = useState<string | null>(null);
  const [cat, setCat] = useState<ActCat>('key');
  // Work profile vs Device Owner get SEPARATE time-in-app views (see below) —
  // never a merged one. Prefer the scope the agent stamps on the usage result.
  const isWorkProfile = usage?.profile_scoped === true || normalizeMode(mode) === 'profile';

  // Kick a usage fetch when the tab opens with none cached.
  useEffect(() => {
    if (!usage) cmd.mutate({ kind: 'FETCH_APP_USAGE' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of ACT_META) out[c.key] = (events ?? []).filter(e => ACT_PRED[c.key](e.kind)).length;
    return out;
  }, [events]);

  const shown = useMemo(
    () => (events ?? []).filter(e => ACT_PRED[cat](e.kind)),
    [events, cat]
  );

  // Today's foreground-open count per package — enriches the usage rows.
  const opensToday = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const out: Record<string, number> = {};
    for (const e of events ?? []) {
      if (e.kind !== 'activity.app.foreground') continue;
      if (new Date(e.captured_at) < start) continue;
      const pkg = (e.payload as any)?.package as string | undefined;
      if (pkg) out[pkg] = (out[pkg] ?? 0) + 1;
    }
    return out;
  }, [events]);

  // 24-hour activity distribution for today (excludes location pings) — shows
  // when the device is actually in use.
  const hourly = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const buckets = new Array(24).fill(0) as number[];
    for (const e of events ?? []) {
      if (e.kind.startsWith('activity.location')) continue;
      const t = new Date(e.captured_at);
      if (t >= start) buckets[t.getHours()]++;
    }
    return buckets;
  }, [events]);

  return (
    <div className="space-y-4">
      {/* Time-in-app. Each enrollment mode gets its OWN view — work profile is
          scoped to work apps with a privacy frame, Device Owner is device-wide.
          They are intentionally kept separate, never merged. */}
      {isWorkProfile
        ? <WorkProfileAppUsage usage={usage} cmd={cmd} opens={opensToday} />
        : <DeviceOwnerAppUsage usage={usage} cmd={cmd} opens={opensToday} />}

      {isLoading ? (
        <div className="text-sm text-muted p-4">Loading activity…</div>
      ) : !events || events.length === 0 ? (
        <EmptyTile icon={<ActivityIcon className="w-7 h-7" />} title="No activity events yet"
                   hint="The agent streams screen unlocks, network changes, package installs/removals and (if the policy enables it) unlock-photo events here in real time." />
      ) : (
        <>
          <HourlyActivity buckets={hourly} />
          <LensBar meta={ACT_META} counts={counts} view={cat} onSelect={v => setCat(v as ActCat)} />
          <SectionCard icon={<ActivityIcon className="w-[18px] h-[18px]" />} title="Activity log" tone="info"
                       actions={
                         <Badge tone="info" dot>{shown.length} of {events.length} event{events.length === 1 ? '' : 's'}</Badge>
                       }>
            {shown.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-faint">
                No “{ACT_META.find(c => c.key === cat)?.label}” events in the recent window.
              </div>
            ) : (
              groupByDay(shown).map(group => (
                <div key={group.label} className="mb-3 last:mb-0">
                  <div className="sticky top-0 z-[1] -mx-1 mb-1 bg-surface/95 px-1 py-1 text-2xs font-semibold uppercase tracking-wider text-faint backdrop-blur">
                    {group.label} <span className="text-faint/70">· {group.items.length}</span>
                  </div>
                  <ul className="space-y-1">
                    {group.items.map(e => <ActivityRow key={e.id} e={e} onZoom={setZoom} />)}
                  </ul>
                </div>
              ))
            )}
            <div className="text-2xs text-faint mt-3 flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Auto-refreshes every 5s</div>
            {zoom && <ImagePreview url={zoom} onClose={() => setZoom(null)} />}
          </SectionCard>
        </>
      )}
    </div>
  );
}

// Groups events (already newest-first) into Today / Yesterday / date sections.
function groupByDay(events: ActivityEvent[]): Array<{ label: string; items: ActivityEvent[] }> {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const out: Array<{ label: string; items: ActivityEvent[] }> = [];
  let cur: { label: string; items: ActivityEvent[] } | null = null;
  for (const e of events) {
    const d = new Date(e.captured_at); d.setHours(0, 0, 0, 0);
    const label = d.getTime() === today.getTime() ? 'Today'
      : d.getTime() === yesterday.getTime() ? 'Yesterday'
      : new Date(e.captured_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (!cur || cur.label !== label) { cur = { label, items: [] }; out.push(cur); }
    cur.items.push(e);
  }
  return out;
}

// Compact 24-bar "when is this device active today" chart, built from the
// event stream (location pings excluded). Pure presentation.
function HourlyActivity({ buckets }: { buckets: number[] }) {
  const max = buckets.reduce((m, n) => Math.max(m, n), 0);
  if (max === 0) return null;
  const peak = buckets.indexOf(max);
  return (
    <SectionCard icon={<ActivityIcon className="w-[18px] h-[18px]" />} title="Activity by hour · today" tone="info"
                 actions={<span className="text-2xs text-faint">peak {String(peak).padStart(2, '0')}:00</span>}>
      <div className="flex items-end gap-[3px] h-20">
        {buckets.map((n, h) => (
          <div key={h} className="group relative flex-1 flex flex-col items-center justify-end h-full"
               title={`${String(h).padStart(2, '0')}:00 — ${n} event${n === 1 ? '' : 's'}`}>
            <div className={cn('w-full rounded-sm transition-colors', n === max ? 'bg-accent' : 'bg-accent/40 group-hover:bg-accent/70')}
                 style={{ height: `${Math.max(n === 0 ? 0 : 6, Math.round((n / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-2xs text-faint mt-1 tabular-nums">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </SectionCard>
  );
}

/* ----- Time-in-app usage: SEPARATE views per enrollment mode ----- */

// Pure formatter — turns a foreground-time in ms into "1h 23m" like Settings.
function msToDuration(ms: number): string {
  if (!ms || ms < 60_000) return ms >= 1000 ? `${Math.round(ms / 1000)}s` : '<1m';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Presentational only — a ranked time-in-app list with bars, share-of-total and
// last-used (a shared UI primitive like Badge/LensBar; no mode logic). `opens`
// optionally maps package → foreground-open count for the window.
function UsageBars({ rows, opens }: { rows: Array<Record<string, unknown>>; opens?: Record<string, number> }) {
  const max = rows.reduce((m, r) => Math.max(m, Number(r.total_foreground_ms) || 0), 0) || 1;
  const total = rows.reduce((s, r) => s + (Number(r.total_foreground_ms) || 0), 0) || 1;
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => {
        const pkg = r.package as string;
        const ms = Number(r.total_foreground_ms) || 0;
        const pct = Math.max(2, Math.round((ms / max) * 100));
        const share = Math.round((ms / total) * 100);
        const last = Number(r.last_used) || 0;
        const nOpens = opens?.[pkg];
        return (
          <li key={pkg + i} className="flex items-center gap-3">
            <span className="grid place-items-center h-5 w-5 shrink-0 text-2xs font-semibold tabular-nums text-faint">{i + 1}</span>
            <span className="grid place-items-center h-8 w-8 rounded-lg bg-accent-soft text-accent shrink-0"><AppWindow className="w-4 h-4" /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm truncate">{r.label as string}</span>
                <span className="tabular-nums text-sm shrink-0">{msToDuration(ms)} <span className="text-faint text-2xs">· {share}%</span></span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-2xs text-faint mt-0.5 truncate">
                <span className="font-mono">{pkg}</span>
                {typeof nOpens === 'number' ? ` · ${nOpens} open${nOpens === 1 ? '' : 's'}` : ''}
                {last ? ` · last ${new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// 7-day screen-time trend (oldest→newest). Built from the agent's daily buckets.
function UsageTrend({ daily }: { daily: Array<Record<string, unknown>> }) {
  const max = daily.reduce((m, d) => Math.max(m, Number(d.total_foreground_ms) || 0), 0) || 1;
  return (
    <div className="mb-4 rounded-xl border border-line bg-surface p-3">
      <div className="text-2xs uppercase tracking-wider text-faint mb-2">Screen time · last 7 days</div>
      <div className="flex items-end gap-2 h-24">
        {daily.map((d, i) => {
          const ms = Number(d.total_foreground_ms) || 0;
          const h = Math.max(ms === 0 ? 0 : 6, Math.round((ms / max) * 100));
          const dt = new Date(Number(d.date_ms) || 0);
          const isToday = i === daily.length - 1;
          return (
            <div key={i} className="group flex-1 flex flex-col items-center justify-end h-full gap-1"
                 title={`${dt.toLocaleDateString()} — ${msToDuration(ms)}`}>
              <span className="text-2xs tabular-nums text-faint opacity-0 group-hover:opacity-100">{ms ? msToDuration(ms) : ''}</span>
              <div className={cn('w-full rounded-t-sm transition-colors', isToday ? 'bg-accent' : 'bg-accent/40 group-hover:bg-accent/70')}
                   style={{ height: `${h}%` }} />
              <span className="text-2xs text-faint">{dt.toLocaleDateString([], { weekday: 'short' }).slice(0, 2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Small KPI tile for the usage summary strip.
function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-2xs uppercase tracking-wider text-faint">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-tight mt-0.5 truncate">{value}</div>
      {sub ? <div className="text-2xs text-faint truncate">{sub}</div> : null}
    </div>
  );
}

// Shared mechanics (window toggle, permission/empty states, fetch button) for
// the usage panel. The mode WRAPPERS below own all the framing/copy so the two
// modes read as distinct features.
function UsagePanel({ usage, cmd, title, banner, opens }: {
  usage: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  title: string;
  banner: React.ReactNode;
  opens?: Record<string, number>;
}) {
  const [win, setWin] = useState<'today' | 'week'>('today');
  const rows = (usage?.[win] as Array<Record<string, unknown>>) || [];
  const hasUsage = usage != null;
  const accessDenied = hasUsage && usage?.usage_access === false;

  // Summary KPIs derived from the usage rollup (today + 7-day) — no extra data.
  const sumMs = (rs: Array<Record<string, unknown>>) => rs.reduce((s, r) => s + (Number(r.total_foreground_ms) || 0), 0);
  const today = (usage?.today as Array<Record<string, unknown>>) || [];
  const week  = (usage?.week  as Array<Record<string, unknown>>) || [];
  const winMs = sumMs(rows);
  const topApp = rows[0];
  const avgPerDayMs = Math.round(sumMs(week) / 7);
  const showKpis = hasUsage && !accessDenied && (today.length > 0 || week.length > 0);

  return (
    <SectionCard icon={<ActivityIcon className="w-[18px] h-[18px]" />} title={title} tone="info"
                 actions={
                   <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                     {(['today', 'week'] as const).map(w => (
                       <button key={w} type="button" onClick={() => setWin(w)}
                         className={cn('rounded-md px-2.5 h-7 text-xs font-medium transition-colors',
                           win === w ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2')}>
                         {w === 'today' ? 'Today' : '7 days'}
                       </button>
                     ))}
                   </div>
                 }>
      {banner}
      {showKpis && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <KpiTile label={win === 'today' ? 'Screen time today' : 'Screen time (7d)'} value={msToDuration(winMs)} sub={`${rows.length} app${rows.length === 1 ? '' : 's'} used`} />
          <KpiTile label="Most active" value={topApp ? (topApp.label as string) : '—'} sub={topApp ? msToDuration(Number(topApp.total_foreground_ms) || 0) : undefined} />
          <KpiTile label="Daily average" value={msToDuration(avgPerDayMs)} sub="last 7 days" />
          <KpiTile label="Apps used (7d)" value={String(week.length)} sub={`${today.length} today`} />
        </div>
      )}
      {showKpis && Array.isArray(usage?.daily) && (usage!.daily as unknown[]).length > 0 && (
        <UsageTrend daily={usage!.daily as Array<Record<string, unknown>>} />
      )}
      {!hasUsage ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-muted">No usage data yet.</p>
          <Button variant="primary" size="sm" onClick={() => cmd.mutate({ kind: 'FETCH_APP_USAGE' })}>
            <PackageSearch className="w-4 h-4" /> Fetch app usage
          </Button>
        </div>
      ) : accessDenied ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span><strong className="text-fg">Usage access not granted.</strong> The agent needs the device’s “Usage access” special permission to read time-in-app. It prompts for this on the device — grant it, then refresh.</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="px-2 py-8 text-center text-sm text-faint">No app usage recorded for {win === 'today' ? 'today' : 'the last 7 days'}.</div>
      ) : (
        <UsageBars rows={rows} opens={win === 'today' ? opens : undefined} />
      )}
      {hasUsage && usage?.fetched_at ? (
        <div className="text-2xs text-faint mt-3">Fetched {new Date(usage.fetched_at as string).toLocaleString()}
          <button className="ml-2 underline hover:text-fg" onClick={() => cmd.mutate({ kind: 'FETCH_APP_USAGE' })}>refresh</button>
        </div>
      ) : null}
    </SectionCard>
  );
}

// WORK PROFILE: time-in-app scoped to the work container, with a privacy frame.
function WorkProfileAppUsage({ usage, cmd, opens }: {
  usage: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  opens?: Record<string, number>;
}) {
  return (
    <UsagePanel usage={usage} cmd={cmd} opens={opens} title="Work app usage"
      banner={
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/10 p-3 text-xs text-muted">
          <ShieldHalf className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <span><strong className="text-fg">Work profile scope.</strong> Time-in-app covers only apps in the managed work profile — personal apps are invisible to MDM (Android reports work-profile usage only).</span>
        </div>
      } />
  );
}

// DEVICE OWNER / fully-managed: device-wide time-in-app across all apps.
function DeviceOwnerAppUsage({ usage, cmd, opens }: {
  usage: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  opens?: Record<string, number>;
}) {
  return (
    <UsagePanel usage={usage} cmd={cmd} opens={opens} title="App usage"
      banner={
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/40 p-3 text-xs text-muted">
          <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
          <span><strong className="text-fg">Fully-managed device.</strong> Time-in-app covers every app on the device, ranked by foreground time.</span>
        </div>
      } />
  );
}

function ActivityRow({ e, onZoom }: { e: ActivityEvent; onZoom: (url: string) => void }) {
  const at = new Date(e.captured_at);
  const tone = activityTone(e.kind);
  const label = activityLabel(e.kind);
  const detail = activityDetail(e);

  // Unlock photo: resolve presigned thumbnail on click. The presign endpoint
  // is keyed by file id; we lazy-fetch only when the row is rendered to avoid
  // burning quota on a scroll-past.
  const fileId = (e.payload && (e.payload as any).file_id) as string | undefined;
  const { data: presign } = useQuery({
    queryKey: ['activity-presign', fileId],
    queryFn:  () => presignPhoto(fileId!),
    enabled:  !!fileId
  });

  return (
    <li className="flex items-start gap-3 rounded-lg py-2.5 px-2 -mx-2 hover:bg-surface-2 transition-colors">
      <span className={cn('grid place-items-center h-8 w-8 rounded-lg shrink-0', tone.chip)}>
        <tone.Icon className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">{label}</span>
          {detail && <span className="text-xs text-muted truncate">{detail}</span>}
        </div>
        <div className="text-2xs text-faint mt-0.5">{at.toLocaleString()}</div>
      </div>
      {fileId && presign?.url && (
        <button
          onClick={() => onZoom(presign.url)}
          className="shrink-0 w-16 h-12 rounded-lg overflow-hidden border border-line hover:opacity-80 transition-opacity">
          <img src={presign.url} alt="unlock capture" className="object-cover w-full h-full" />
        </button>
      )}
    </li>
  );
}

// activityTone maps an event kind to a small semantic palette (tokens only,
// never a rainbow) plus a leading lucide glyph for the row medallion.
function activityTone(kind: string): { chip: string; Icon: typeof ActivityIcon } {
  if (kind.startsWith('activity.tamper'))             return { chip: 'bg-danger-soft text-danger',  Icon: AlertTriangle };
  if (kind.startsWith('activity.permission.needed'))  return { chip: 'bg-warn-soft text-warn',       Icon: ShieldHalf };
  if (kind.startsWith('activity.power'))              return { chip: 'bg-warn-soft text-warn',       Icon: BatteryCharging };
  if (kind.startsWith('activity.permission.granted')) return { chip: 'bg-success-soft text-success', Icon: ShieldCheck };
  if (kind.startsWith('activity.user.present'))       return { chip: 'bg-success-soft text-success', Icon: Lock };
  if (kind.startsWith('activity.package'))            return { chip: 'bg-info-soft text-info',       Icon: PackageSearch };
  if (kind.startsWith('activity.network'))            return { chip: 'bg-info-soft text-info',       Icon: Network };
  if (kind.startsWith('activity.screen'))             return { chip: 'bg-info-soft text-info',       Icon: Smartphone };
  if (kind.startsWith('activity.unlock_photo'))       return { chip: 'bg-accent-soft text-accent',   Icon: Camera };
  if (kind.startsWith('activity.app.foreground'))     return { chip: 'bg-accent-soft text-accent',   Icon: AppWindow };
  if (kind.startsWith('activity.location'))           return { chip: 'bg-accent-soft text-accent',   Icon: MapPin };
  return { chip: 'bg-surface-2 text-muted', Icon: ActivityIcon };
}

function activityLabel(kind: string): string {
  switch (kind) {
    case 'activity.screen.on':           return 'Screen on';
    case 'activity.screen.off':          return 'Screen off';
    case 'activity.user.present':        return 'Device unlocked';
    case 'activity.power.connected':     return 'Charger connected';
    case 'activity.power.disconnected':  return 'Charger disconnected';
    case 'activity.network.change':      return 'Network change';
    case 'activity.package.added':       return 'App installed';
    case 'activity.package.removed':     return 'App uninstalled';
    case 'activity.package.replaced':    return 'App updated';
    case 'activity.boot':                return 'Device booted';
    case 'activity.unlock_photo':        return 'Unlock photo captured';
    case 'activity.app.foreground':      return 'App opened';
    case 'activity.location':            return 'Location';
    case 'activity.permission.needed':   return 'Permission needed';
    case 'activity.permission.granted':  return 'Permission granted';
    case 'activity.monitor.started':     return 'Activity monitor online';
    case 'activity.tamper':              return '⚠ Tamper detected';
    default:                             return kind;
  }
}

function activityDetail(e: ActivityEvent): string {
  const p = (e.payload || {}) as any;
  switch (e.kind) {
    case 'activity.app.foreground':
      return p.app_label ? `${p.app_label} (${p.package})` : (p.package ?? '');
    case 'activity.location':
      if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        const acc = typeof p.accuracy_m === 'number' ? ` ±${Math.round(p.accuracy_m)}m` : '';
        return `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}${acc}`;
      }
      return '';
    case 'activity.network.change':
      if (typeof p.transport === 'string') {
        const inet = p.has_internet === false ? ' • no internet' : '';
        const vpn  = p.vpn ? ' • VPN' : '';
        return `${p.transport}${inet}${vpn}`;
      }
      return '';
    case 'activity.permission.needed':
      return p.hint ? `${p.permission}: ${p.hint}` : (p.permission ?? '');
    case 'activity.permission.granted':
      return p.permission ?? '';
    case 'activity.package.added':
    case 'activity.package.removed':
    case 'activity.package.replaced':
      return p.app_label ? `${p.app_label} (${p.package})` : (p.package ?? '');
    case 'activity.unlock_photo':
      if (p.error) return `failed: ${p.error}`;
      if (p.lens) return `lens: ${p.lens}`;
      return '';
    case 'activity.tamper': {
      const where = (typeof p.latitude === 'number' && typeof p.longitude === 'number')
        ? ` @ ${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}` : '';
      return `${p.tamper_type ?? 'tamper'}: ${p.detail ?? ''}${where}`;
    }
  }
  return '';
}

/* ============================== Commands Tab ============================== */

function CommandsTab({ commands }: { commands: CommandRow[] | undefined }) {
  return (
    <SectionCard icon={<Terminal className="w-[18px] h-[18px]" />} title="Command history">
      <div className="rounded-2xl border border-line bg-surface shadow-xs overflow-hidden">
        <div className="overflow-x-auto max-h-[34rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-left text-faint">
              <tr className="border-b border-line">
                <th className="font-medium text-2xs uppercase tracking-wider py-2.5 px-4">Kind</th>
                <th className="font-medium text-2xs uppercase tracking-wider py-2.5 px-4">State</th>
                <th className="font-medium text-2xs uppercase tracking-wider py-2.5 px-4">Attempts</th>
                <th className="font-medium text-2xs uppercase tracking-wider py-2.5 px-4">Created</th>
                <th className="px-4"></th>
              </tr>
            </thead>
            <tbody className="rail">
              {commands?.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-faint">No commands yet.</td></tr>
              )}
              {commands?.map(c => <CommandHistoryRow key={c.id} c={c} />)}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  );
}

function CommandHistoryRow({ c }: { c: CommandRow }) {
  const [open, setOpen] = useState(false);
  const expandable = c.result != null || (c.last_error && c.last_error.length > 0);
  const failed = c.state === 'failed' || c.state === 'timed_out';
  return (
    <>
      <tr className="border-t border-line hover:bg-surface-2 transition-colors">
        <td className="py-3 px-4">
          <span className="inline-flex items-center gap-2.5">
            <span className={cn('grid place-items-center h-7 w-7 rounded-lg shrink-0',
                                 failed ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent')}>
              {failed ? <AlertTriangle className="w-3.5 h-3.5" /> : <Terminal className="w-3.5 h-3.5" />}
            </span>
            <span className="font-mono text-xs">{c.kind}</span>
          </span>
        </td>
        <td className="py-3 px-4"><StateBadge state={c.state} /></td>
        <td className="py-3 px-4 text-xs tabular-nums">{c.attempts}</td>
        <td className="py-3 px-4 text-xs text-muted tabular-nums">{new Date(c.created_at).toLocaleTimeString()}</td>
        <td className="py-3 px-4 text-right">
          {expandable && (
            <Button size="sm" variant="secondary" className="h-7 px-2.5" onClick={() => setOpen(v => !v)}>
              {open ? 'Hide' : 'View'}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-surface-2/40">
          <td colSpan={5} className="px-4 pb-3">
            {c.last_error && <div className="mb-2 text-xs text-danger">Error: {c.last_error}</div>}
            {c.result != null && (
              <pre className="text-xs bg-surface rounded-lg border border-line p-3 overflow-auto max-h-96">
                {JSON.stringify(c.result, null, 2)}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ============================== Shared bits ============================== */

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="group rounded-xl border border-line bg-surface p-3.5 shadow-xs transition-colors hover:border-line-strong">
      <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold mt-0.5 truncate">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

type ChipTone = 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'muted';

const CHIP_TONE: Record<ChipTone, string> = {
  accent:  'text-accent bg-accent-soft',
  success: 'text-success bg-success-soft',
  warn:    'text-warn bg-warn-soft',
  danger:  'text-danger bg-danger-soft',
  info:    'text-info bg-info-soft',
  muted:   'text-muted bg-surface-2'
};

// HeroChip: at-a-glance metric used in the device banner.
function HeroChip({ icon, label, value, sub, tone = 'accent' }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: ChipTone;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface/70 backdrop-blur-sm px-3 py-2.5 shadow-xs">
      <span className={cn('grid place-items-center h-9 w-9 rounded-lg shrink-0', CHIP_TONE[tone])}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
        <div className="text-sm font-semibold truncate leading-tight">{value}</div>
        {sub && <div className="text-2xs text-faint truncate">{sub}</div>}
      </div>
    </div>
  );
}

// SectionCard: a depth-y card with a soft icon chip header and top hairline accent.
function SectionCard({ icon, title, subtitle, actions, tone = 'accent', children, className }: {
  icon?: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode;
  actions?: React.ReactNode; tone?: ChipTone; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cn('relative rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-xs overflow-hidden', className)}>
      <Hairline tone="faint" />
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          {icon && <span className={cn('grid place-items-center h-9 w-9 rounded-xl shrink-0', CHIP_TONE[tone])}>{icon}</span>}
          <div className="min-w-0">
            <h2 className="font-medium leading-tight truncate">{title}</h2>
            {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// EmptyTile: a polished empty/loading state with a gradient icon tile.
function EmptyTile({ icon, title, hint, children }: {
  icon: React.ReactNode; title: string; hint?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-line bg-surface/50 py-12 px-6">
      <div className="grid place-items-center h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md mb-4">
        {icon}
      </div>
      <div className="font-medium">{title}</div>
      {hint && <p className="text-sm text-muted mt-1 max-w-sm">{hint}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

// ActionTile: a command button rendered as a tidy tile with an icon chip.
function ActionTile({ icon, label, onClick, disabled, title, tone = 'default', active }: {
  icon: React.ReactNode; label: string; onClick: () => void;
  disabled?: boolean; title?: string; tone?: 'default' | 'danger'; active?: boolean;
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={cn(
        'group w-full flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-left transition-all',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        active
          ? 'border-warn/50 bg-warn-soft text-warn'
          : tone === 'danger'
            ? 'border-danger/30 text-danger hover:bg-danger/10 hover:border-danger/50'
            : 'border-line bg-surface hover:bg-surface-2 hover:border-line-strong'
      )}>
      <span className={cn(
        'grid place-items-center h-8 w-8 rounded-lg shrink-0 transition-colors',
        active ? 'bg-warn/15 text-warn'
          : tone === 'danger' ? 'bg-danger-soft text-danger'
          : 'bg-surface-2 text-muted group-hover:text-accent'
      )}>{icon}</span>
      <span className="font-medium leading-tight">{label}</span>
    </button>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  qr_setup: 'QR · setup',
  qr_inapp: 'QR · in-app',
  direct_install: 'Direct install',
  adb: 'adb',
};

// How the device enrolled (provenance). Set once at enroll time.
function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span title="How this device enrolled"
          className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium bg-surface-2 text-muted ring-1 ring-inset ring-line">
      {CHANNEL_LABEL[channel] ?? channel}
    </span>
  );
}

function ActionGroup({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-faint mb-2">
        {icon}{title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ActionBtn({ label, icon, onClick, disabled, title }: { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <ActionTile icon={icon ?? <ChevronRight className="w-4 h-4" />} label={label} onClick={onClick} disabled={disabled} title={title} />
  );
}

function ResetPasswordBtn({ onSubmit, disabled, title }: { onSubmit: (pw: string) => void; disabled?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionTile icon={<KeyRound className="w-4 h-4" />} label="Reset password…"
                  onClick={() => setOpen(true)} disabled={disabled} title={title} />
      {open && <ResetPasswordModal onSubmit={onSubmit} onClose={() => setOpen(false)} />}
    </>
  );
}

function ResetPasswordModal({ onSubmit, onClose }: { onSubmit: (pw: string) => void; onClose: () => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal onClose={onClose} label="Reset device password" width="max-w-md">
      <ModalBody className="space-y-3 p-5">
        <div className="flex items-center gap-2.5">
          <span className="grid place-items-center h-9 w-9 rounded-xl bg-accent-soft text-accent shrink-0"><KeyRound className="w-4 h-4" /></span>
          <div className="font-display font-semibold">Reset device password</div>
        </div>
        <p className="text-xs text-muted">
          Requires Device Owner on Android 8+. In Device Admin mode this works only if no password is currently set.
        </p>
        <Input autoFocus type="text" value={pw} onChange={e => setPw(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter' && pw.length >= 4) { onSubmit(pw); onClose(); setPw(''); } }}
               placeholder="New password (min 4 chars)" />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={pw.length < 4}
                onClick={() => { onSubmit(pw); onClose(); setPw(''); }}>Reset</Button>
      </ModalFooter>
    </Modal>
  );
}

// SendMessageBtn opens a small composer and fires SHOW_MESSAGE. Reused shape
// (title + body) is what the group broadcaster uses too.
function SendMessageBtn({ onSend, disabled, title }: { onSend: (title: string, message: string) => void; disabled?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionTile icon={<MessageSquare className="w-4 h-4" />} label="Send message…"
                  onClick={() => setOpen(true)} disabled={disabled} title={title} />
      {open && <SendMessageModal onSend={onSend} onClose={() => setOpen(false)} />}
    </>
  );
}

function SendMessageModal({ onSend, onClose }: { onSend: (title: string, message: string) => void; onClose: () => void }) {
  const [t, setT] = useState('Message from IT');
  const [m, setM] = useState('');
  return (
    <Modal onClose={onClose} label="Send a message to this device" width="max-w-md">
      <ModalBody className="space-y-3 p-5">
        <div className="flex items-center gap-2.5">
          <span className="grid place-items-center h-9 w-9 rounded-xl bg-accent-soft text-accent shrink-0"><MessageSquare className="w-4 h-4" /></span>
          <div className="font-display font-semibold">Send a message to this device</div>
        </div>
        <Input value={t} onChange={e => setT(e.target.value)} placeholder="Title" />
        <Textarea autoFocus value={m} onChange={e => setM(e.target.value)} placeholder="Message…" rows={4} />
        <p className="text-xs text-muted">Pops up on the device screen as a dialog and a notification.</p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={!m.trim()}
                onClick={() => { onSend(t.trim() || 'Message', m.trim()); onClose(); setM(''); }}>Send</Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Server-controlled agent self-update. Issues INSTALL_APP targeting the agent's
 * own package; the agent acks up-front (it gets killed mid-swap), then reconnects
 * on the new build — confirm via "Refresh device info" → agent_version_code.
 * Never automatic: only fires when an operator pushes it here.
 *
 * Two sources (operator picks in the modal):
 *   1. GitHub / configured URL — the enrollment config's apk_download_url
 *      (INSTALL_APP with download_url). The "set it once" path.
 *   2. Manual APK — upload an .apk here & now; it's stored via the file-service
 *      and pushed by object id (INSTALL_APP with download_object_id). The
 *      "I have this exact build in my hand" path. No agent change needed — the
 *      agent already resolves either source.
 */
function UpdateAgentBtn({ cmd, disabled, title }: {
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  disabled?: boolean; title?: string;
}) {
  const { data: cfg } = useQuery({
    queryKey: ['enroll-config'],
    queryFn: () => getEnrollmentConfig().catch(() => null),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = cfg?.apk_download_url?.trim();
  const pkg = cfg?.dpc_package_name?.trim() || 'com.mdm.agent';

  const pushUrl = () => {
    if (!url) return;
    cmd.mutate({ kind: 'INSTALL_APP', payload: { package_name: pkg, download_url: url } });
    setOpen(false);
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const obj = await uploadFile(file, 'apk');
      cmd.mutate({ kind: 'INSTALL_APP', payload: { package_name: pkg, download_object_id: obj.id } });
      toast.success(`Uploaded ${file.name} — pushing update`);
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'APK upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <ActionTile
        icon={<DownloadCloud className="w-4 h-4" />} label="Update agent…"
        disabled={disabled}
        title={title}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Modal onClose={() => setOpen(false)} label="Update the MDM agent" width="max-w-lg">
          <ModalBody className="space-y-4">
            <div>
              <h3 className="text-base font-semibold text-fg">Update the MDM agent</h3>
              <p className="mt-1 text-[13px] text-muted leading-relaxed">
                The device installs the agent APK, then briefly disconnects and reconnects on
                the new version. On non-Device-Owner devices the user must tap to confirm.
                Confirm afterward via “Refresh device info” → agent version.
              </p>
            </div>

            {/* Option 1 — configured URL (GitHub) */}
            <div className="rounded-xl border border-line p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                <Github className="w-4 h-4 text-faint" /> From configured URL (GitHub)
              </div>
              <p className="mt-1 text-2xs text-faint break-all">
                {url || 'No APK URL set — configure it in Enrollment → Agent APK first.'}
              </p>
              <Button className="mt-3" size="sm" disabled={!url || cmd.isPending} onClick={pushUrl}>
                Push from URL
              </Button>
            </div>

            {/* Option 2 — manual APK upload */}
            <div className="rounded-xl border border-line p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                <UploadCloud className="w-4 h-4 text-faint" /> Manual APK
              </div>
              <p className="mt-1 text-2xs text-faint">
                Upload an .apk from your computer; it’s stored and pushed to this device by id.
              </p>
              <input
                ref={fileRef} type="file" accept=".apk,application/vnd.android.package-archive"
                className="hidden"
                onChange={e => onPickFile(e.target.files?.[0])}
              />
              <Button className="mt-3" size="sm" variant="secondary" disabled={uploading || cmd.isPending}
                      onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading…' : 'Choose APK & push'}
              </Button>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
}

function WipeBtn({ onConfirm, disabled, title }: { onConfirm: () => void; disabled?: boolean; title?: string }) {
  return (
    <ActionTile
      icon={<Eraser className="w-4 h-4" />} label="Factory wipe…" tone="danger"
      disabled={disabled} title={title}
      onClick={async () => {
        if (await confirmDialog({
          title: 'Factory-reset this device?',
          message: 'Everything on the device is erased — apps, data, accounts — and it returns to the out-of-box screen. This cannot be undone.',
          confirmLabel: 'Wipe device', requireText: 'WIPE', icon: Eraser,
        })) onConfirm();
      }}
    />
  );
}

// Profile Owner only: removes just the work profile (no factory reset). Distinct
// from the destructive WipeBtn — safe, reversible by re-enrolling.
function RemoveWorkProfileBtn({ onConfirm, disabled, title }: { onConfirm: () => void; disabled?: boolean; title?: string }) {
  return (
    <ActionTile
      icon={<Trash2 className="w-4 h-4" />} label="Remove work profile…" tone="danger"
      disabled={disabled} title={title}
      onClick={async () => {
        if (await confirmDialog({
          title: 'Remove the work profile?',
          message: 'Deletes the managed work profile and all its apps and data on the device. The personal side is untouched and there is NO factory reset. Management ends until the device re-enrolls.',
          confirmLabel: 'Remove profile', requireText: 'REMOVE', icon: Trash2,
        })) onConfirm();
      }}
    />
  );
}

function LiveLocationCard({ device }: { device: Device }) {
  if (device.last_latitude == null || device.last_longitude == null) {
    return (
      <SectionCard icon={<MapPin className="w-[18px] h-[18px]" />} title="Live location" tone="muted">
        <p className="text-sm text-muted">
          No location reported yet. The agent piggybacks a GPS fix on each heartbeat (refreshed every ~5 min).
          Make sure location is enabled on the device and ACCESS_FINE_LOCATION is granted (auto-granted in DO mode).
        </p>
      </SectionCard>
    );
  }
  const lat = device.last_latitude;
  const lng = device.last_longitude;
  const acc = device.last_location_accuracy_m;
  const at = device.last_location_at;
  const mapURL = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  const embedSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.003},${lng + 0.005},${lat + 0.003}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <SectionCard icon={<MapPin className="w-[18px] h-[18px]" />} title="Live location" tone="info"
                 actions={<span className="text-xs text-muted">{formatRelative(at)}</span>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="text-sm rounded-xl border border-line bg-surface-2/50 p-3">
          <div className="text-2xs uppercase tracking-wide text-muted">Coordinates</div>
          <code className="text-xs">{lat.toFixed(5)}, {lng.toFixed(5)}</code>
          {acc != null && <div className="text-xs text-muted mt-1">±{Math.round(acc)} m</div>}
          <a href={mapURL} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline mt-2 inline-flex items-center gap-1">
            Open in OpenStreetMap <ChevronRight className="w-3 h-3" />
          </a>
        </div>
        <div className="md:col-span-2 rounded-xl overflow-hidden border border-line shadow-xs">
          <iframe
            title="map"
            src={embedSrc}
            className="w-full h-48 block"
            style={{ border: 0 }}
            referrerPolicy="no-referrer-when-downgrade"
            loading="lazy" />
        </div>
      </div>
    </SectionCard>
  );
}

function ConnectionPill({ online, lastHeartbeat }: { online: boolean; lastHeartbeat?: string }) {
  if (online) {
    return (
      <span title={`Last heartbeat ${formatRelative(lastHeartbeat)}`}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium bg-success-soft text-success">
        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
        Connected
      </span>
    );
  }
  return (
    <span title={lastHeartbeat ? `Last seen ${formatRelative(lastHeartbeat)}` : 'Never heartbeated'}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium bg-surface-2 text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-faint" />
      Disconnected {lastHeartbeat ? `· ${formatRelative(lastHeartbeat)}` : ''}
    </span>
  );
}

// stateBadge maps a device/command state to a shared Badge tone + dot, so the
// hero chip and every Commands-tab row read as the same design system as the
// rest of the page (and track light/dark theming).
const STATE_TONE: Record<string, { tone: BadgeTone; dot: boolean }> = {
  enrolled:     { tone: 'success', dot: true },
  succeeded:    { tone: 'success', dot: true },
  offline:      { tone: 'warn',    dot: true },
  timed_out:    { tone: 'warn',    dot: true },
  pending:      { tone: 'default', dot: false },
  wiped:        { tone: 'danger',  dot: true },
  failed:       { tone: 'danger',  dot: true },
  dispatched:   { tone: 'info',    dot: true },
  acknowledged: { tone: 'info',    dot: true },
  retired:      { tone: 'muted',   dot: false },
};

function StateBadge({ state }: { state: string }) {
  const { tone, dot } = STATE_TONE[state] ?? { tone: 'default', dot: false };
  return <Badge tone={tone} dot={dot} className="uppercase tracking-wide">{state}</Badge>;
}

function DeviceInfoCard({ device, info }: { device: Device; info: Record<string, unknown> | null }) {
  // Prefer live values from the 60s heartbeat (kept fresh on the server row,
  // re-fetched by the parent every 5s) and fall back to the FETCH_DEVICE_INFO
  // snapshot for fields not in the heartbeat. Without this overlay, battery /
  // ip / wifi ssid would display whatever they were at the moment the page
  // first auto-fired FETCH_DEVICE_INFO and never change.
  const battery = device.last_battery_pct ?? (info?.battery_pct as number | undefined);
  const charging = device.last_charging ?? (info?.charging as boolean | undefined);
  const network = device.last_network_type ?? (info?.network as string | undefined);
  const ssid = device.last_wifi_ssid ?? (info?.wifi_ssid as string | undefined);
  const ip = device.last_ip_address ?? (info?.ip_address as string | undefined);
  const mac = device.last_mac_address ?? (info?.mac_address as string | undefined);
  const storageFree = device.last_storage_free_bytes ?? (info?.storage_free_bytes as number | undefined);

  if (!info && battery == null && network == null) return null;
  const rows: Array<[string, React.ReactNode]> = [
    ['Manufacturer', (info?.manufacturer as string) ?? device.manufacturer ?? '—'],
    ['Model', (info?.model as string) ?? device.model ?? '—'],
    ['Android', `${info?.android_version ?? device.os_version ?? '—'} (SDK ${info?.sdk ?? '?'})`],
    ['Patch level', (info?.patch_level as string) ?? device.security_patch_level ?? '—'],
    ['Storage', formatStorage(storageFree as number | undefined, info?.storage_total_bytes as number | undefined)],
    ['Battery', battery != null ? `${battery}%${charging ? ' (charging)' : ''}` : '—'],
    ['Network', `${network ?? '—'}${ssid ? ` · ${ssid}` : ''}`],
    ['IP address', ip ? <code className="text-xs">{ip}</code> : '—'],
    ['MAC address', mac ? <code className="text-xs">{mac}</code> : '—'],
    ['Agent', `${info?.agent_version ?? '—'}${info?.device_owner ? ' • Device Owner' : info?.admin_active ? ' • Device Admin' : ''}`],
    ['Integrity', info ? renderFlags(info) : '—'],
    ['Last heartbeat', device.last_heartbeat_at ? formatRelative(device.last_heartbeat_at) : '—']
  ];
  const rowIcon: Record<string, React.ReactNode> = {
    Storage: <HardDrive className="w-3.5 h-3.5" />,
    Network: <Network className="w-3.5 h-3.5" />,
    Integrity: <Fingerprint className="w-3.5 h-3.5" />
  };
  return (
    <SectionCard icon={<Cpu className="w-[18px] h-[18px]" />} title="Device info" tone="muted">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between items-center gap-2 border-b border-line/70 py-1.5">
            <dt className="text-muted text-xs uppercase tracking-wide flex items-center gap-1.5">
              {rowIcon[k] && <span className="text-faint">{rowIcon[k]}</span>}{k}
            </dt>
            <dd className="text-right font-medium">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function renderFlags(info: Record<string, unknown>) {
  const flags: Array<[string, boolean]> = [
    ['rooted', !!info.rooted], ['debuggable', !!info.debuggable],
    ['emulator', !!info.emulator], ['adb', !!info.adb_enabled]
  ];
  const on = flags.filter(([, v]) => v).map(([k]) => k);
  if (on.length === 0) {
    return <span className="inline-flex items-center gap-1 text-success font-medium"><ShieldCheck className="w-3.5 h-3.5" /> clean</span>;
  }
  return <span className="inline-flex items-center gap-1 text-danger font-medium"><AlertTriangle className="w-3.5 h-3.5" /> {on.join(', ')}</span>;
}

function formatStorage(free?: number, total?: number) {
  if (!total) return '—';
  const fmt = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  return free != null ? `${fmt(free)} free of ${fmt(total)}` : fmt(total);
}

// Loading skeleton that mirrors the real page anatomy (hero banner → tab bar →
// content cards) so the layout doesn't jump when data lands.
function Skeleton() {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6 shadow-sm">
        <UiSkeleton className="h-3 w-40" />
        <div className="mt-4 flex items-start gap-4">
          <UiSkeleton className="h-14 w-14 rounded-2xl shrink-0" />
          <div className="flex-1 space-y-2.5">
            <UiSkeleton className="h-7 w-64 max-w-full" />
            <UiSkeleton className="h-4 w-44" />
            <div className="flex gap-2 pt-1">
              {Array.from({ length: 4 }).map((_, i) => <UiSkeleton key={i} className="h-5 w-20 rounded-full" />)}
            </div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {Array.from({ length: 4 }).map((_, i) => <UiSkeleton key={i} className="h-[3.75rem] rounded-xl" />)}
        </div>
      </div>
      <UiSkeleton className="h-12 rounded-xl" />
      <UiSkeleton className="h-44 rounded-2xl" />
      <UiSkeleton className="h-64 rounded-2xl" />
    </div>
  );
}
