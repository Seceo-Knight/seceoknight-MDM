import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listGeofences, createGeofence, updateGeofence, deleteGeofence, listGeofenceEvents,
  type Geofence, type GeofenceInput, type GeofenceAction, type GeofenceKind, type LatLng,
} from '../api/geofences';
import { listDevices, deviceLabel } from '../api/devices';
import {
  Panel, PageHero, HeroStat, Badge, Button, Field, Input, EmptyState,
  Hairline, Modal, ModalHeader, ModalBody, ModalFooter,
} from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { toast } from '../components/toast';
import { MapPin, Shield, AlertTriangle, Lock, Trash2, Plus, Eye, EyeOff, Edit2, Radio, Navigation } from 'lucide-react';
import { MapContainer, TileLayer, Polygon, Circle, useMap, useMapEvents, Marker, Popup } from 'react-leaflet';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import L from 'leaflet';
import clsx from 'clsx';

// Leaflet CSS is loaded via CDN in index.html — no import needed here.
// Fix default marker icon path for bundled environments.
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const ACTION_META: Record<GeofenceAction, { label: string; color: string; icon: typeof Shield }> = {
  alert: { label: 'Alert',       color: 'text-warn  bg-warn-soft  ring-warn/20',  icon: AlertTriangle },
  lock:  { label: 'Lock device', color: 'text-info  bg-info-soft  ring-info/20',  icon: Lock },
  wipe:  { label: 'Remote wipe', color: 'text-danger bg-danger-soft ring-danger/20', icon: Trash2 },
};

const FENCE_COLORS = ['#2DD4E8','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4'];

// ─── Map draw helper ──────────────────────────────────────────────────────────

