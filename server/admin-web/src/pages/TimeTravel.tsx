import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fleetAsOf, deviceHistory, type Snapshot, type AuditEntry } from '../api/timetravel';
import { listUsers } from '../api/auth';
import { type Device } from '../api/devices';
import { DeviceMap } from '../components/DeviceMap';
import { ModeBadge } from '../components/DeviceMode';
import { formatRelative } from '../components/online';
import { Card, Panel, Button, Input, EmptyState, IconButton, Badge, PageHero, Skeleton, cn, Hairline, Modal, ModalBody } from '../components/ui';
import { Donut, chartColor } from '../components/charts';
import { History, X, Clock, MapPin, Layers, ScrollText, Rewind, Battery, ArrowRight, Activity, Route } from 'lucide-react';

// Map a historical snapshot onto the Device shape DeviceMap/labels expect.
function asDevice(s: Snapshot): Device {
  return {
    id: s.device_id,
    tenant_id: '',
    alias: s.alias,
    serial_number: s.serial_number ?? undefined,
    last_latitude: s.latitude ?? undefined,
    last_longitude: s.longitude ?? undefined,
    last_heartbeat_at: s.captured_at,
    last_mgmt_mode: s.mgmt_mode ?? undefined,
    last_battery_pct: s.battery_pct ?? undefined,
    state: (s.state as Device['state']) ?? 'enrolled',
    applied_policy_version: s.applied_policy_version ?? 0
  } as Device;
}

