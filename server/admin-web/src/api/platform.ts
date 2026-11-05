import { api } from './client';

// Global (cross-tenant) platform settings. Today: the debug-unlock password
// that gates the agent's hidden in-app config panel (operators type it on the
// device to repoint the server address while the server is unreachable). The
// password is stored/returned in plaintext for the operator to view & rotate;
// devices only ever receive its hash. Gated server-side by platform:manage.
export interface PlatformSettings {
  debug_unlock_password: string;
  updated_at?: string;
  updated_by?: string | null;
}

export async function getPlatformSettings() {
  const r = await api.get<PlatformSettings>('/api/v1/enroll/platform-settings');
  return r.data;
}

export async function savePlatformSettings(debug_unlock_password: string) {
  const r = await api.put<PlatformSettings>('/api/v1/enroll/platform-settings', { debug_unlock_password });
  return r.data;
}
