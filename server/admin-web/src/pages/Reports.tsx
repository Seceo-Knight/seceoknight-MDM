import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listDevices, deviceLabel, type Device } from '../api/devices';
import { listEvents, type ComplianceEvent } from '../api/compliance';
import { listFleetApps, listBlockedPackages } from '../api/apps';
import { listAnomalies, type Anomaly } from '../api/anomalies';
import { downloadCSV, printReport } from '../utils/exportUtils';
import {
  PageHero, HeroStat, Button, Badge, Skeleton,
} from '../components/ui';
import {
  FileDown, Printer, FileSpreadsheet, ShieldCheck, Package,
  Brain, Smartphone, CheckCircle2, AlertTriangle, XCircle, Clock,
  BarChart3,
} from 'lucide-react';

export function Reports() {
  // Pre-fetch all data sources
  const devices   = useQuery({ queryKey: ['devices', 'report'],   queryFn: () => listDevices({ limit: 1000 }) });
  const compliance = useQuery({ queryKey: ['events', 'report'],   queryFn: () => listEvents({ limit: 1000 }) });
  const fleet     = useQuery({ queryKey: ['fleet-apps', 'report'], queryFn: () => listFleetApps(1000) });
  const anomalies = useQuery({ queryKey: ['anomalies', 'report'], queryFn: () => listAnomalies(1000) });

  const devList   = devices.data?.items ?? [];
  const evtList   = compliance.data ?? [];
  const appList   = fleet.data?.items ?? [];
  const anoList   = anomalies.data ?? [];
  const blocked   = useQuery({ queryKey: ['blocklist', 'report'], queryFn: listBlockedPackages });

  const enrolled  = devList.filter(d => d.state === 'enrolled').length;
  const critical  = anoList.filter(a => a.severity === 'critical').length;
  const triggered = evtList.filter(e => e.status === 'triggered').length;

  return (
    <div className="space-y-5">
      <PageHero
        icon={FileDown}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" /> Reports</>}
        title="Reports & Export"
        subtitle="Download CSV or print-to-PDF reports for audits, compliance reviews, and client handoffs."
        stats={<>
          <HeroStat icon={Smartphone}  label="Devices"    value={devList.length}  tone="accent" />
          <HeroStat icon={BarChart3}   label="App types"  value={appList.length}  tone="info" />
          <HeroStat icon={Brain}       label="Anomalies"  value={anoList.length}  tone={critical > 0 ? 'danger' : 'muted'} />
        </>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Device Inventory */}
        <ReportCard
          icon={Smartphone}
          title="Device Inventory"
          description="Full list of all managed devices with status, OS, battery, storage, and posture score."
          count={devList.length}
          countLabel="devices"
          isLoading={devices.isLoading}
          tone="accent"
          stats={[
            { label: 'Enrolled', value: enrolled, icon: CheckCircle2, tone: 'green' },
            { label: 'Offline',  value: devList.filter(d => d.state === 'offline').length,  icon: Clock,       tone: 'amber' },
            { label: 'Wiped',    value: devList.filter(d => d.state === 'wiped').length,    icon: XCircle,     tone: 'red' },
          ]}
          onCSV={() => downloadCSV('device-inventory', devList.map(deviceRow))}
          onPDF={() => printReport('Device Inventory', deviceHtml(devList))}
        />

        {/* Compliance Log */}
        <ReportCard
          icon={ShieldCheck}
          title="Compliance Log"
          description="History of all compliance rule evaluations — triggered, skipped, and failed events."
          count={evtList.length}
          countLabel="events"
          isLoading={compliance.isLoading}
          tone="info"
          stats={[
            { label: 'Triggered', value: triggered,                                              icon: AlertTriangle, tone: 'amber' },
            { label: 'Skipped',   value: evtList.filter(e => e.status === 'skipped').length,   icon: Clock,         tone: 'muted' },
            { label: 'Failed',    value: evtList.filter(e => e.status === 'failed').length,    icon: XCircle,       tone: 'red' },
          ]}
          onCSV={() => downloadCSV('compliance-log', evtList.map(complianceRow))}
          onPDF={() => printReport('Compliance Log', complianceHtml(evtList))}
        />

        {/* App Audit */}
        <ReportCard
          icon={Package}
          title="App Audit"
          description="All apps installed across your fleet with device counts. Includes blocklist status."
          count={appList.length}
          countLabel="app types"
          isLoading={fleet.isLoading}
          tone="violet"
          stats={[
            { label: 'Blocked', value: blocked.data?.length ?? 0, icon: XCircle,      tone: 'red' },
            { label: 'Devices', value: devList.length,            icon: Smartphone,   tone: 'accent' },
          ]}
          onCSV={() => {
            const blockedSet = new Set((blocked.data ?? []).map(b => b.package_name));
            downloadCSV('app-audit', appList.map(a => ({
              package_name: a.package_name,
              app_name: a.app_name,
              version: a.version_name ?? '',
              device_count: a.device_count,
              blocked: blockedSet.has(a.package_name) ? 'YES' : 'no',
            } as Record<string, unknown>)));
          }}
          onPDF={() => {
            const blockedSet = new Set((blocked.data ?? []).map(b => b.package_name));
            printReport('App Audit', appHtml(appList, blockedSet));
          }}
        />

        {/* AI Anomalies */}
        <ReportCard
          icon={Brain}
          title="AI Anomaly Report"
          description="All AI-detected anomalies with severity, Z-score, affected device, and resolution status."
          count={anoList.length}
          countLabel="anomalies"
          isLoading={anomalies.isLoading}
          tone="danger"
          stats={[
            { label: 'Critical', value: critical,                                               icon: XCircle,       tone: 'red' },
            { label: 'Warning',  value: anoList.filter(a => a.severity === 'warning').length,  icon: AlertTriangle, tone: 'amber' },
            { label: 'Resolved', value: anoList.filter(a => a.resolved).length,               icon: CheckCircle2,  tone: 'green' },
          ]}
          onCSV={() => downloadCSV('ai-anomalies', anoList.map(anomalyRow))}
          onPDF={() => printReport('AI Anomaly Report', anomalyHtml(anoList))}
        />
      </div>
    </div>
  );
}

