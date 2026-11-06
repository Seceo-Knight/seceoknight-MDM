import axios from 'axios';

// ─── Fleet app inventory ──────────────────────────────────────────────────────

export interface FleetApp {
  package_name: string;
  app_name: string;
  version_name?: string;
  device_count: number;
  device_ids: string[];
}

export async function listFleetApps(limit = 500): Promise<{ items: FleetApp[]; total: number }> {
  const { data } = await axios.get<{ items: FleetApp[]; total: number }>(
    '/api/v1/telemetry/fleet/apps',
    { params: { limit } },
  );
  return { items: data.items ?? [], total: data.total ?? 0 };
}

// ─── Package blocklist ────────────────────────────────────────────────────────

export interface BlockedPackage {
  id: string;
  tenant_id: string;
  package_name: string;
  display_name: string;
  reason: string;
  created_by?: string;
  created_at: string;
}

export async function listBlockedPackages(): Promise<BlockedPackage[]> {
  const { data } = await axios.get<{ items: BlockedPackage[] }>('/api/v1/compliance/blocklist');
  return data.items ?? [];
}

export async function addBlockedPackage(body: {
  package_name: string;
  display_name?: string;
  reason?: string;
}): Promise<BlockedPackage> {
  const { data } = await axios.post<BlockedPackage>('/api/v1/compliance/blocklist', body);
  return data;
}

export async function deleteBlockedPackage(id: string): Promise<void> {
  await axios.delete(`/api/v1/compliance/blocklist/${id}`);
}
