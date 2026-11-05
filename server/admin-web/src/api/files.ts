import { api } from './client';

export interface FileObject {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  storage_key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  uploaded_by: string;
  created_at: string;
}

export async function listFiles(kind?: string) {
  const r = await api.get<{ items: FileObject[] }>(`/api/v1/files`, { params: kind ? { kind } : undefined });
  return r.data.items;
}

export async function uploadFile(file: File, kind: 'apk' | 'cert' | 'generic' = 'generic'): Promise<FileObject> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  const r = await api.post<FileObject>('/api/v1/files/upload', fd);
  return r.data;
}

export async function presignDownload(id: string) {
  const r = await api.get<{ url: string; expires_in: number; sha256: string; size: number }>(`/api/v1/files/${id}/url`);
  return r.data;
}

export async function deleteFile(id: string) {
  await api.delete(`/api/v1/files/${id}`);
}