function PolygonDrawer({ drawing, onAdd }: { drawing: boolean; onAdd: (pt: LatLng) => void }) {
  useMapEvents({
    click(e) {
      if (drawing) onAdd({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function FitBounds({ fences }: { fences: Geofence[] }) {
  const map = useMap();
  useEffect(() => {
    const pts: [number, number][] = fences.flatMap(f => f.coordinates.map(c => [c.lat, c.lng] as [number, number]));
    if (pts.length >= 2) {
      try { map.fitBounds(pts as any, { padding: [40, 40] }); } catch { /* ignore */ }
    }
  }, [fences.length]); // eslint-disable-line
  return null;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Geofencing() {
  const qc = useQueryClient();
  const { data: fences = [], isLoading } = useQuery({ queryKey: ['geofences'], queryFn: listGeofences, refetchInterval: 15000 });
  const { data: events = [] } = useQuery({ queryKey: ['geofence-events'], queryFn: () => listGeofenceEvents(50), refetchInterval: 10000 });
  const { data: devicesResp } = useQuery({ queryKey: ['devices', 'geo'], queryFn: () => listDevices({ limit: 500 }) });
  const devices = devicesResp?.items ?? [];

  const [selected, setSelected] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editFence, setEditFence] = useState<Geofence | null>(null);
  const [drawPoints, setDrawPoints] = useState<LatLng[]>([]);
  const [drawing, setDrawing] = useState(false);

  const selectedFence = fences.find(f => f.id === selected);

  const toggle = useMutation({
    mutationFn: (f: Geofence) => updateGeofence(f.id, { ...f, enabled: !f.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['geofences'] }),
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteGeofence(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['geofences'] });
      if (selected === id) setSelected(null);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  });

  const enabled = fences.filter(f => f.enabled).length;
  const totalDevices = devices.length;

  return (
    <div className="space-y-5">
      <PageHero
        icon={MapPin}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" style={{ animation: 'onlinePulse 2s infinite' }} /> Location security</>}
        title="Geofencing"
        subtitle="Draw virtual boundaries and automatically enforce device policies when boundaries are crossed."
        actions={
          <Button onClick={() => { setEditFence(null); setDrawPoints([]); setDrawing(false); setShowModal(true); }}>
            <Plus size={15} /> New fence
          </Button>
        }
        stats={<>
          <HeroStat icon={MapPin}  label="Fences"   value={fences.length} tone="accent" />
          <HeroStat icon={Shield}  label="Active"   value={enabled}       tone="success" />
          <HeroStat icon={Radio}   label="Devices"  value={totalDevices}  tone="info" />
        </>}
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Map panel */}
        <div className="xl:col-span-2">
          <Panel
            icon={MapPin}
            title="Fleet geofence map"
            subtitle="Click a fence to inspect. Use New fence to draw boundaries."
            className="relative overflow-hidden card-grad ring-1 ring-inset ring-line"
            bodyClassName="p-0"
          >
            <Hairline />
            <div className="relative" style={{ height: 440 }}>
              {drawing && (
                <div className="pointer-events-none absolute z-[500] inset-x-0 top-3 flex justify-center">
                  <span className="rounded-xl bg-accent text-accent-fg px-4 py-2 text-xs font-semibold shadow-lg ring-1 ring-white/20">
                    Click on the map to place fence points · {drawPoints.length} placed
                  </span>
                </div>
              )}
              <MapContainer
                center={[20, 0]}
                zoom={2}
                style={{ height: '100%', width: '100%', background: 'transparent' }}
                zoomControl={true}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                />
                <FitBounds fences={fences.filter(f => f.coordinates.length >= 3) as Geofence[]} />
                <PolygonDrawer drawing={drawing} onAdd={pt => setDrawPoints(prev => [...prev, pt])} />

                {/* Existing fences */}
                {fences.map(f => {
                  const isSelected = f.id === selected;
                  const opacity = f.enabled ? (isSelected ? 0.5 : 0.3) : 0.1;
                  if (f.kind === 'circle') {
                    return (
                      <Circle
                        key={f.id}
                        center={[f.center_lat, f.center_lng]}
                        radius={f.radius_meters}
                        pathOptions={{ color: f.color, fillColor: f.color, fillOpacity: opacity, weight: isSelected ? 3 : 2 }}
                        eventHandlers={{ click: () => setSelected(f.id) }}
                      />
                    );
                  }
                  if (f.coordinates.length < 3) return null;
                  return (
                    <Polygon
                      key={f.id}
                      positions={f.coordinates.map(c => [c.lat, c.lng] as [number, number])}
                      pathOptions={{ color: f.color, fillColor: f.color, fillOpacity: opacity, weight: isSelected ? 3 : 2 }}
                      eventHandlers={{ click: () => setSelected(f.id) }}
                    />
                  );
                })}

                {/* Drawing preview */}
                {drawing && drawPoints.length >= 3 && (
                  <Polygon
                    positions={drawPoints.map(p => [p.lat, p.lng] as [number, number])}
                    pathOptions={{ color: '#2DD4E8', fillColor: '#2DD4E8', fillOpacity: 0.25, dashArray: '6 4' }}
                  />
                )}

                {/* Device markers */}
                {devices.filter(d => d.last_latitude != null && d.last_longitude != null).map(d => (
                  <Marker key={d.id} position={[d.last_latitude!, d.last_longitude!]}>
                    <Popup>{deviceLabel(d)}</Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          </Panel>
        </div>

        {/* Fence list */}
        <div className="space-y-4">
          <Panel
            icon={Shield}
            title="Active fences"
            actions={<Badge tone={enabled ? 'success' : 'muted'} dot>{enabled} active</Badge>}
            className="relative overflow-hidden card-grad ring-1 ring-inset ring-line"
            bodyClassName="p-0"
          >
            <Hairline />
            {isLoading && (
              <div className="p-4 space-y-3">
                {[1,2,3].map(i => <div key={i} className="h-14 rounded-lg skeleton" />)}
              </div>
            )}
            {!isLoading && fences.length === 0 && (
              <EmptyState
                icon={<MapPin size={20} className="text-faint" />}
                title="No fences yet"
                hint="Create your first geofence to enforce location-based policies."
                action={<Button size="sm" onClick={() => setShowModal(true)}><Plus size={14} />New fence</Button>}
              />
            )}
            {fences.map(f => {
              const meta = ACTION_META[f.action as GeofenceAction] ?? ACTION_META.alert;
              const ActionIcon = meta.icon;
              return (
                <div
                  key={f.id}
                  onClick={() => setSelected(s => s === f.id ? null : f.id)}
                  className={clsx(
                    'group flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-line/60 last:border-0 transition-colors',
                    selected === f.id ? 'bg-accent/10' : 'hover:bg-surface-2'
                  )}
                >
                  <span className="w-3 h-3 rounded-full shrink-0 ring-2 ring-surface" style={{ background: f.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-sm font-medium text-fg">{f.name}</span>
                      {!f.enabled && <Badge tone="muted" className="shrink-0">off</Badge>}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset', meta.color)}>
                        <ActionIcon size={10} />{meta.label}
                      </span>
                      <span className="text-2xs text-faint capitalize">{f.kind}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      title={f.enabled ? 'Disable' : 'Enable'}
                      onClick={e => { e.stopPropagation(); toggle.mutate(f); }}
                      className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-3 transition-colors"
                    >
                      {f.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                    <button
                      title="Edit"
                      onClick={e => { e.stopPropagation(); setEditFence(f); setDrawPoints(f.coordinates); setDrawing(false); setShowModal(true); }}
                      className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-fg hover:bg-surface-3 transition-colors"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      title="Delete"
                      onClick={async e => {
                        e.stopPropagation();
                        if (await confirmDialog({ title: `Delete "${f.name}"?`, message: 'All history for this fence will also be removed.', confirmLabel: 'Delete', icon: Trash2 })) {
                          remove.mutate(f.id);
                        }
                      }}
                      className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </Panel>

          {/* Selected fence detail */}
          {selectedFence && (
            <Panel
              icon={Navigation}
              title={selectedFence.name}
              subtitle={selectedFence.description || 'No description'}
              className="relative overflow-hidden card-grad ring-1 ring-inset ring-accent/30 animate-fadein"
            >
              <Hairline tone="accent" />
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Status</dt>
                  <dd><Badge tone={selectedFence.enabled ? 'success' : 'muted'} dot>{selectedFence.enabled ? 'Active' : 'Disabled'}</Badge></dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Kind</dt>
                  <dd className="text-fg capitalize">{selectedFence.kind}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">On exit</dt>
                  <dd>
                    <span className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', ACTION_META[selectedFence.action as GeofenceAction]?.color)}>
                      {ACTION_META[selectedFence.action as GeofenceAction]?.label}
                    </span>
                  </dd>
                </div>
                {selectedFence.kind === 'circle' && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Radius</dt>
                    <dd className="text-fg tabular-nums">{selectedFence.radius_meters}m</dd>
                  </div>
                )}
                {selectedFence.kind === 'polygon' && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Points</dt>
                    <dd className="text-fg tabular-nums">{selectedFence.coordinates.length}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted">Created</dt>
                  <dd className="text-fg tabular-nums">{new Date(selectedFence.created_at).toLocaleDateString()}</dd>
                </div>
              </dl>
            </Panel>
          )}
        </div>
      </div>

      {/* Violation log */}
      {events.length > 0 && (
        <Panel
          icon={Radio}
          title="Geofence events"
          subtitle="Recent boundary crossings and triggered actions"
          className="relative overflow-hidden card-grad ring-1 ring-inset ring-line"
          bodyClassName="p-0"
        >
          <Hairline />
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2/40">
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Fence</th>
                  <th className="px-4 py-2.5">Device</th>
                  <th className="px-4 py-2.5">Event</th>
                  <th className="px-4 py-2.5">Action taken</th>
                </tr>
              </thead>
              <tbody className="rail divide-y divide-line">
                {events.slice(0, 20).map(e => {
                  const fence = fences.find(f => f.id === e.geofence_id);
                  const device = devices.find(d => d.id === e.device_id);
                  return (
                    <tr key={e.id} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-2.5 text-xs text-muted tabular-nums whitespace-nowrap">
                        {new Date(e.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5">
                          {fence && <span className="w-2.5 h-2.5 rounded-full ring-1 ring-surface" style={{ background: fence.color }} />}
                          <span className="font-medium text-fg">{fence?.name ?? e.geofence_id.slice(0, 8)}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted text-xs">
                        {device ? deviceLabel(device) : e.device_id.slice(0, 12) + '…'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={e.event_type === 'exit' ? 'danger' : 'success'} dot>
                          {e.event_type === 'exit' ? 'Exited' : 'Entered'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium ring-1 ring-inset', ACTION_META[e.action_taken as GeofenceAction]?.color ?? '')}>
                          {e.action_taken}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {showModal && (
        <GeofenceModal
          fence={editFence}
          initialPoints={drawPoints}
          onClose={() => { setShowModal(false); setEditFence(null); setDrawPoints([]); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['geofences'] });
            setShowModal(false);
            setEditFence(null);
            setDrawPoints([]);
          }}
        />
      )}
    </div>
  );
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────

function GeofenceModal({ fence, initialPoints, onClose, onSaved }: {
  fence: Geofence | null;
  initialPoints: LatLng[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName]       = useState(fence?.name ?? '');
  const [desc, setDesc]       = useState(fence?.description ?? '');
  const [kind, setKind]       = useState<GeofenceKind>(fence?.kind ?? 'polygon');
  const [action, setAction]   = useState<GeofenceAction>(fence?.action ?? 'alert');
  const [color, setColor]     = useState(fence?.color ?? '#2DD4E8');
  const [radius, setRadius]   = useState(fence?.radius_meters ?? 500);
  const [points, setPoints]   = useState<LatLng[]>(initialPoints);
  const [drawing, setDrawing] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const center = points.length > 0
        ? { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length }
        : { lat: 0, lng: 0 };
      const input: GeofenceInput = {
        name, description: desc, kind, coordinates: points,
        center_lat: center.lat, center_lng: center.lng,
        radius_meters: radius, action, color,
      };
      return fence ? updateGeofence(fence.id, input) : createGeofence(input);
    },
    onSuccess: () => { toast.success(fence ? 'Fence updated' : 'Fence created'); onSaved(); },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Save failed'),
  });

  const canSave = name.trim().length > 0 && (kind === 'circle' || points.length >= 3);

  return (
    <Modal onClose={onClose} label={fence ? 'Edit geofence' : 'New geofence'} width="max-w-4xl">
      <ModalHeader
        icon={MapPin}
        title={fence ? 'Edit geofence' : 'New geofence'}
        subtitle="Define the boundary coordinates and enforcement action."
        onClose={onClose}
      />
      <ModalBody className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name *">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="HQ Building A" autoFocus />
          </Field>
          <Field label="Description">
            <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional description" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {/* Kind */}
          <Field label="Fence type">
            <div className="flex gap-2">
              {(['polygon','circle'] as GeofenceKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={clsx('flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors', kind === k ? 'border-accent bg-accent/10 text-accent ring-1 ring-inset ring-accent/20' : 'border-line hover:bg-surface-2 text-muted')}
                >{k}</button>
              ))}
            </div>
          </Field>

          {/* Action */}
          <Field label="Action on exit">
            <div className="flex flex-col gap-1.5">
              {(Object.entries(ACTION_META) as [GeofenceAction, typeof ACTION_META['alert']][]).map(([k, m]) => (
                <button
                  key={k}
                  onClick={() => setAction(k)}
                  className={clsx('flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors', action === k ? clsx('border-transparent ring-1 ring-inset', m.color) : 'border-line hover:bg-surface-2 text-muted')}
                >
                  <m.icon size={12} />{m.label}
                </button>
              ))}
            </div>
          </Field>

          {/* Color + radius */}
          <div className="space-y-3">
            <Field label="Fence color">
              <div className="flex flex-wrap gap-1.5">
                {FENCE_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    style={{ background: c }}
                    className={clsx('w-6 h-6 rounded-full ring-2 ring-offset-2 ring-offset-surface transition-all', color === c ? 'ring-fg scale-110' : 'ring-transparent hover:scale-105')}
                  />
                ))}
              </div>
            </Field>
            {kind === 'circle' && (
              <Field label="Radius (m)">
                <Input type="number" value={radius} onChange={e => setRadius(Number(e.target.value))} min={50} max={50000} />
              </Field>
            )}
          </div>
        </div>

        {/* Map draw */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">
              {kind === 'polygon'
                ? `Boundary points (${points.length}${points.length < 3 ? ' — need 3+' : ' ✓'})`
                : 'Centre point'}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setDrawing(d => !d)}
                className={clsx('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors', drawing ? 'bg-accent text-accent-fg' : 'border border-line text-muted hover:bg-surface-2')}
              >
                <MapPin size={12} />{drawing ? 'Stop drawing' : 'Draw on map'}
              </button>
              {points.length > 0 && (
                <button onClick={() => setPoints([])} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2">
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="relative rounded-xl overflow-hidden ring-1 ring-inset ring-line" style={{ height: 300 }}>
            {drawing && (
              <div className="pointer-events-none absolute z-[500] inset-x-0 top-3 flex justify-center">
                <span className="rounded-xl bg-accent text-accent-fg px-3 py-1.5 text-xs font-semibold shadow-lg">
                  Click to place points · {points.length} placed
                </span>
              </div>
            )}
            <MapContainer center={points.length > 0 ? [points[0].lat, points[0].lng] : [20, 0]} zoom={points.length > 0 ? 13 : 2} style={{ height: '100%', width: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <PolygonDrawer drawing={drawing} onAdd={pt => {
                if (kind === 'circle') setPoints([pt]);
                else setPoints(prev => [...prev, pt]);
              }} />
              {kind === 'polygon' && points.length >= 3 && (
                <Polygon
                  positions={points.map(p => [p.lat, p.lng] as [number, number])}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.3 }}
                />
              )}
              {kind === 'circle' && points.length === 1 && (
                <Circle
                  center={[points[0].lat, points[0].lng]}
                  radius={radius}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.3 }}
                />
              )}
            </MapContainer>
          </div>
          {kind === 'polygon' && points.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {points.map((p, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-2xs font-mono text-muted ring-1 ring-inset ring-line">
                  {i+1}: {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                  <button onClick={() => setPoints(pts => pts.filter((_, j) => j !== i))} className="text-faint hover:text-danger ml-1">×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
          {save.isPending ? 'Saving…' : fence ? 'Save changes' : 'Create fence'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