// ─── Report Card component ────────────────────────────────────────────────────
type Tone = 'accent' | 'info' | 'violet' | 'danger' | 'green' | 'amber' | 'red' | 'muted';

function ReportCard({
  icon: Icon, title, description, count, countLabel,
  isLoading, tone, stats, onCSV, onPDF,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  count: number;
  countLabel: string;
  isLoading: boolean;
  tone: Tone;
  stats: { label: string; value: number; icon: React.ElementType; tone: Tone }[];
  onCSV: () => void;
  onPDF: () => void;
}) {
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);

  const toneClasses: Record<Tone, string> = {
    accent: 'bg-accent/10 text-accent ring-accent/20',
    info:   'bg-info/10 text-info ring-info/20',
    violet: 'bg-violet-500/10 text-violet-400 ring-violet-500/20',
    danger: 'bg-danger/10 text-danger ring-danger/20',
    green:  'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
    amber:  'bg-amber-500/10 text-amber-400 ring-amber-500/20',
    red:    'bg-danger/10 text-danger ring-danger/20',
    muted:  'bg-surface-2 text-muted ring-line',
  };

  const statTone = (t: Tone) => toneClasses[t];

  const handleCSV = async () => {
    setExporting('csv');
    try { onCSV(); } finally { setTimeout(() => setExporting(null), 800); }
  };
  const handlePDF = async () => {
    setExporting('pdf');
    try { onPDF(); } finally { setTimeout(() => setExporting(null), 800); }
  };

  return (
    <div className="card ring-1 ring-inset ring-line animate-slideup flex flex-col gap-4 p-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${toneClasses[tone]}`}>
          <Icon size={18} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-fg text-base">{title}</span>
            {isLoading
              ? <Skeleton className="h-5 w-12 rounded-full" />
              : <Badge tone={count > 0 ? tone as any : 'muted'} dot>{count} {countLabel}</Badge>
            }
          </div>
          <p className="text-xs text-muted mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex gap-2 flex-wrap">
        {stats.map(s => (
          <div key={s.label} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ring-1 ring-inset ${statTone(s.tone)}`}>
            <s.icon size={12} />
            <span className="text-xs font-semibold tabular-nums">{isLoading ? '—' : s.value}</span>
            <span className="text-2xs opacity-70">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1 border-t border-line">
        <Button
          variant="secondary" size="sm"
          className="flex-1 justify-center"
          disabled={isLoading || count === 0 || exporting === 'csv'}
          onClick={handleCSV}
        >
          <FileSpreadsheet size={13} className={exporting === 'csv' ? 'animate-pulse' : ''} />
          {exporting === 'csv' ? 'Downloading…' : 'Download CSV'}
        </Button>
        <Button
          variant="secondary" size="sm"
          className="flex-1 justify-center"
          disabled={isLoading || count === 0 || exporting === 'pdf'}
          onClick={handlePDF}
        >
          <Printer size={13} className={exporting === 'pdf' ? 'animate-pulse' : ''} />
          {exporting === 'pdf' ? 'Opening…' : 'Print / PDF'}
        </Button>
      </div>
    </div>
  );
}

// ─── Data mappers ─────────────────────────────────────────────────────────────

function deviceRow(d: Device) {
  return {
    id: d.id,
    alias: d.alias ?? '',
    manufacturer: d.manufacturer ?? '',
    model: d.model ?? '',
    serial_number: d.serial_number ?? '',
    os_version: d.os_version ?? '',
    state: d.state,
    management_mode: d.management_mode ?? '',
    posture_score: d.last_posture_score ?? '',
    battery_pct: d.last_battery_pct ?? '',
    storage_free_gb: d.last_storage_free_bytes != null
      ? (d.last_storage_free_bytes / 1073741824).toFixed(2) : '',
    wifi_ssid: d.last_wifi_ssid ?? '',
    ip_address: d.last_ip_address ?? '',
    agent_version: d.agent_version ?? '',
    last_heartbeat: d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : '',
    enrolled_at: d.created_at ? new Date(d.created_at).toLocaleString() : '',
  };
}

function complianceRow(e: ComplianceEvent) {
  return {
    id: e.id,
    rule_id: e.rule_id,
    device_id: e.device_id,
    status: e.status,
    action: e.action,
    trigger_value: e.trigger_value ?? '',
    note: e.note ?? '',
    created_at: new Date(e.created_at).toLocaleString(),
  };
}

function anomalyRow(a: Anomaly) {
  return {
    id: a.id,
    device_id: a.device_id,
    anomaly_type: a.anomaly_type,
    severity: a.severity,
    z_score: a.z_score?.toFixed(2) ?? '',
    description: a.description,
    resolved: a.resolved ? 'yes' : 'no',
    detected_at: new Date(a.detected_at).toLocaleString(),
  };
}

// ─── PDF HTML builders ────────────────────────────────────────────────────────

function deviceHtml(devices: Device[]) {
  const rows = devices.map(d => `<tr>
    <td>${deviceLabel(d)}</td>
    <td>${d.manufacturer ?? ''} ${d.model ?? ''}</td>
    <td>${d.os_version ?? ''}</td>
    <td><span class="badge ${stateBadge(d.state)}">${d.state}</span></td>
    <td>${d.last_posture_score != null ? d.last_posture_score + '/100' : '—'}</td>
    <td>${d.last_battery_pct != null ? d.last_battery_pct + '%' : '—'}</td>
    <td>${d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : '—'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr>
      <th>Device</th><th>Hardware</th><th>OS</th><th>State</th>
      <th>Posture</th><th>Battery</th><th>Last Heartbeat</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function complianceHtml(events: ComplianceEvent[]) {
  const rows = events.map(e => `<tr>
    <td>${new Date(e.created_at).toLocaleString()}</td>
    <td>${e.device_id.slice(0, 8)}…</td>
    <td><span class="badge ${e.status === 'triggered' ? 'badge-amber' : e.status === 'failed' ? 'badge-red' : 'badge-gray'}">${e.status}</span></td>
    <td>${e.action ?? '—'}</td>
    <td>${e.trigger_value ?? '—'}</td>
    <td>${e.note ?? '—'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>Time</th><th>Device</th><th>Status</th><th>Action</th><th>Value</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function appHtml(apps: import('../api/apps').FleetApp[], blockedSet: Set<string>) {
  const rows = apps.map(a => `<tr>
    <td>${a.app_name || a.package_name}</td>
    <td style="font-family:monospace;font-size:10px">${a.package_name}</td>
    <td>${a.version_name ?? '—'}</td>
    <td>${a.device_count}</td>
    <td>${blockedSet.has(a.package_name) ? '<span class="badge badge-red">BLOCKED</span>' : '<span class="badge badge-gray">OK</span>'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>App</th><th>Package</th><th>Version</th><th>Devices</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function anomalyHtml(anomalies: Anomaly[]) {
  const rows = anomalies.map(a => `<tr>
    <td>${new Date(a.detected_at).toLocaleString()}</td>
    <td>${a.device_id.slice(0, 8)}…</td>
    <td>${a.anomaly_type.replace(/_/g, ' ')}</td>
    <td><span class="badge ${a.severity === 'critical' ? 'badge-red' : a.severity === 'warning' ? 'badge-amber' : 'badge-gray'}">${a.severity}</span></td>
    <td>${a.z_score?.toFixed(2) ?? '—'}σ</td>
    <td>${a.description}</td>
    <td>${a.resolved ? '<span class="badge badge-green">resolved</span>' : '<span class="badge badge-amber">open</span>'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>Time</th><th>Device</th><th>Type</th><th>Severity</th><th>Z-Score</th><th>Description</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function stateBadge(state: string) {
  switch (state) {
    case 'enrolled': return 'badge-green';
    case 'offline':  return 'badge-amber';
    case 'wiped':
    case 'retired':  return 'badge-red';
    default:         return 'badge-gray';
  }
}
