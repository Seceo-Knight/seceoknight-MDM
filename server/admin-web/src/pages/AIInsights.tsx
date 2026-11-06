import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain, AlertTriangle, Shield, CheckCircle, Clock, Filter, X, TrendingUp,
  Battery, Wifi, Package, HardDrive, MapPin, RefreshCw
} from 'lucide-react';
import {
  listAnomalies, resolveAnomaly, Anomaly, AnomalyType, AnomalySeverity,
  ANOMALY_META, SEVERITY_META
} from '../api/anomalies';
import { listDevices } from '../api/devices';

// ─── Anomaly type icon mapping ────────────────────────────────────────────────
function AnomalyIcon({ type, size = 16 }: { type: AnomalyType; size?: number }) {
  const cls = `flex-shrink-0`;
  switch (type) {
    case 'battery_drain':  return <Battery size={size} className={cls} />;
    case 'posture_drop':   return <Shield size={size} className={cls} />;
    case 'offline_spike':  return <Wifi size={size} className={cls} />;
    case 'location_jump':  return <MapPin size={size} className={cls} />;
    case 'app_burst':      return <Package size={size} className={cls} />;
    case 'storage_drop':   return <HardDrive size={size} className={cls} />;
    default:               return <AlertTriangle size={size} className={cls} />;
  }
}

// ─── Z-score gauge strip ──────────────────────────────────────────────────────
function ZScoreBar({ z }: { z: number }) {
  const max = 5;
  const pct = Math.min((z / max) * 100, 100);
  const color = z >= 3 ? '#ef4444' : z >= 2 ? '#f59e0b' : '#64748b';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="relative h-1.5 w-24 rounded-full bg-surface-3 overflow-hidden flex-shrink-0">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-2xs font-mono tabular-nums" style={{ color }}>{z.toFixed(1)}σ</span>
    </div>
  );
}

// ─── Severity badge ───────────────────────────────────────────────────────────
function SeverityBadge({ severity }: { severity: AnomalySeverity }) {
  const m = SEVERITY_META[severity];
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold"
      style={{ color: m.color, background: m.bg }}>
      {m.label}
    </span>
  );
}