function label(s: { alias?: string | null; serial_number?: string | null; device_id: string }): string {
  return (s.alias && s.alias.trim()) || s.serial_number || s.device_id.slice(0, 8);
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TimeTravel() {
  const [atLocal, setAtLocal] = useState(toLocalInput(new Date()));
  const atISO = useMemo(() => {
    const d = new Date(atLocal);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }, [atLocal]);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['timetravel-fleet', atISO],
    queryFn: () => fleetAsOf(atISO)
  });
  const { data: users } = useQuery({ queryKey: ['tenant-users'], queryFn: listUsers, retry: false, staleTime: 60_000 });

  const userEmail = useMemo(() => new Map((users ?? []).map(u => [u.id, u.email])), [users]);
  const deviceName = useMemo(
    () => new Map((data?.devices ?? []).map(s => [s.device_id, label(s)])),
    [data]
  );

  const fleetDevices = (data?.devices ?? []).map(asDevice);
  const atDate = new Date(atISO);

  // Distributable summaries of the reconstructed fleet — presentation-only,
  // derived from the already-fetched snapshot rows.
  const fleetStats = useMemo(() => {
    const rows = data?.devices ?? [];
    const total = rows.length;
    const modes = new Map<string, number>();
    let healthy = 0, low = 0, critical = 0, located = 0;
    let topPolicy = 0;
    for (const s of rows) {
      const mode = s.mgmt_mode ?? 'unknown';
      modes.set(mode, (modes.get(mode) ?? 0) + 1);
      if (s.battery_pct != null) {
        if (s.battery_pct <= 20) critical++;
        else if (s.battery_pct <= 50) low++;
        else healthy++;
      }
      if (s.latitude != null && s.longitude != null) located++;
      topPolicy = Math.max(topPolicy, s.applied_policy_version ?? 0);
    }
    const palette = [chartColor.accent, chartColor.info, chartColor.success, chartColor.warn, chartColor.muted];
    const modeSegs = [...modes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([mlabel, value], i) => ({ label: mlabel, value, color: palette[i % palette.length] }));
    const onPolicy = rows.filter(s => (s.applied_policy_version ?? 0) === topPolicy).length;
    return { total, modeSegs, healthy, low, critical, located, topPolicy, onPolicy };
  }, [data]);

  const preset = (ms: number) => () => setAtLocal(toLocalInput(new Date(Date.now() - ms)));

  const actorLabel = (e: AuditEntry) => {
    if (e.actor_kind === 'user') return (e.actor_id && userEmail.get(e.actor_id)) || 'a user';
    if (e.actor_kind === 'device') return (e.actor_id && deviceName.get(e.actor_id)) || 'a device';
    return 'system';
  };
  const targetLabel = (e: AuditEntry) => {
    const id = e.target_id ?? (e.metadata?.device_id as string | undefined);
    if (e.target_kind === 'device' && id) return deviceName.get(id) ?? `device ${id.slice(0, 8)}…`;
    return e.target_kind ?? '';
  };

  const presets: [string, number][] = [['Now', 0], ['−1h', 3600e3], ['−6h', 6 * 3600e3], ['−24h', 24 * 3600e3], ['−7d', 7 * 24 * 3600e3]];

  // Approximate which preset the current "at" falls on, for active-state highlight.
  const ageMs = Date.now() - atDate.getTime();
  const activePreset = (() => {
    if (ageMs < 90e3) return 0;
    let best = -1, bestDelta = Infinity;
    for (const [, ms] of presets) {
      if (ms === 0) continue;
      const d = Math.abs(ageMs - ms);
      if (d < bestDelta && d < ms * 0.06) { bestDelta = d; best = ms; }
    }
    return best;
  })();

  const deviceCount = fleetDevices.length;
  const actionCount = data?.actions.length ?? 0;
  const isNow = ageMs < 90e3;

  return (
    <div className="space-y-5">
      {/* ---------------- Time-machine hero ---------------- */}
      <PageHero
        icon={Rewind}
        eyebrow={<><Clock size={13} className="text-accent" /> Fleet reconstruction</>}
        title="Time travel"
        subtitle="Reconstruct the fleet at any past moment from the append-only snapshot history and audit log."
        stats={<>
          <Badge tone={isNow ? 'success' : 'accent'} dot>
            {isNow ? 'Live · now' : atDate.toLocaleString()}
          </Badge>
          <Badge tone="info"><Layers size={11} /> {deviceCount} device{deviceCount === 1 ? '' : 's'}</Badge>
          <Badge tone="muted"><ScrollText size={11} /> {actionCount} action{actionCount === 1 ? '' : 's'}</Badge>
        </>}
      />

      {/* ---------------- Point in time ---------------- */}
      <Panel
        icon={Clock}
        title="Point in time"
        subtitle="Scrub to any past moment to reconstruct the fleet"
        className="relative overflow-hidden card-grad ring-1 ring-inset ring-line animate-slideup"
      >
        <Hairline />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-2.5">
            <span className="text-2xs font-semibold uppercase tracking-wider text-faint">As of</span>
            <Input type="datetime-local" value={atLocal} onChange={e => setAtLocal(e.target.value)} className="w-auto h-9" />
          </div>
          <span className="hidden sm:block h-6 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-faint">Jump to</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map(([lbl, ms]) => {
                const active = (ms === 0 && isNow) || (ms !== 0 && activePreset === ms);
                return (
                  <Button key={lbl} size="sm" variant={active ? 'primary' : 'subtle'}
                    className={cn('tabular-nums', active && 'ring-1 ring-inset ring-white/15')}
                    onClick={() => ms === 0 ? setAtLocal(toLocalInput(new Date())) : preset(ms)()}>
                    {lbl}
                  </Button>
                );
              })}
            </div>
          </div>
          <Badge tone={isNow ? 'success' : 'accent'} dot className="ml-auto tabular-nums">
            {isNow ? 'Live · now' : atDate.toLocaleString()}
          </Badge>
        </div>
      </Panel>

      {/* ---------------- Fleet location ---------------- */}
      <Panel
        icon={MapPin}
        title="Fleet location"
        subtitle={`Last-known positions as of ${atDate.toLocaleString()}`}
        actions={<Badge tone="info"><Layers size={11} /> {deviceCount} mapped</Badge>}
        className="overflow-hidden animate-slideup"
        bodyClassName="p-0"
      >
        <DeviceMap devices={fleetDevices} height={360} />
      </Panel>

      {/* ---------------- Fleet composition (data-viz) ---------------- */}
      {!isLoading && fleetStats.total > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 animate-slideup">
          {/* Management-mode distribution */}
          <Card className="relative overflow-hidden card-grad ring-1 ring-inset ring-line p-4">
            <Hairline />
            <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-3">
              <Layers size={12} className="text-accent" /> Management mode
            </div>
            <div className="flex items-center gap-4">
              <Donut
                size={108}
                thickness={13}
                segments={fleetStats.modeSegs}
                center={<>
                  <span className="text-xl font-semibold text-fg tabular-nums leading-none">{fleetStats.total}</span>
                  <span className="text-2xs uppercase tracking-wider text-faint mt-0.5">devices</span>
                </>}
              />
              <ul className="min-w-0 flex-1 space-y-1.5">
                {fleetStats.modeSegs.map(seg => (
                  <li key={seg.label} className="flex items-center gap-2 text-xs">
                    <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
                    <span className="text-muted truncate flex-1">{seg.label}</span>
                    <span className="text-fg font-medium tabular-nums">{seg.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          {/* Battery health breakdown */}
          <Card className="relative overflow-hidden card-grad ring-1 ring-inset ring-line p-4">
            <Hairline />
            <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-3">
              <Battery size={12} className="text-accent" /> Battery health
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {([
                ['Healthy', fleetStats.healthy, 'text-success', 'bg-success/10 ring-success/20'],
                ['Low', fleetStats.low, 'text-warn', 'bg-warn/10 ring-warn/20'],
                ['Critical', fleetStats.critical, 'text-danger', 'bg-danger/10 ring-danger/20'],
              ] as const).map(([lbl, val, fg, chip]) => (
                <div key={lbl} className={cn('rounded-xl ring-1 ring-inset px-3 py-2.5 text-center', chip)}>
                  <div className={cn('text-2xl font-semibold tabular-nums leading-none', fg)}>{val}</div>
                  <div className="mt-1.5 text-2xs uppercase tracking-wider text-faint">{lbl}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-2xs text-faint">{'>50% healthy · 21–50% low · ≤20% critical'}</p>
          </Card>

          {/* Coverage: location fixes + policy convergence */}
          <Card className="relative overflow-hidden card-grad ring-1 ring-inset ring-line p-4">
            <Hairline />
            <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-3">
              <MapPin size={12} className="text-accent" /> Coverage
            </div>
            <div className="space-y-3">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted">Located</span>
                  <span className="text-sm font-medium text-fg tabular-nums">
                    {fleetStats.located} <span className="text-faint">of {fleetStats.total}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${fleetStats.total ? (fleetStats.located / fleetStats.total) * 100 : 0}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted">On policy v{fleetStats.topPolicy}</span>
                  <span className="text-sm font-medium text-fg tabular-nums">
                    {fleetStats.onPolicy} <span className="text-faint">of {fleetStats.total}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <span className="block h-full rounded-full bg-info" style={{ width: `${fleetStats.total ? (fleetStats.onPolicy / fleetStats.total) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ---------------- Fleet snapshot ---------------- */}
      <Panel
        icon={Layers}
        title="Fleet snapshot"
        subtitle={`Devices observed at or before ${atDate.toLocaleString()}`}
        actions={!isLoading && deviceCount > 0 ? <Badge tone="muted" className="tabular-nums">{deviceCount} device{deviceCount === 1 ? '' : 's'}</Badge> : undefined}
        className="animate-slideup"
        bodyClassName="p-0"
      >
        {isLoading ? (
          <div className="divide-y divide-line">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <Skeleton className="w-7 h-7 rounded-lg shrink-0" />
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3.5 w-16 ml-auto" />
                <Skeleton className="h-3.5 w-14" />
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-20" />
              </div>
            ))}
          </div>
        ) : fleetDevices.length === 0 ? (
          <EmptyState
            icon={<span className="grid place-items-center h-12 w-12 rounded-2xl bg-accent-soft text-accent"><History size={22} /></span>}
            title="No snapshots at this time"
            hint="No device reported state at or before this moment. Try jumping to a more recent point in time."
            action={<Button size="sm" variant="primary" onClick={() => setAtLocal(toLocalInput(new Date()))}>
              <Clock size={13} /> Jump to now
            </Button>}
          />
        ) : (
          <div className="overflow-x-auto max-h-[36rem] overflow-y-auto">
            <table className="w-full text-sm min-w-[820px]">
              <thead className="sticky top-0 z-10">
                <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2">
                  <th className="px-4 py-2.5 font-semibold">Device</th>
                  <th className="px-4 py-2.5 font-semibold">Mode</th>
                  <th className="px-4 py-2.5 font-semibold">Battery</th>
                  <th className="px-4 py-2.5 font-semibold">Network</th>
                  <th className="px-4 py-2.5 font-semibold">Location</th>
                  <th className="px-4 py-2.5 font-semibold">Policy</th>
                  <th className="px-4 py-2.5 font-semibold">Observed</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="rail divide-y divide-line">
                {data!.devices.map((s, i) => (
                  <tr key={s.device_id} className="group/row hover:bg-surface-2 transition-colors animate-fadein"
                      style={{ animationDelay: `${Math.min(i * 28, 280)}ms` }}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="grid place-items-center w-7 h-7 rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 text-2xs font-semibold shrink-0 transition-colors group-hover/row:bg-accent/15">
                          {label(s).slice(0, 2).toUpperCase()}
                        </span>
                        <span className="font-medium text-fg truncate">{label(s)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><ModeBadge mode={s.mgmt_mode} /></td>
                    <td className="px-4 py-3 tabular-nums">
                      {s.battery_pct != null ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                          <Battery size={13} className={cn(s.battery_pct <= 20 ? 'text-danger' : s.battery_pct <= 50 ? 'text-warn' : 'text-success')} />
                          {s.battery_pct}%
                        </span>
                      ) : <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-muted">{s.network_type ?? '—'}{s.wifi_ssid ? ` · ${s.wifi_ssid}` : ''}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted tabular-nums">{s.latitude != null && s.longitude != null ? `${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}` : <span className="text-faint">—</span>}</td>
                    <td className="px-4 py-3"><Badge tone="muted" className="tabular-nums">v{s.applied_policy_version ?? 0}</Badge></td>
                    <td className="px-4 py-3 text-xs text-faint tabular-nums" title={s.captured_at}>{formatRelative(s.captured_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setSelected(s.device_id)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors">
                        History <ArrowRight size={13} className="transition-transform group-hover/row:translate-x-0.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ---------------- Who did what ---------------- */}
      <Panel
        icon={ScrollText}
        title="Who did what"
        subtitle={`Actions recorded up to ${atDate.toLocaleString()}`}
        actions={data && data.actions.length > 0 ? <Badge tone="accent" className="tabular-nums">{actionCount} action{actionCount === 1 ? '' : 's'}</Badge> : undefined}
        className="animate-slideup"
        bodyClassName="p-0"
      >
        {(!data || data.actions.length === 0) ? (
          <EmptyState
            icon={<span className="grid place-items-center h-12 w-12 rounded-2xl bg-accent-soft text-accent"><History size={22} /></span>}
            title="No actions in range"
            hint="No admin or device actions were recorded before this time."
          />
        ) : (
          <div className="max-h-96 overflow-auto">
            <div className="sticky top-0 z-10 grid grid-cols-[5rem_1fr_auto_auto] items-center gap-3 px-4 py-2.5 text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2">
              <span>Time</span>
              <span>Actor</span>
              <span>Action</span>
              <span className="text-right">Target</span>
            </div>
            <ul className="divide-y divide-line">
              {data.actions.map((e, i) => {
                const target = targetLabel(e);
                return (
                  <li key={e.id} className="group/audit grid grid-cols-[5rem_1fr_auto_auto] items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-2 transition-colors animate-fadein"
                      style={{ animationDelay: `${Math.min(i * 24, 240)}ms` }}>
                    <span className="text-2xs text-faint shrink-0 tabular-nums truncate" title={e.created_at}>{formatRelative(e.created_at)}</span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="grid place-items-center w-7 h-7 rounded-lg bg-surface-2 text-muted ring-1 ring-inset ring-line shrink-0 group-hover/audit:text-accent group-hover/audit:ring-accent/20 transition-colors">
                        <Activity size={13} />
                      </span>
                      <span className="font-medium text-xs text-fg truncate">{actorLabel(e)}</span>
                    </span>
                    <code className="text-2xs text-accent font-mono px-1.5 py-0.5 rounded bg-accent/10 ring-1 ring-inset ring-accent/15 truncate">{e.action}</code>
                    <span className="text-xs text-faint truncate text-right">{target}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      {selected && <DeviceHistoryPanel deviceID={selected} at={atISO} onClose={() => setSelected(null)} name={deviceName.get(selected) ?? selected.slice(0, 8)} />}
    </div>
  );
}

function DeviceHistoryPanel({ deviceID, at, onClose, name }: { deviceID: string; at: string; onClose: () => void; name: string }) {
  const to = at;
  const from = useMemo(() => new Date(new Date(at).getTime() - 24 * 3600e3).toISOString(), [at]);
  const { data, isLoading } = useQuery({
    queryKey: ['timetravel-device', deviceID, from, to],
    queryFn: () => deviceHistory(deviceID, from, to)
  });
  const track = (data?.snapshots ?? []).map(asDevice);
  const fixes = track.filter(d => d.last_latitude != null).length;

  return (
    <Modal onClose={onClose} label={`History for ${name}`} width="max-w-4xl" className="max-h-[90vh]">
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="flex items-center gap-3 min-w-0">
            <span className="grid place-items-center w-9 h-9 rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 shrink-0">
              <History size={16} />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm font-semibold text-fg truncate">{name}</h3>
              <p className="text-xs text-muted">Last 24h before {new Date(at).toLocaleString()}</p>
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <ModalBody className="p-5 space-y-5">
        {isLoading && (
          <>
            <div>
              <Skeleton className="h-3 w-32 mb-2" />
              <Skeleton className="h-[260px] w-full rounded-xl" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-line bg-surface-2/40 p-3.5 space-y-2">
                  <Skeleton className="h-3 w-28" />
                  {Array.from({ length: 4 }).map((_, j) => <Skeleton key={j} className="h-3.5 w-full" />)}
                </div>
              ))}
            </div>
          </>
        )}
        {!isLoading && (
          <>
            <div>
              <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-2">
                <Route size={12} className="text-accent" /> Location track
                <Badge tone="info" className="normal-case tracking-normal">{fixes} fix{fixes === 1 ? '' : 'es'}</Badge>
              </div>
              <Card className="overflow-hidden"><DeviceMap devices={track} height={260} track /></Card>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2/40 p-3.5">
                <Hairline tone="faint" />
                <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-2">
                  <Activity size={12} className="text-accent" /> State over time
                </div>
                <ul className="text-xs divide-y divide-line/60 max-h-64 overflow-auto -mx-1">
                  {data?.snapshots.slice().reverse().map(s => (
                    <li key={s.captured_at} className="flex justify-between gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-2 transition-colors">
                      <span className="text-faint tabular-nums shrink-0">{new Date(s.captured_at).toLocaleTimeString()}</span>
                      <span className="text-fg font-medium truncate text-right">{s.mgmt_mode ?? '—'} · {s.battery_pct != null ? `${s.battery_pct}%` : '—'} · {s.network_type ?? '—'}</span>
                    </li>
                  ))}
                  {(!data || data.snapshots.length === 0) && <li className="text-faint px-1.5 py-2 text-center">No snapshots in this window.</li>}
                </ul>
              </div>
              <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2/40 p-3.5">
                <Hairline tone="faint" />
                <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-faint mb-2">
                  <ScrollText size={12} className="text-accent" /> Actions on this device
                </div>
                <ul className="text-xs divide-y divide-line/60 max-h-64 overflow-auto -mx-1">
                  {data?.actions.map(e => (
                    <li key={e.id} className="flex gap-2 items-center rounded-md px-1.5 py-1.5 hover:bg-surface-2 transition-colors">
                      <span className="text-faint w-20 shrink-0 tabular-nums">{new Date(e.created_at).toLocaleTimeString()}</span>
                      <code className="text-2xs text-accent font-mono px-1.5 py-0.5 rounded bg-accent/10 ring-1 ring-inset ring-accent/15 truncate">{e.action}</code>
                    </li>
                  ))}
                  {(!data || data.actions.length === 0) && <li className="text-faint px-1.5 py-2 text-center">No actions in this window.</li>}
                </ul>
              </div>
            </div>
          </>
        )}
        </ModalBody>
    </Modal>
  );
}
