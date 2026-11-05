import { api } from './client';
import type { FileObject } from './files';

// WebRTC ICE servers minted by the server (STUN + short-lived TURN creds). The
// admin passes these into the START_SCREEN_SHARE payload so the headless device
// uses the same relay without calling this surveillance-gated endpoint itself.
export interface IceServer { urls: string[]; username?: string; credential?: string }

export async function fetchTurnCredentials(): Promise<IceServer[]> {
  const r = await api.get<{ iceServers: IceServer[] }>('/api/v1/stream/turn');
  return r.data.iceServers ?? [];
}

// Screen-session recordings are ordinary file-service objects with kind="screen"
// (an MP4 per session uploaded by the agent on stop) — the "store what was done"
// archive.
export async function listScreenRecordings(deviceID: string): Promise<FileObject[]> {
  const r = await api.get<{ items: FileObject[] }>('/api/v1/files', {
    params: { kind: 'screen', device_id: deviceID },
  });
  return r.data.items;
}

// The viewer records the received stream in-browser (MediaRecorder) and uploads
// it here as a kind="screen" file — reliable, and it spares the headless device
// a second on-device encoder (which was adding latency and producing nothing).
export async function uploadScreenRecording(blob: Blob, name: string, deviceID: string): Promise<void> {
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('kind', 'screen');
  fd.append('name', name);
  fd.append('device_id', deviceID); // link to the device so it shows in its recordings list
  await api.post('/api/v1/files/upload', fd);
}

export async function presignScreen(id: string) {
  const r = await api.get<{ url: string; expires_in: number; sha256: string; size: number }>(`/api/v1/files/${id}/url`);
  return r.data;
}

export async function deleteScreen(id: string) {
  await api.delete(`/api/v1/files/${id}`);
}

/** WebSocket URL for the per-device WebRTC signaling relay. */
export function signalUrl(deviceID: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/signal?device_id=${encodeURIComponent(deviceID)}`;
}
