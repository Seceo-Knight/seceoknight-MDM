import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MapPin } from 'lucide-react';
import { Device } from '../api/devices';
import { isOnline } from './online';

// Leaflet is loaded via a CDN <script> in index.html — declare the global
// so TypeScript doesn't complain. We pin to the unpkg-hosted 1.9.4 build.
declare global { interface Window { L: any } }

/**
 * Interactive OpenStreetMap-tiled fleet map. Drops a marker for every
 * device that has a last_latitude / last_longitude reported via heartbeat.
 *
 *   - Online (heartbeat within 150s) → solid emerald dot
 *   - Stale / offline                → grey dot
 *   - Empty data                     → centered "no fixes yet" placeholder
 *
 * Clicking a marker opens a small popup with the device label and a deep
 * link into /devices/{id}. The map auto-fits to the visible markers on
 * first render; subsequent fleet updates do NOT re-pan so a refresh
 * doesn't yank the admin around while they're investigating one device.
 */
export function DeviceMap({ devices, height = 420, track = false }: { devices: Device[]; height?: number; track?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerLayerRef = useRef<any>(null);
  const fittedRef = useRef<boolean>(false);

  const located = devices.filter(d => d.last_latitude != null && d.last_longitude != null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (typeof window.L === 'undefined') {
      // Leaflet not loaded yet (CDN slow / offline). Fall back to nothing —
      // the placeholder JSX below takes over via the `located.length === 0`
      // path on the next render. We can't easily wait for it here without
      // a polling effect, and in practice the script is cached after first hit.
      return;
    }
    if (!mapRef.current) {
      const map = window.L.map(containerRef.current, {
        center: [20.5937, 78.9629], // India centroid — overwritten by fitBounds
        zoom: 5,
        scrollWheelZoom: true,
        worldCopyJump: true
      });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      }).addTo(map);
      markerLayerRef.current = window.L.layerGroup().addTo(map);
      mapRef.current = map;
    }
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    layer.clearLayers();
    const latlngs: [number, number][] = located.map(d => [d.last_latitude as number, d.last_longitude as number]);

    if (track) {
      // History "trail": connect the fixes in chronological order (devices are
      // passed oldest→newest) so the path the device travelled reads at a glance
      // — green start, red latest, numbered stops in between, joined by a line.
      if (latlngs.length >= 2) {
        // Soft underlay + dotted line on top for a clean "route" look.
        window.L.polyline(latlngs, { color: '#6366f1', weight: 8, opacity: 0.14, lineJoin: 'round' }).addTo(layer);
        window.L.polyline(latlngs, { color: '#6366f1', weight: 3, opacity: 0.85, dashArray: '1 7', lineCap: 'round' }).addTo(layer);
      }
      located.forEach((d, i) => {
        const lat = d.last_latitude as number;
        const lng = d.last_longitude as number;
        const isFirst = i === 0;
        const isLast = i === located.length - 1;
        const color = isFirst ? '#10b981' : isLast ? '#ef4444' : '#6366f1';
        const ring  = isFirst ? 'rgba(16,185,129,0.30)' : isLast ? 'rgba(239,68,68,0.30)' : 'rgba(99,102,241,0.22)';
        const size  = isFirst || isLast ? 24 : 20;
        const icon = window.L.divIcon({
          className: '',
          html: `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${color};color:#fff;font:600 11px/1 system-ui,sans-serif;box-shadow:0 0 0 4px ${ring};border:2px solid #fff">${i + 1}</span>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        });
        const when = d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : '';
        const tag = isFirst ? ' · start' : isLast ? ' · latest' : '';
        const html = `
          <div style="font-family:inherit;font-size:12px;line-height:1.4;">
            <div style="font-weight:600;">Stop #${i + 1}${tag}</div>
            <div style="color:#64748b;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
            ${when ? `<div style="color:#64748b;">${escapeHtml(when)}</div>` : ''}
            ${d.last_battery_pct != null ? `<div style="color:#64748b;">battery ${d.last_battery_pct}%</div>` : ''}
          </div>`;
        const m = window.L.marker([lat, lng], { icon, zIndexOffset: isFirst || isLast ? 1000 : 0 })
          .addTo(layer).bindPopup(html);
        m.on('click', () => m.openPopup());
      });
    } else {
      for (const d of located) {
        const lat = d.last_latitude as number;
        const lng = d.last_longitude as number;
        const online = isOnline(d.last_heartbeat_at);
        const color = online ? '#10b981' : '#94a3b8';
        const ring  = online ? 'rgba(16,185,129,0.35)' : 'rgba(148,163,184,0.30)';
        const icon = window.L.divIcon({
          className: '',
          html: `<span style="display:inline-block;width:14px;height:14px;border-radius:9999px;background:${color};box-shadow:0 0 0 6px ${ring};border:2px solid #fff"></span>`,
          iconSize: [14, 14], iconAnchor: [7, 7]
        });
        const label = d.model ? `${d.manufacturer ?? ''} ${d.model}`.trim() : (d.serial_number ?? d.id.slice(0, 8));
        const acc = d.last_location_accuracy_m != null ? `±${Math.round(d.last_location_accuracy_m)}m` : '';
        const seen = d.last_location_at ? new Date(d.last_location_at).toLocaleTimeString() : '';
        const html = `
          <div style="font-family:inherit;font-size:12px;line-height:1.4;">
            <div style="font-weight:600;">${escapeHtml(label)}</div>
            <div style="color:#64748b;">${lat.toFixed(5)}, ${lng.toFixed(5)} ${acc}</div>
            ${seen ? `<div style="color:#64748b;">fix @ ${seen}</div>` : ''}
            <a href="/devices/${d.id}" style="color:#6366f1;text-decoration:underline;">open device →</a>
          </div>`;
        const m = window.L.marker([lat, lng], { icon }).addTo(layer).bindPopup(html);
        m.on('click', () => m.openPopup());
      }
    }
    if (latlngs.length > 0 && !fittedRef.current) {
      map.fitBounds(latlngs as any, { padding: [40, 40], maxZoom: track ? 16 : 14 });
      fittedRef.current = true;
    }
    // Keep map sized to its container after Tailwind layout shifts.
    setTimeout(() => map.invalidateSize(), 0);
  }, [located.map(d => `${d.id}:${d.last_latitude},${d.last_longitude},${d.last_heartbeat_at}`).join('|')]);

  useEffect(() => () => {
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
  }, []);

  if (located.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-2 px-6 bg-surface-2/40" style={{ height }}>
        <MapPin size={22} className="text-faint" />
        <p className="text-sm text-muted max-w-xs">No devices have reported a location yet — heartbeats refresh GPS every ~5&nbsp;min.</p>
      </div>
    );
  }

  const onlineCount = located.filter(d => isOnline(d.last_heartbeat_at)).length;
  return (
    // `isolate` traps Leaflet's internal z-indexes (panes ~200-700, zoom controls
    // z-1000) inside this stacking context. Without it those controls live in the
    // document root and render OVER fixed overlays like the time-travel history modal.
    <div className="relative isolate" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      {/* Floating legend — keeps map chrome clean while surfacing counts */}
      {track ? (
        <div className="absolute left-3 bottom-3 z-[500] flex items-center gap-2 rounded-lg border border-line bg-surface/90 backdrop-blur px-2.5 py-1.5 text-2xs shadow-sm">
          <span className="font-medium text-fg tabular-nums">{located.length}</span>
          <span className="text-muted">stops</span>
          <span className="w-px h-3 bg-line" />
          <span className="inline-flex items-center gap-1 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />start</span>
          <span className="text-faint">→</span>
          <span className="inline-flex items-center gap-1 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />latest</span>
        </div>
      ) : (
        <div className="absolute left-3 bottom-3 z-[500] flex items-center gap-2 rounded-lg border border-line bg-surface/90 backdrop-blur px-2.5 py-1.5 text-2xs shadow-sm">
          <span className="font-medium text-fg tabular-nums">{located.length}</span>
          <span className="text-muted">located</span>
          <span className="w-px h-3 bg-line" />
          <span className="inline-flex items-center gap-1 text-success font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />{onlineCount} online
          </span>
          <span className="w-px h-3 bg-line" />
          <Link to="/devices" className="text-accent hover:underline">list →</Link>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
