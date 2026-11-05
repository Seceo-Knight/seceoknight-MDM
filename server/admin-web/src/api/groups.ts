import { api } from './client';

export interface DeviceGroup {
  id: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  device_count: number;
  created_at: string;
  updated_at: string;
}

export async function listGroups(): Promise<DeviceGroup[]> {
  const r = await api.get<{ items: DeviceGroup[] }>('/api/v1/groups');
  return r.data.items;
}

export async function createGroup(name: string, description?: string): Promise<DeviceGroup> {
  const r = await api.post<DeviceGroup>('/api/v1/groups', { name, description: description || undefined });
  return r.data;
}

export async function updateGroup(id: string, body: { name?: string; description?: string }) {
  await api.patch(`/api/v1/groups/${id}`, body);
}

export async function deleteGroup(id: string) {
  await api.delete(`/api/v1/groups/${id}`);
}

// setDeviceGroup assigns a device to a group, or clears it with an empty string.
export async function setDeviceGroup(deviceID: string, groupID: string) {
  await api.patch(`/api/v1/devices/${deviceID}`, { group_id: groupID });
}
