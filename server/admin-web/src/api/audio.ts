import { api } from './client';
import type { FileObject } from './files';

// Audio recordings are ordinary file-service objects with kind="audio". The
// agent records the mic in short back-to-back segments and uploads each one as
// it finishes, naming it `audio_<session>_<seq>_<ts>.m4a` so the UI can group a
// live session and play its segments in order. Every segment is stored, so the
// same list doubles as the saved-recordings archive.

export async function listDeviceAudios(deviceID: string): Promise<FileObject[]> {
  const r = await api.get<{ items: FileObject[] }>('/api/v1/files', {
    params: { kind: 'audio', device_id: deviceID }
  });
  return r.data.items;
}

export async function presignAudio(id: string) {
  const r = await api.get<{ url: string; expires_in: number; sha256: string; size: number }>(
    `/api/v1/files/${id}/url`
  );
  return r.data;
}

export async function deleteAudio(id: string) {
  await api.delete(`/api/v1/files/${id}`);
}

// deleteAudioSession removes an entire recording session — all its segments and
// the cached stitched file — in one call.
export async function deleteAudioSession(sessionId: string) {
  await api.delete(`/api/v1/files/audio/session/${sessionId}`);
}

// sessionAudioUrl returns a presigned URL to the whole session stitched into a
// single continuous .aac (server concatenates the ADTS segments). Throws 422
// for legacy (.m4a) sessions that can't be byte-stitched.
export async function sessionAudioUrl(sessionId: string) {
  const r = await api.get<{ url: string; expires_in: number; segments: number }>(
    `/api/v1/files/audio/session/${sessionId}/url`
  );
  return r.data;
}

// parseAudioName pulls the session id and segment sequence out of a segment's
// file name (audio_<session>_<seq>_<ts>.ext). The session id is whatever the
// dashboard generated — a UUID in a secure context, or a `sess-xxxx` fallback
// over plain HTTP where crypto.randomUUID() isn't available — so accept any
// non-underscore session token, not just hex. (Underscore is the delimiter.)
export function parseAudioName(name: string): { session: string | null; seq: number | null } {
  const m = /^audio_([^_]+)_(\d+)_/.exec(name);
  if (!m) return { session: null, seq: null };
  return { session: m[1], seq: parseInt(m[2], 10) };
}

// newSessionId mints a short random id for a live-listen session. crypto UUID
// when available, with a cheap fallback for older browsers.
export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2, 10);
}
