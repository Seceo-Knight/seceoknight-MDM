import { api } from './client';

export interface Device {
  id: string;
  tenant_id: string;
  alias?: string | null;
  group_id?: string | null;
  serial_number?: string;
  manufacturer?: string;
  model?: string;
  os_version?: string;
  security_patch_level?: string;
  state: 'pending' | 'enrolled' | 'offline' | 'wiped' | 'retired';
  last_heartbeat_at?: string;
  applied_policy_version: number;
  assigned_policy_id?: string | null;
  last_latitude?: number | null;
  last_longitude?: number | null;
  last_location_accuracy_m?: number | null;
  last_location_at?: string | null;
  last_ip_address?: string | null;
  last_mac_address?: string | null;
  last_battery_pct?: number | null;
  last_charging?: boolean | null;
  last_vpn_active?: boolean | null;
  last_storage_free_bytes?: number | null;
  last_wifi_ssid?: string | null;
  last_network_type?: string | null;
  last_mgmt_mode?: string | null; // owner | profile | admin | none — reported each heartbeat
  // Enrollment provenance (set once at enroll time):
  enrollment_channel?: string | null; // qr_setup | qr_inapp | direct_install | adb
  management_mode?: string | null;     // device_owner | profile_owner | device_admin
  // Live agent build, refreshed on every heartbeat:
  agent_version?: string | null;       // versionName e.g. "1.0.0"
  agent_version_code?: number | null;  // versionCode (bumps each build)
  last_posture_score?: number | null; // 0-100 attestation score
  last_posture_factors?: Record<string, unknown> | null;
  last_posture_at?: string | null;
  created_at?: string; // when the device was added to the platform (enrolled)
}

export async function listDevices(params: { limit?: number; offset?: number; q?: string; state?: string }) {
  const r = await api.get<{ total: number; items: Device[] }>('/api/v1/devices', { params });
  return r.data;
}

export async function getDevice(id: string) {
  const r = await api.get<Device>(`/api/v1/devices/${id}`);
  return r.data;
}

export async function retireDevice(id: string) {
  await api.delete(`/api/v1/devices/${id}`);
}

// updateDeviceAlias sets (or clears, with an empty string) the friendly device
// label. Server gates this to super_admin/admin and records who changed it in
// the audit log. Returns the updated device.
export async function updateDeviceAlias(id: string, alias: string) {
  const r = await api.patch<Device>(`/api/v1/devices/${id}`, { alias });
  return r.data;
}

// deviceLabel is the canonical way to render a device's name everywhere in the
// UI: prefer the operator-set alias, then serial, then a short UUID.
export function deviceLabel(d: { alias?: string | null; serial_number?: string; id: string }): string {
  return (d.alias && d.alias.trim()) || d.serial_number || d.id.slice(0, 8);
}

export interface CommandRow {
  id: string;
  device_id: string;
  kind: string;
  state: string;
  attempts: number;
  created_at: string;
  completed_at?: string;
  last_error?: string;
  result?: Record<string, unknown> | null;
}

export async function listDeviceCommands(deviceID: string) {
  const r = await api.get<{ items: CommandRow[] }>(`/api/v1/commands/by-device/${deviceID}`);
  return r.data.items;
}

export async function issueCommand(deviceID: string, kind: string, payload: Record<string, unknown> = {}) {
  const r = await api.post('/api/v1/commands', { device_id: deviceID, kind, payload });
  return r.data as CommandRow;
}

// broadcastCommand fans a command out to every device in a group. Returns the
// number of devices it was dispatched to.
export async function broadcastCommand(groupID: string, kind: string, payload: Record<string, unknown> = {}) {
  const r = await api.post('/api/v1/commands/broadcast', { group_id: groupID, kind, payload });
  return (r.data as { dispatched: number }).dispatched;
}

export async function deviceTelemetryLatest(deviceID: string) {
  const r = await api.get(`/api/v1/telemetry/devices/${deviceID}/latest`);
  return r.data as Record<string, unknown>;
}

export interface ActivityEvent {
  id: string;
  device_id: string;
  kind: string;
  payload: Record<string, unknown>;
  captured_at: string;
  received_at: string;
}

export async function listDeviceEvents(deviceID: string, kindPrefix = 'activity.', limit = 200) {
  const r = await api.get<{ items: ActivityEvent[] }>(
    `/api/v1/telemetry/devices/${deviceID}/events`,
    { params: { limit, kind_prefix: kindPrefix } }
  );
  return r.data.items;
}

// latestResultByKind walks the recent command history and returns the most
// recent successful result for the given kind, or null if none.
export function latestResultByKind(rows: CommandRow[] | undefined, kind: string): Record<string, unknown> | null {
  if (!rows) return null;
  for (const c of rows) {
    if (c.kind === kind && c.state === 'succeeded' && c.result) return c.result;
  }
  return null;
}