// ─── Summary stats cards ──────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <span className="text-xs text-muted uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-bold tabular-nums" style={{ color }}>{value}</span>
      {sub && <span className="text-2xs text-faint">{sub}</span>}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function AIInsights() {
  const qc = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<AnomalySeverity | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<AnomalyType | 'all'>('all');
  const [selected, setSelected] = useState<Anomaly | null>(null);

  const { data: anomalies = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['anomalies'],
    queryFn: () => listAnomalies(500),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: devicesResp } = useQuery({
    queryKey: ['devices', 'ai-insights'],
    queryFn: () => listDevices({ limit: 500 }),
    staleTime: 30_000,
  });
  const devices = devicesResp?.items ?? [];

  const deviceMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of devices) {
      const label = d.model
        ? `${d.manufacturer ?? ''} ${d.model}`.trim()
        : (d.serial_number ?? d.id.slice(0, 8));
      m[d.id] = label;
    }
    return m;
  }, [devices]);

  const resolveMut = useMutation({
    mutationFn: resolveAnomaly,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['anomalies'] });
      setSelected(null);
    },
  });

  const filtered = useMemo(() => {
    return anomalies.filter(a => {
      if (severityFilter !== 'all' && a.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && a.anomaly_type !== typeFilter) return false;
      return true;
    });
  }, [anomalies, severityFilter, typeFilter]);

  const critical = anomalies.filter(a => a.severity === 'critical').length;
  const warning  = anomalies.filter(a => a.severity === 'warning').length;
  const info     = anomalies.filter(a => a.severity === 'info').length;
  const totalDevicesAffected = new Set(anomalies.map(a => a.device_id)).size;

  const typeCounts = useMemo(() => {
    const m: Partial<Record<AnomalyType, number>> = {};
    for (const a of anomalies) {
      m[a.anomaly_type] = (m[a.anomaly_type] ?? 0) + 1;
    }
    return m;
  }, [anomalies]);

  return (
    <div className="page-wrapper">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-accent/10 text-accent">
            <Brain size={22} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-fg">AI Threat Intelligence</h1>
            <p className="text-xs text-muted">Z-score statistical anomaly detection • refreshes every 5 min</p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Critical" value={critical} color="#ef4444" sub="immediate action required" />
        <StatCard label="Warnings" value={warning}  color="#f59e0b" sub="investigate soon" />
        <StatCard label="Info"     value={info}      color="#64748b" sub="monitor" />
        <StatCard label="Devices Affected" value={totalDevicesAffected} color="#6366f1" sub="unique devices" />
      </div>

      {/* ── Threat type breakdown ── */}
      <div className="card p-4 mb-6">
        <h2 className="text-sm font-semibold text-fg mb-3 flex items-center gap-2">
          <TrendingUp size={15} className="text-accent" />
          Threat Distribution
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {(Object.entries(ANOMALY_META) as [AnomalyType, (typeof ANOMALY_META)[AnomalyType]][]).map(([type, meta]) => {
            const count = typeCounts[type] ?? 0;
            const active = typeFilter === type;
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(active ? 'all' : type)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-center ${
                  active ? 'border-accent bg-accent/8' : 'border-line bg-surface-2/40 hover:bg-surface-2'
                }`}
              >
                <span className="text-xl">{meta.icon}</span>
                <span className="text-lg font-bold tabular-nums" style={{ color: count > 0 ? meta.color : '#64748b' }}>{count}</span>
                <span className="text-2xs text-muted leading-tight">{meta.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Anomaly list ── */}
      <div className="card">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 p-4 border-b border-line flex-wrap">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-muted" />
            <span className="text-sm text-muted">{filtered.length} anomalies</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Severity filter */}
            {(['all', 'critical', 'warning', 'info'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSeverityFilter(s)}
                className={`px-2.5 py-1 rounded-lg text-2xs font-semibold border transition-all ${
                  severityFilter === s
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line text-muted hover:bg-surface-2'
                }`}
              >
                {s === 'all' ? 'All' : SEVERITY_META[s].label}
              </button>
            ))}
            {typeFilter !== 'all' && (
              <button
                onClick={() => setTypeFilter('all')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-2xs border border-accent/50 text-accent bg-accent/8"
              >
                {ANOMALY_META[typeFilter]?.label}
                <X size={10} />
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted text-sm gap-2">
            <RefreshCw size={16} className="animate-spin" />
            Loading anomalies…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle size={32} className="text-success" />
            <p className="text-sm text-muted">No anomalies detected{severityFilter !== 'all' || typeFilter !== 'all' ? ' matching filters' : ''}.</p>
            <p className="text-xs text-faint">The AI engine runs every 5 minutes and will flag threats automatically.</p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {filtered.map(a => {
              const meta = ANOMALY_META[a.anomaly_type] ?? { label: a.anomaly_type, icon: '⚠️', color: '#64748b' };
              const deviceLabel = deviceMap[a.device_id] ?? a.device_id.slice(0, 8);
              const ago = timeAgo(a.detected_at);
              return (
                <button
                  key={a.id}
                  onClick={() => setSelected(selected?.id === a.id ? null : a)}
                  className="w-full text-left px-4 py-3 hover:bg-surface-2/60 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg"
                      style={{ background: `${meta.color}18`, color: meta.color }}>
                      <AnomalyIcon type={a.anomaly_type} size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-sm font-semibold text-fg">{meta.label}</span>
                        <SeverityBadge severity={a.severity} />
                        <span className="text-2xs text-faint ml-auto flex items-center gap-1">
                          <Clock size={10} />{ago}
                        </span>
                      </div>
                      <p className="text-xs text-muted truncate">{a.description}</p>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-2xs text-faint">
                          Device: <span className="text-fg font-medium">{deviceLabel}</span>
                        </span>
                        <ZScoreBar z={a.z_score} />
                      </div>
                    </div>
                  </div>
                  {/* Expanded detail panel */}
                  {selected?.id === a.id && (
                    <div className="mt-3 ml-11 p-3 rounded-lg bg-surface-2/60 border border-line text-left" onClick={e => e.stopPropagation()}>
                      <div className="text-xs font-semibold text-fg mb-2">Detection Details</div>
                      <pre className="text-2xs text-muted font-mono whitespace-pre-wrap overflow-auto max-h-40">
                        {JSON.stringify(a.details, null, 2)}
                      </pre>
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          onClick={() => resolveMut.mutate(a.id)}
                          disabled={resolveMut.isPending}
                          className="btn btn-secondary text-xs flex items-center gap-1.5"
                        >
                          <CheckCircle size={12} />
                          Mark Resolved
                        </button>
                        <a
                          href={`/devices/${a.device_id}`}
                          className="btn btn-secondary text-xs flex items-center gap-1.5"
                          onClick={e => e.stopPropagation()}
                        >
                          Open Device →
                        </a>
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
