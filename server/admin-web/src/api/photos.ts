import { api } from './client';
import type { FileObject } from './files';

export async function listDevicePhotos(deviceID: string): Promise<FileObject[]> {
  const r = await api.get<{ items: FileObject[] }>('/api/v1/files', { params: { kind: 'photo', device_id: deviceID } });
  return r.data.items;
}

export async function presignPhoto(id: string) {
  const r = await api.get<{ url: string; expires_in: number; sha256: string; size: number }>(`/api/v1/files/${id}/url`);
  return r.data;
}

export async function deletePhoto(id: string) {
  await api.delete(`/api/v1/files/${id}`);
}
