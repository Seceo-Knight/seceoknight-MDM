import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { listDevices, deviceLabel, broadcastCommand, type Device } from '../api/devices';
import { listGroups } from '../api/groups';
import { PageHero, HeroStat, Button, Select, cn } from '../components/ui';
import { toast } from '../components/toast';
import { confirmDialog } from '../components/confirm';
import {
  MapPin, Smartphone, Navigation2, RefreshCw, Radio,
  WifiOff, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';

// Fix default icon URLs broken by Vite bundling (same fix as Geofencing.tsx).
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Types ───────────────────────────────────────────────────────────────────

type OnlineStatus = 'online' | 'warning' | 'offline' | 'unknown';

function onlineStatus(d: Device): OnlineStatus {
  if (!d.last_heartbeat_at) return 'unknown';
  const agoMs = Date.now() - new Date(d.last_heartbeat_at).getTime();
  if (agoMs < 5 * 60_000)  return 'online';   // seen < 5 min
  if (agoMs < 30 * 60_000) return 'warning';  // seen 5-30 min
  return 'offline';
}

const STATUS_COLOR: Record<OnlineStatus, string> = {
  online:  '#22c55e',
  warning: '#f59e0b',
  offline: '#ef4444',
  unknown: '#6b7280',
};
const STATUS_LABEL: Record<OnlineStatus, string> = {
  online:  'Online',
  warning: 'Warning',
  offline: 'Offline',
  unknown: 'Unknown',
};

// ─── Auto-fit helper ─────────────────────────────────────────────────────────

function FitBounds({ devices }: { devices: Device[] }) {
  const map = useMap();
  const fitted = useRef(false);
  const located = devices.filter(d => d.last_latitude != null && d.last_longitude != null);
  if (!fitted.current && located.length > 0) {
    fitted.current = true;
    if (located.length === 1) {
      map.setView([located[0].last_latitude!, located[0].last_longitude!], 10);
    } else {
      const bounds = L.latLngBounds(located.map(d => [d.last_latitude!, d.last_longitude!]));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
    }
  }
  return null;
}

// ─── Main page ───────────────────────────────────────────────────────────────

export function DevicesMap() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState<OnlineStatus | 'all'>('all');
  const [filterGroup, setFilterGroup] = useState<string>('all');
  const [hoverId, setHoverId] = useState<string | null>(null);

  const { data: devData, isLoading } = useQuery({
    queryKey: ['devices-map'],
    queryFn: () => listDevices({ limit: 1000 }),
    refetchInterval: 30_000,
  });

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => listGroups(),
  });

  const refreshAll = useMutation({
    mutationFn: async () => {
      // Push GET_LOCATION to every group that has devices with location capability.
      // We broadcast to all online devices by firing to each group individually.
      // If no groups, we can only do it per-device (skipped for large fleets).
      const gs = groups ?? [];
      if (gs.length === 0) {
        toast.info('No groups configured — cannot broadcast GET_LOCATION. Add devices to groups first.');
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Refresh all device locations?',
        message: `This sends a GET_LOCATION command to all ${gs.length} group(s). Devices will respond within ~30s.`,
        confirmLabel: 'Refresh now',
      });
      if (!confirmed) return;
      let dispatched = 0;
      for (const g of gs) {
        try {
          const r = await broadcastCommand(g.id, 'GET_LOCATION', {});
          dispatched += r ?? 0;
        } catch { /* best effort */ }
      }
      toast.success(`Location refresh dispatched to ${dispatched} device(s). Map updates on next heartbeat.`);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['devices-map'] }), 20_000);
    },
  });

  const devices = devData?.items ?? [];

  const located = useMemo(
    () => devices.filter(d => d.last_latitude != null && d.last_longitude != null),
    [devices],
  );

  const filtered = useMemo(() => located.filter(d => {
    if (filterStatus !== 'all' && onlineStatus(d) !== filterStatus) return false;
    if (filterGroup !== 'all' && d.group_id !== filterGroup) return false;
    return true;
  }), [located, filterStatus, filterGroup]);

  // Stats
  const counts = useMemo(() => {
    const c = { online: 0, warning: 0, offline: 0, unknown: 0 };
    devices.forEach(d => c[onlineStatus(d)]++);
    return c;
  }, [devices]);

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* ── Hero ── */}
      <PageHero
        icon={MapPin}
        eyebrow={
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-success" style={{ animation: 'onlinePulse 2s infinite' }} />
            {' '}Live fleet map
          </>
        }
        title="Device Map"
        subtitle={`${located.length} of ${devices.length} enrolled devices have location data.`}
        actions={
          <Button
            variant="primary"
            onClick={() => refreshAll.mutate()}
            disabled={refreshAll.isPending}
          >
            <Navigation2 size={14} />
            {refreshAll.isPending ? 'Refreshing…' : 'Refresh all locations'}
          </Button>
        }
        stats={
          <>
            <HeroStat icon={CheckCircle2} label="Online"  value={String(counts.online)}  tone="success" />
            <HeroStat icon={AlertTriangle} label="Warning" value={String(counts.warning)} tone="warn" />
            <HeroStat icon={WifiOff}       label="Offline" value={String(counts.offline)} tone="danger" />
          </>
        }
      />

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-1.5 text-xs text-muted font-medium">
          <Radio size={12} /> Filters
        </div>
        <Select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as any)}
          className="text-xs h-7 py-0"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="warning">Warning (5–30 min)</option>
          <option value="offline">Offline (&gt;30 min)</option>
          <option value="unknown">Unknown</option>
        </Select>
        {groups && groups.length > 0 && (
          <Select
            value={filterGroup}
            onChange={e => setFilterGroup(e.target.value)}
            className="text-xs h-7 py-0"
            aria-label="Filter by group"
          >
            <option value="all">All groups</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </Select>
        )}
        <span className="text-xs text-muted ml-auto">
          Showing <strong className="text-fg">{filtered.length}</strong> of <strong className="text-fg">{located.length}</strong> located devices
        </span>
      </div>

      {/* ── Map ── */}
      <div className="relative flex-1 min-h-[520px] rounded-2xl overflow-hidden border border-line shadow-xs">
        {isLoading && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-surface/80 backdrop-blur-sm rounded-2xl">
            <div className="flex items-center gap-2 text-sm text-muted">
              <RefreshCw size={16} className="animate-spin" /> Loading devices…
            </div>
          </div>
        )}

        <MapContainer
          center={[20, 10]}
          zoom={2}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
          className="rounded-2xl"
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            subdomains="abcd"
            maxZoom={19}
          />
          <FitBounds devices={filtered} />

          {filtered.map(device => {
            const status = onlineStatus(device);
            const color = STATUS_COLOR[status];
            const isHover = hoverId === device.id;
            return (
              <CircleMarker
                key={device.id}
                center={[device.last_latitude!, device.last_longitude!]}
                radius={isHover ? 11 : 8}
                pathOptions={{
                  color: 'rgba(0,0,0,0.3)',
                  weight: 2,
                  fillColor: color,
                  fillOpacity: 0.9,
                }}
                eventHandlers={{
                  mouseover: () => setHoverId(device.id),
                  mouseout:  () => setHoverId(null),
                }}
              >
                <Popup
                  offset={[0, -4]}
                  className="mdm-map-popup"
                  autoPan={false}
                >
                  <DevicePopup device={device} status={status} onOpen={() => navigate(`/devices/${device.id}`)} />
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>

        {/* Legend */}
        <div className="absolute bottom-4 left-4 z-[500] flex flex-col gap-1 bg-surface/90 backdrop-blur border border-line rounded-xl px-3 py-2 text-xs shadow">
          {(['online', 'warning', 'offline', 'unknown'] as OnlineStatus[]).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(prev => prev === s ? 'all' : s)}
              className={cn(
                'flex items-center gap-2 text-left hover:text-fg transition-colors',
                filterStatus === s ? 'text-fg font-semibold' : 'text-muted',
              )}
            >
              <span
                className="w-3 h-3 rounded-full ring-1 ring-black/20 shrink-0"
                style={{ background: STATUS_COLOR[s] }}
              />
              {STATUS_LABEL[s]}
              <span className="text-faint ml-auto pl-2">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Located devices table (collapsed list) ── */}
      {!isLoading && located.length === 0 && (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <MapPin className="w-10 h-10 text-faint mx-auto mb-3" />
          <p className="text-sm font-medium text-fg">No location data yet</p>
          <p className="text-xs text-muted mt-1">
            Use the <strong>Refresh all locations</strong> button above to fetch the current GPS fix
            from all enrolled devices. Devices will update the map within ~30 seconds.
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between">
            <span className="text-sm font-semibold text-fg flex items-center gap-2">
              <Smartphone size={15} className="text-accent" /> Located devices
            </span>
            <span className="text-xs text-muted">{filtered.length} devices</span>
          </div>
          <div className="divide-y divide-line max-h-64 overflow-y-auto">
            {filtered.map(d => {
              const status = onlineStatus(d);
              return (
                <button
                  key={d.id}
                  onClick={() => navigate(`/devices/${d.id}`)}
                  className="w-full text-left px-5 py-2.5 hover:bg-surface-2 transition-colors flex items-center gap-3"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: STATUS_COLOR[status] }}
                  />
                  <span className="text-sm text-fg flex-1 truncate">{deviceLabel(d)}</span>
                  <span className="text-xs text-muted truncate max-w-[140px]">
                    {d.model ?? d.manufacturer ?? ''}
                  </span>
                  {d.last_battery_pct != null && (
                    <span className="text-xs text-muted tabular-nums">{d.last_battery_pct}%</span>
                  )}
                  {d.last_location_at && (
                    <span className="text-xs text-faint tabular-nums whitespace-nowrap flex items-center gap-1">
                      <Clock size={10} />
                      {formatAge(d.last_location_at)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Device popup ─────────────────────────────────────────────────────────────

function DevicePopup({
  device, status, onOpen,
}: {
  device: Device; status: OnlineStatus; onOpen: () => void;
}) {
  return (
    <div className="min-w-[200px] text-[13px] leading-snug" style={{ fontFamily: 'inherit' }}>
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="w-2.5 h-2.5 rounded-full ring-1 ring-black/10 shrink-0"
          style={{ background: STATUS_COLOR[status] }}
        />
        <span className="font-semibold text-fg">{deviceLabel(device)}</span>
      </div>
      {device.model && (
        <div className="text-muted text-xs mb-1">{[device.manufacturer, device.model].filter(Boolean).join(' ')}</div>
      )}
      <div className="flex items-center gap-3 text-xs text-muted mt-1.5">
        {device.last_battery_pct != null && (
          <span>🔋 {device.last_battery_pct}%</span>
        )}
        <span
          className={cn(
            'px-1.5 py-0.5 rounded-md text-[11px] font-medium',
            status === 'online'  ? 'bg-green-100 text-green-800' :
            status === 'warning' ? 'bg-yellow-100 text-yellow-800' :
            status === 'offline' ? 'bg-red-100 text-red-800' :
                                   'bg-gray-100 text-gray-700',
          )}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>
      {device.last_location_at && (
        <div className="text-xs text-muted mt-1">
          📍 {formatAge(device.last_location_at)} ago
          {device.last_location_accuracy_m != null && (
            <> · ±{Math.round(device.last_location_accuracy_m)}m</>
          )}
        </div>
      )}
      {device.last_latitude != null && device.last_longitude != null && (
        <div className="text-xs text-faint mt-0.5">
          {device.last_latitude.toFixed(4)}, {device.last_longitude.toFixed(4)}
        </div>
      )}
      <button
        onClick={onOpen}
        className="mt-2 w-full text-xs font-semibold text-accent hover:underline text-left"
      >
        Open device detail →
      </button>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
