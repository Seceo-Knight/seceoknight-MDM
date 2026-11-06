import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDevices, deviceLabel } from '../api/devices';
import { listPolicies } from '../api/policies';
import { listUsers } from '../api/auth';
import { listGeofences } from '../api/geofences';
import { useEventStream } from '../hooks/useWebSocket';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isOnline, formatRelative } from '../components/online';
import { api } from '../api/client';
import { DeviceMap } from '../components/DeviceMap';
import { Stat, Panel, Badge, EmptyState, PageHero, HeroStat, Button, Hairline } from '../components/ui';
import { Donut, MiniBars, chartColor } from '../components/charts';
import { Smartphone, Wifi, ShieldCheck, Activity as ActivityIcon, Layers, Radio, MapPin, Gauge, Cpu, ShieldAlert, TrendingUp, TrendingDown, Minus, Brain, AlertTriangle } from 'lucide-react';
import { listAnomalies, type Anomaly, ANOMALY_META, SEVERITY_META } from '../api/anomalies';

interface AuditRow { id: string; actor_kind: string; actor_id?: string; action: string; target_id?: string; metadata?: Record<string, unknown>; created_at: string }

export function Dashboard() {
  const [events, setEvents] = useState<{ t: string; subject: string; live: boolean }[]>([]);
  const seededRef = useRef(false);
  useEventStream(e => setEvents(prev => [{ t: new Date().toLocaleTimeString(), subject: e.subject, live: true }, ...prev].slice(0, 80)));

  const { data: devices } = useQuery({ queryKey: ['devices', 'all'], queryFn: () => listDevices({ limit: 500 }), refetchInterval: 10000 });
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const { data: users } = useQuery({ queryKey: ['tenant-users'], queryFn: listUsers, retry: false, staleTime: 60_000 });
  const { data: geofences = [] } = useQuery({ queryKey: ['geofences'], queryFn: listGeofences, staleTime: 30_000 });
  const { data: anomalies = [] } = useQuery({ queryKey: ['anomalies'], queryFn: () => listAnomalies(50), staleTime: 60_000, refetchInterval: 60_000 });
  const { data: audit } = useQuery({
    queryKey: ['audit', 'dashboard'],
    queryFn: async () => (await api.get<{ items: AuditRow[] }>('/api/v1/audit?limit=200')).data.items,
    refetchInterval: 5000
  });

  // Seed the live stream from recent audit so it's never empty; live WS events
  // prepend on top of the seed as they arrive.
  useEffect(() => {
    if (!seededRef.current && audit && audit.length) {
      seededRef.current = true;
      const seed = audit.slice(0, 50).map(e => ({ t: new Date(e.created_at).toLocaleTimeString(), subject: e.action, live: false }));
      setEvents(prev => [...prev, ...seed].slice(0, 80));
    }
  }, [audit]);

  const items = devices?.items ?? [];
  const online = items.filter(d => isOnline(d.last_heartbeat_at)).length;
  const enrolled = items.filter(d => d.state === 'enrolled').length;
  const pending = items.filter(d => d.state === 'pending').length;
  const retired = items.filter(d => d.state === 'retired').length;

  const modes = { owner: 0, admin: 0, none: 0 };
  const posture = { compliant: 0, atRisk: 0, critical: 0, unknown: 0 };
  const stateCounts: Record<string, number> = {};
  const osCounts: Record<string, number> = {};
  for (const d of items) {
    const m = d.last_mgmt_mode === 'owner' ? 'owner' : d.last_mgmt_mode === 'admin' ? 'admin' : 'none';
    modes[m]++;
    const s = d.last_posture_score;
    if (s == null) posture.unknown++;
    else if (s >= 60) posture.compliant++;
    else if (s >= 40) posture.atRisk++;
    else posture.critical++;
    stateCounts[d.state] = (stateCounts[d.state] ?? 0) + 1;
    const os = d.os_version ? `Android ${d.os_version}` : 'Unknown';
    osCounts[os] = (osCounts[os] ?? 0) + 1;
  }
  const compliantPct = items.length ? Math.round((posture.compliant / items.length) * 100) : 0;

  // ── Security Score (0-100) ─────────────────────────────────────────────────
  // Weighted composite of posture health, online ratio, and policy coverage.
  const securityScore = useMemo(() => {
    if (items.length === 0) return null;
    const postureScore = compliantPct;                                        // 60% weight
    const onlineScore  = Math.round((online / items.length) * 100);           // 20% weight
    const policyScore  = (policies?.length ?? 0) > 0 ? 100 : 0;             // 10% weight
    const geoScore     = geofences.filter(g => g.enabled).length > 0 ? 100 : 50; // 10% weight
    return Math.round(postureScore * 0.6 + onlineScore * 0.2 + policyScore * 0.1 + geoScore * 0.1);
  }, [compliantPct, online, items.length, policies?.length, geofences]);
  const osTop = Object.entries(osCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const osMax = Math.max(1, ...osTop.map(([, n]) => n));

  // Audit activity bucketed into the last 24 hours (one bar per hour).
  const activity = useMemo(() => {
    const now = Date.now();
    const buckets = new Array(24).fill(0);
    (audit ?? []).forEach(e => {
      const hrs = (now - new Date(e.created_at).getTime()) / 3_600_000;
      if (hrs >= 0 && hrs < 24) buckets[23 - Math.floor(hrs)]++;
    });
    return { buckets, total: buckets.reduce((a, b) => a + b, 0) };
  }, [audit]);

  const stateColor: Record<string, string> = {
    enrolled: chartColor.success, pending: chartColor.warn, offline: chartColor.muted,
    retired: chartColor.muted, wiped: chartColor.danger,
  };
  const stateSegs = Object.entries(stateCounts).map(([label, value]) => ({ label, value, color: stateColor[label] ?? chartColor.info }));

  const userEmail = useMemo(() => new Map((users ?? []).map(u => [u.id, u.email])), [users]);
  const deviceName = useMemo(() => new Map(items.map(d => [d.id, deviceLabel(d)])), [items]);
  const actor = (e: AuditRow) => e.actor_kind === 'user' ? (e.actor_id && userEmail.get(e.actor_id)) || 'a user'
    : e.actor_kind === 'device' ? (e.actor_id && deviceName.get(e.actor_id)) || 'a device' : 'system';
  const recent = (audit ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Security score ribbon — always visible, theme-aware threat-level indicator */}
      {securityScore !== null && <SecurityRibbon score={securityScore} critical={posture.critical} atRisk={posture.atRisk} geofences={geofences.filter(g => g.enabled).length} aiThreats={anomalies.filter(a => a.severity === 'critical').length} />}

      {/* Command-center hero */}
      <PageHero
        icon={ShieldCheck}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} /> Command center</>}
        title="Fleet Overview"
        subtitle="Real-time posture and activity across your fleet."
        stats={<>
          <HeroStat icon={Smartphone} label="Total" value={devices?.total ?? items.length} tone="accent" />
          <HeroStat icon={Wifi} label="Online" value={online} tone="success" />
          <HeroStat icon={ShieldCheck} label="Compliant" value={`${compliantPct}%`} tone={posture.critical > 0 ? 'danger' : 'info'} />
        </>}
        aside={items.length > 0 ? (
          /* Fleet-health ring — attestation compliance share, straight from
             the posture buckets computed above (no synthetic data). */
          <div className="flex flex-col items-center gap-1 pr-1">
            <Donut
              size={116} thickness={11}
              segments={[
                { value: posture.compliant, color: chartColor.success, label: 'Compliant' },
                { value: posture.atRisk, color: chartColor.warn, label: 'At risk' },
                { value: posture.critical, color: chartColor.danger, label: 'Critical' },
                { value: posture.unknown, color: 'rgb(var(--surface-3))', label: 'Unknown' },
              ]}
              center={<>
                <div className="text-2xl font-semibold leading-none tracking-tight text-fg tabular-nums">{compliantPct}<span className="text-sm text-muted">%</span></div>
                <div className="mt-1 text-2xs uppercase tracking-wider text-faint">healthy</div>
              </>}
            />
            <span className="text-2xs uppercase tracking-[0.14em] text-faint">Fleet health</span>
          </div>
        ) : undefined}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
        <div className="animate-slideup" style={{ animationDelay: '0ms' }}>
          <Stat label="Total devices" value={devices?.total ?? '—'} icon={<Smartphone size={16} />}
                sub={<Link to="/devices" className="text-accent hover:underline">View all</Link>} />
        </div>
        <div className="animate-slideup" style={{ animationDelay: '60ms' }}>
          <Stat label="Online now" value={online} icon={<Wifi size={16} />}
                sub={`${enrolled} enrolled · ${pending} pending`} />
        </div>
        <div className="animate-slideup" style={{ animationDelay: '120ms' }}>
          <Stat label="Compliant" value={`${compliantPct}%`} icon={<ShieldCheck size={16} />}
                accent={posture.critical > 0}
                sub={posture.critical > 0 ? <span className="text-danger">{posture.critical} critical</span> : 'attestation posture'} />
        </div>
        <div className="animate-slideup" style={{ animationDelay: '180ms' }}>
          <Stat label="Policies" value={policies?.length ?? 0} icon={<Layers size={16} />}
                sub={<Link to="/policies" className="text-accent hover:underline">Manage</Link>} />
        </div>
      </div>

      {/* Map + management mode */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-5">
        <Panel icon={MapPin} title="Fleet location" subtitle="Last-known device positions"
               className="relative overflow-hidden card-grad xl:col-span-2 ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md"
               bodyClassName="p-0">
          <Hairline />
          <div className="relative">
            <span className="absolute z-[1] top-3 left-3 inline-flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1 text-2xs font-medium text-muted ring-1 ring-inset ring-line shadow-xs">
              <MapPin size={12} className="text-accent" /> {items.length} positioned
            </span>
            <DeviceMap devices={items} height={360} />
          </div>
        </Panel>

        <Panel icon={Gauge} title="Management mode" subtitle="Privilege level reported by each agent"
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md">
          <Hairline />
          <div className="flex items-center gap-5">
            <Donut size={124} thickness={13}
              segments={[
                { value: modes.owner, color: chartColor.accent, label: 'Owner' },
                { value: modes.admin, color: chartColor.warn, label: 'Admin' },
                { value: modes.none, color: chartColor.muted, label: 'Enrolled-only' },
              ]}
              center={<><div className="text-xl font-semibold text-fg tabular-nums">{items.length}</div><div className="text-2xs text-muted">devices</div></>}
            />
            <ul className="space-y-2 text-sm flex-1">
              <Legend color={chartColor.accent} label="Device Owner" value={modes.owner} />
              <Legend color={chartColor.warn} label="Device Admin" value={modes.admin} />
              <Legend color={chartColor.muted} label="Enrolled-only" value={modes.none} />
            </ul>
          </div>
        </Panel>
      </div>

      {/* Insights: distributions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        <Panel icon={Layers} title="Device states" subtitle="Lifecycle distribution"
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md">
          <Hairline />
          {items.length === 0 ? (
            <EmptyState icon={<Smartphone size={18} />} title="No devices yet"
              hint="Enroll a device to see its lifecycle distribution."
              action={<Link to="/devices"><Button size="sm">Enroll device</Button></Link>} />
          ) : (
            <>
              <ChipTitle label="Lifecycle" />
              <div className="flex items-center gap-5">
                <Donut size={124} thickness={13} segments={stateSegs}
                  center={<><div className="text-xl font-semibold text-fg tabular-nums">{items.length}</div><div className="text-2xs text-muted">total</div></>}
                />
                <ul className="space-y-2 text-sm flex-1">
                  {stateSegs.map(s => <Legend key={s.label} color={s.color} label={s.label} value={s.value} capitalize />)}
                </ul>
              </div>
            </>
          )}
        </Panel>

        <Panel icon={ShieldAlert} title="Attestation posture" subtitle="Conditional-access readiness"
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md">
          <Hairline />
          <div className="space-y-3">
            <PostureBar label="Compliant" value={posture.compliant} total={items.length} color="bg-success" />
            <PostureBar label="At risk" value={posture.atRisk} total={items.length} color="bg-warn" />
            <PostureBar label="Critical" value={posture.critical} total={items.length} color="bg-danger" />
            {posture.unknown > 0 && <PostureBar label="Not attested" value={posture.unknown} total={items.length} color="bg-faint" />}
          </div>
        </Panel>

        <Panel icon={Cpu} title="Operating systems" subtitle="Top OS versions in fleet"
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md">
          <Hairline />
          {osTop.length === 0 ? (
            <EmptyState icon={<Cpu size={18} />} title="No OS data yet"
              hint="OS versions appear once devices report in." />
          ) : (
            <>
              <div className="space-y-3">
                {osTop.map(([os, n]) => (
                  <div key={os} className="group">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-muted truncate">{os}</span>
                      <span className="font-semibold text-fg tabular-nums">{n}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-3 overflow-hidden ring-1 ring-inset ring-line/40">
                      <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 transition-[width] duration-500 ease-out" style={{ width: `${(n / osMax) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>
      </div>

      {/* AI Anomaly widget — only shown when there are unresolved anomalies */}
      {anomalies.length > 0 && (
        <AnomalyWidget anomalies={anomalies} />
      )}

      {/* Activity trend — hidden entirely when there's nothing in the window. */}
      {activity.total > 0 && (
      <Panel icon={ActivityIcon} title="Activity · last 24 hours"
             subtitle={`${activity.total} event${activity.total === 1 ? '' : 's'} recorded`}
             actions={<Link to="/audit" className="text-xs text-accent hover:underline">Audit log</Link>}
             className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md">
        <Hairline />
        <div className="relative text-accent rounded-xl bg-gradient-to-b from-accent/10 via-accent/[0.03] to-transparent px-3 pt-3 pb-0 ring-1 ring-inset ring-line/60">
          <MiniBars values={activity.buckets} height={72} gap={2.5} className="w-full" />
          {/* Soft baseline anchoring the bars. */}
          <span className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
        </div>
        <div className="flex justify-between text-2xs text-faint mt-2 tabular-nums">
          <span>24h ago</span><span>18h</span><span>12h</span><span>6h</span><span>now</span>
        </div>
      </Panel>
      )}

      {/* Activity feeds — only the feeds that actually have data render. The
          whole row collapses to zero height when both are empty, and a lone
          populated feed spans the full width instead of leaving a hollow half. */}
      {(recent.length > 0 || events.length > 0) && (
      <div className={recent.length > 0 && events.length > 0 ? 'grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-5' : 'grid grid-cols-1 gap-4 lg:gap-5'}>
        {recent.length > 0 && (
        <Panel icon={ActivityIcon} title="Recent activity"
               subtitle="Latest admin & device actions"
               actions={<Link to="/audit" className="text-xs text-accent hover:underline">View all</Link>}
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md" bodyClassName="p-0">
          <Hairline />
          <ul className="divide-y divide-line">
            {recent.map((e, i) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-2 animate-fadein" style={{ animationDelay: `${i * 40}ms` }}>
                <Badge tone={e.actor_kind === 'user' ? 'info' : e.actor_kind === 'device' ? 'success' : 'muted'} dot>{e.actor_kind}</Badge>
                <span className="font-medium text-fg truncate">{actor(e)}</span>
                <code className="text-xs text-muted font-mono truncate">{e.action}</code>
                {e.target_id && deviceName.has(e.target_id) && <span className="text-xs text-muted truncate">· {deviceName.get(e.target_id)}</span>}
                <span className="ml-auto text-2xs text-faint whitespace-nowrap tabular-nums" title={e.created_at}>{formatRelative(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        )}

        {events.length > 0 && (
        <Panel icon={Radio} title="Live event stream"
               subtitle="Realtime bus"
               actions={<span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-2xs font-medium text-success ring-1 ring-inset ring-success/20"><span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} />LIVE</span>}
               className="relative overflow-hidden card-grad ring-1 ring-inset ring-line transition-[transform,box-shadow] duration-200 hover:shadow-md"
               bodyClassName="p-0">
          <Hairline />
          <ul className="relative font-mono text-xs max-h-80 overflow-auto divide-y divide-line/60">
            {/* fade mask at top so newest events feel like they stream in */}
            <div className="pointer-events-none sticky top-0 z-[1] h-5 -mb-5 bg-gradient-to-b from-surface to-transparent" />
            {events.map((e, i) => (
              <li key={i} className="group flex items-center gap-2 px-4 py-1.5 whitespace-nowrap transition-colors hover:bg-surface-2">
                {e.live
                  ? <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-success" />
                  : <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-faint" />}
                <span className="text-faint tabular-nums">{e.t}</span>
                <span className="text-muted truncate group-hover:text-fg transition-colors">{e.subject}</span>
                {e.live && <Badge tone="success">new</Badge>}
              </li>
            ))}
          </ul>
        </Panel>
        )}
      </div>
      )}

      {retired > 0 && <p className="text-2xs text-faint">{retired} retired device{retired === 1 ? '' : 's'} not shown.</p>}
    </div>
  );
}

// A quiet in-body category label — pairs with the Panel's icon chip header to
// give each chart block a second, lighter tier of hierarchy.
function ChipTitle({ label }: { label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="h-3 w-0.5 rounded-full bg-gradient-to-b from-indigo-500 to-violet-600" />
      <span className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</span>
    </div>
  );
}

function Legend({ color, label, value, capitalize }: { color: string; label: string; value: number; capitalize?: boolean }) {
  return (
    <li className="group flex items-center justify-between gap-2 rounded-md px-1.5 py-1 -mx-1.5 transition-colors hover:bg-surface-2">
      <span className={`flex items-center gap-2 text-muted ${capitalize ? 'capitalize' : ''}`}>
        <span className="h-2.5 w-2.5 rounded-[3px] ring-1 ring-inset ring-line" style={{ background: color }} />
        {label}
      </span>
      <span className="font-semibold text-fg tabular-nums">{value}</span>
    </li>
  );
}

// ── Security Score ribbon ─────────────────────────────────────────────────────
function SecurityRibbon({ score, critical, atRisk, geofences, aiThreats }: { score: number; critical: number; atRisk: number; geofences: number; aiThreats: number }) {
  const level = score >= 80 ? 'good' : score >= 60 ? 'moderate' : score >= 40 ? 'elevated' : 'critical';
  const levelMeta = {
    good:     { label: 'Good',     bar: 'from-success to-emerald-400',  ring: 'ring-success/30', text: 'text-success',  bg: 'bg-success-soft' },
    moderate: { label: 'Moderate', bar: 'from-warn to-amber-400',       ring: 'ring-warn/30',    text: 'text-warn',    bg: 'bg-warn-soft' },
    elevated: { label: 'Elevated', bar: 'from-orange-500 to-warn',      ring: 'ring-orange-400/30', text: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/40' },
    critical: { label: 'Critical', bar: 'from-danger to-rose-400',      ring: 'ring-danger/30',  text: 'text-danger',  bg: 'bg-danger-soft' },
  }[level];
  const TrendIcon = score >= 80 ? TrendingUp : score >= 60 ? Minus : TrendingDown;

  return (
    <div className={`relative flex flex-wrap items-center gap-4 rounded-2xl border border-line px-5 py-4 ${levelMeta.bg} ring-1 ring-inset ${levelMeta.ring} animate-fadein overflow-hidden`}>
      {/* Background gradient glow */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-transparent opacity-30" />
      {/* Score dial */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative w-14 h-14 shrink-0">
          <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" strokeWidth="4" className="text-line" />
            <circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" strokeWidth="4"
              className={levelMeta.text}
              strokeDasharray={`${2 * Math.PI * 22}`}
              strokeDashoffset={`${2 * Math.PI * 22 * (1 - score / 100)}`}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-sm font-bold leading-none tabular-nums ${levelMeta.text}`}>{score}</span>
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-fg">Security Score</span>
            <TrendIcon size={13} className={levelMeta.text} />
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold ring-1 ring-inset ${levelMeta.text} ${levelMeta.bg} ${levelMeta.ring}`}>
            {levelMeta.label}
          </span>
        </div>
      </div>

      <div className="h-8 w-px bg-line hidden sm:block shrink-0" />

      {/* Score bar */}
      <div className="flex-1 min-w-[140px]">
        <div className="h-2 rounded-full bg-line overflow-hidden">
          <div className={`h-full rounded-full bg-gradient-to-r ${levelMeta.bar} transition-[width] duration-700 ease-out`} style={{ width: `${score}%` }} />
        </div>
        <div className="flex justify-between text-2xs text-faint mt-1 tabular-nums">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </div>

      <div className="h-8 w-px bg-line hidden lg:block shrink-0" />

      {/* Quick facts */}
      <div className="flex items-center gap-5 shrink-0">
        {critical > 0 && (
          <div className="flex items-center gap-1.5 text-sm">
            <span className="w-2 h-2 rounded-full bg-danger" />
            <span className="text-danger font-semibold tabular-nums">{critical}</span>
            <span className="text-muted">critical</span>
          </div>
        )}
        {atRisk > 0 && (
          <div className="flex items-center gap-1.5 text-sm">
            <span className="w-2 h-2 rounded-full bg-warn" />
            <span className="text-warn font-semibold tabular-nums">{atRisk}</span>
            <span className="text-muted">at risk</span>
          </div>
        )}
        {aiThreats > 0 && (
          <div className="flex items-center gap-1.5 text-sm">
            <Brain size={12} className="text-danger shrink-0" />
            <span className="text-danger font-semibold tabular-nums">{aiThreats}</span>
            <span className="text-muted">AI threat{aiThreats !== 1 ? 's' : ''}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-sm">
          <MapPin size={12} className="text-accent shrink-0" />
          <span className="font-semibold tabular-nums text-fg">{geofences}</span>
          <span className="text-muted">geofence{geofences !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}

// ── AI Anomaly dashboard widget ───────────────────────────────────────────────
function AnomalyWidget({ anomalies }: { anomalies: Anomaly[] }) {
  const critical = anomalies.filter(a => a.severity === 'critical');
  const warning  = anomalies.filter(a => a.severity === 'warning');
  const preview  = anomalies.slice(0, 5);

  return (
    <Panel
      icon={Brain}
      title="AI Threat Intelligence"
      subtitle="Statistical Z-score anomaly detection"
      actions={<Link to="/ai-insights" className="text-xs text-accent hover:underline">View all →</Link>}
      className="relative overflow-hidden card-grad ring-1 ring-inset ring-danger/20 transition-[transform,box-shadow] duration-200 hover:shadow-md"
    >
      <Hairline />
      {/* Summary strip */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        {critical.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 bg-danger/10 ring-1 ring-inset ring-danger/20">
            <AlertTriangle size={13} className="text-danger" />
            <span className="text-sm font-bold tabular-nums text-danger">{critical.length}</span>
            <span className="text-xs text-muted">critical</span>
          </div>
        )}
        {warning.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 bg-warn/10 ring-1 ring-inset ring-warn/20">
            <AlertTriangle size={13} className="text-warn" />
            <span className="text-sm font-bold tabular-nums text-warn">{warning.length}</span>
            <span className="text-xs text-muted">warnings</span>
          </div>
        )}
        <span className="text-xs text-faint ml-auto">{anomalies.length} unresolved · engine runs every 5 min</span>
      </div>
      {/* Top anomalies preview */}
      <div className="space-y-2">
        {preview.map(a => {
          const meta = ANOMALY_META[a.anomaly_type] ?? { label: a.anomaly_type, icon: '⚠️', color: '#64748b' };
          const sev  = SEVERITY_META[a.severity];
          return (
            <div key={a.id} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-surface-2/50 ring-1 ring-inset ring-line">
              <span className="text-base">{meta.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-fg truncate">{meta.label}</span>
                  <span className="inline-flex items-center rounded-full px-1.5 py-px text-2xs font-semibold"
                    style={{ color: sev.color, background: sev.bg }}>{sev.label}</span>
                </div>
                <p className="text-2xs text-muted truncate">{a.description}</p>
              </div>
              <span className="text-2xs font-mono tabular-nums" style={{ color: a.z_score >= 3 ? '#ef4444' : '#f59e0b' }}>
                {a.z_score.toFixed(1)}σ
              </span>
            </div>
          );
        })}
      </div>
      {anomalies.length > 5 && (
        <Link to="/ai-insights" className="mt-3 block text-center text-xs text-accent hover:underline">
          +{anomalies.length - 5} more anomalies →
        </Link>
      )}
    </Panel>
  );
}

function PostureBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div className="group">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-muted">{label}</span>
        <span className="font-semibold text-fg tabular-nums">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-surface-3 overflow-hidden ring-1 ring-inset ring-line/40">
        <div className={`h-full rounded-full ${color} transition-[width] duration-500 ease-out`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
