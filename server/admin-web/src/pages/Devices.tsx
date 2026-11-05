import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDevices } from '../api/devices';
import { listGroups } from '../api/groups';
import { useState } from 'react';
import { formatRelative, isOnline } from '../components/online';
import { ModeBadge, PostureBadge } from '../components/DeviceMode';
import { Card, Panel, Input, Select, Badge, EmptyState, Skeleton, PageHero, HeroStat, Hairline } from '../components/ui';
import { Search, Smartphone, Wifi, WifiOff, CheckCircle2, Clock, ListFilter, SlidersHorizontal, MonitorSmartphone } from 'lucide-react';

const STATE_TONE: Record<string, 'success' | 'warn' | 'muted' | 'danger'> = {
  enrolled: 'success', offline: 'warn', pending: 'muted', wiped: 'danger', retired: 'muted',
};

export function Devices() {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['devices', q, state],
    queryFn: () => listDevices({ q, state, limit: 100 }),
    refetchInterval: 5000,
  });
  const { data: groups } = useQuery({ queryKey: ['groups'], queryFn: listGroups, staleTime: 30000 });
  const groupName = new Map((groups ?? []).map(g => [g.id, g.name]));
  const rows = data?.items ?? [];

  // Derived at-a-glance counts from the rows already loaded (presentation only).
  const onlineCount = rows.filter(d => isOnline(d.last_heartbeat_at)).length;
  const enrolledCount = rows.filter(d => d.state === 'enrolled').length;
  const pendingCount = rows.filter(d => d.state === 'pending').length;

  return (
    <div className="space-y-5">
      <PageHero
        icon={Smartphone}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} /> Fleet inventory</>}
        title="Devices"
        subtitle={data ? `${data.total} enrolled device${data.total === 1 ? '' : 's'} under management.` : 'Loading fleet…'}
        stats={<>
          <HeroStat icon={Smartphone} label="Total" value={data?.total ?? rows.length} tone="accent" />
          <HeroStat icon={Wifi} label="Online" value={onlineCount} tone="success" />
          <HeroStat icon={CheckCircle2} label="Enrolled" value={enrolledCount} tone="info" />
          <HeroStat icon={Clock} label="Pending" value={pendingCount} tone="warn" />
        </>}
      />

      {/* Filter toolbar */}
      <Card className="relative overflow-hidden card-grad p-3 sm:p-3.5">
        <Hairline />
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
            <SlidersHorizontal size={15} />
          </span>
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search alias, serial, model…" className="pl-8 w-full sm:w-64 h-9" />
          </div>
          <div className="relative">
            <ListFilter size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <Select value={state} onChange={e => setState(e.target.value)} className="h-9 w-40 pl-8">
              <option value="">All states</option>
              {['enrolled', 'pending', 'offline', 'wiped', 'retired'].map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2 text-2xs text-faint">
            <span className="hidden sm:inline">Showing</span>
            <Badge tone="default" className="tabular-nums">
              {isLoading ? '—' : `${rows.length} device${rows.length === 1 ? '' : 's'}`}
            </Badge>
            {(q || state) && (
              <button
                onClick={() => { setQ(''); setState(''); }}
                className="text-accent hover:underline">
                Clear
              </button>
            )}
          </div>
        </div>
      </Card>

      <Panel
        icon={MonitorSmartphone}
        title="Fleet inventory"
        subtitle="Live device roster with connection, state and posture."
        actions={
          <span className="inline-flex items-center gap-1.5 text-2xs text-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} />
            Auto-refresh
          </span>
        }
        bodyClassName="p-0"
        className="relative overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="sticky top-0 z-10">
              <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line-strong bg-surface-2 shadow-[0_1px_0_0_rgb(var(--line))]">
                <th className="px-4 py-2.5 font-semibold">Device</th>
                <th className="px-4 py-2.5 font-semibold">Connection</th>
                <th className="px-4 py-2.5 font-semibold">State</th>
                <th className="px-4 py-2.5 font-semibold">Mode</th>
                <th className="px-4 py-2.5 font-semibold">Posture</th>
                <th className="px-4 py-2.5 font-semibold">OS</th>
                <th className="px-4 py-2.5 font-semibold text-right">Last seen</th>
              </tr>
            </thead>
            <tbody className="rail divide-y divide-line">
              {isLoading && Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-32" />
                        <Skeleton className="h-2.5 w-20" />
                      </div>
                    </div>
                  </td>
                  {Array.from({ length: 6 }).map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>)}
                </tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={7}>
                  <EmptyState
                    icon={<span className="grid place-items-center h-9 w-9 rounded-2xl bg-accent-soft text-accent"><Smartphone size={18} /></span>}
                    title="No devices found"
                    hint={q || state ? 'Try adjusting your search or filter.' : 'Generate an enrollment token to add your first device.'}
                    action={!q && !state ? <Link to="/enrollment" className="text-sm text-accent hover:underline">Go to Enrollment →</Link> : undefined} />
                </td></tr>
              )}
              {!isLoading && rows.map((d, i) => {
                const ol = isOnline(d.last_heartbeat_at);
                return (
                  <tr key={d.id} className="group hover:bg-surface-2 transition-colors animate-fadein" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="relative grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 transition-colors group-hover:bg-accent/15">
                          <Smartphone size={16} />
                          <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${ol ? 'bg-success' : 'bg-faint'}`} />
                        </span>
                        <div className="min-w-0">
                          <Link to={`/devices/${d.id}`} className="font-medium text-fg hover:text-accent transition-colors">
                            {d.alias?.trim() || d.serial_number || d.id.slice(0, 8)}
                          </Link>
                          <div className="flex items-center gap-2 mt-0.5">
                            {d.alias?.trim() && <span className="text-2xs text-faint font-mono">{d.serial_number ?? d.id.slice(0, 8)}</span>}
                            {d.group_id && groupName.has(d.group_id) && <Badge tone="info">{groupName.get(d.group_id)}</Badge>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={ol ? 'success' : 'muted'}>
                        <span className={`w-1.5 h-1.5 rounded-full ${ol ? 'bg-success' : 'bg-faint'}`} style={ol ? { animation: 'onlinePulse 2s infinite' } : undefined} />
                        {ol ? <Wifi size={12} /> : <WifiOff size={12} />}
                        {ol ? 'Online' : 'Offline'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5"><Badge tone={STATE_TONE[d.state] ?? 'muted'} dot>{d.state}</Badge></td>
                    <td className="px-4 py-2.5"><ModeBadge mode={d.last_mgmt_mode} /></td>
                    <td className="px-4 py-2.5"><PostureBadge score={d.last_posture_score} /></td>
                    <td className="px-4 py-2.5 text-muted">{d.os_version ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-faint tabular-nums" title={d.last_heartbeat_at}>{formatRelative(d.last_heartbeat_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
