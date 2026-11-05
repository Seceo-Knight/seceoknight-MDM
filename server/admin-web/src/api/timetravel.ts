import { api } from './client';

export interface Snapshot {
  device_id: string;
  captured_at: string;
  state?: string | null;
  mgmt_mode?: string | null;
  applied_policy_version?: number | null;
  battery_pct?: number | null;
  charging?: boolean | null;
  network_type?: string | null;
  wifi_ssid?: string | null;
  ip_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy_m?: number | null;
  alias?: string | null;
  serial_number?: string | null;
}

export interface AuditEntry {
  id: string;
  actor_kind: string;
  actor_id?: string;
  action: string;
  target_kind?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface FleetAsOf { at: string; devices: Snapshot[]; actions: AuditEntry[] }
export interface DeviceHistory { from: string; to: string; snapshots: Snapshot[]; actions: AuditEntry[] }

// fleetAsOf reconstructs the whole fleet at instant `at` (ISO string; omit for now).
export async function fleetAsOf(at?: string): Promise<FleetAsOf> {
  const r = await api.get<FleetAsOf>('/api/v1/timetravel/fleet', { params: at ? { at } : undefined });
  return r.data;
}

// deviceHistory returns a device's snapshot series + audit timeline in a window.
export async function deviceHistory(deviceID: string, from: string, to: string): Promise<DeviceHistory> {
  const r = await api.get<DeviceHistory>(`/api/v1/timetravel/device/${deviceID}`, { params: { from, to } });
  return r.data;
}
