import { api as axios } from './client';

export type ChannelKind = 'email' | 'webhook';

export interface AlertChannel {
  id: string;
  tenant_id: string;
  name: string;
  kind: ChannelKind;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  smtp_user: string;
  smtp_pass: string;
  smtp_from: string;
  smtp_to: string[];
  webhook_url: string;
  webhook_secret: string;
  on_compliance_trigger: boolean;
  on_device_offline: boolean;
  on_posture_drop: boolean;
  enabled: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelInput {
  name: string;
  kind: ChannelKind;
  smtp_host?: string;
  smtp_port?: number;
  smtp_tls?: boolean;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_from?: string;
  smtp_to?: string[];
  webhook_url?: string;
  webhook_secret?: string;
  on_compliance_trigger?: boolean;
  on_device_offline?: boolean;
  on_posture_drop?: boolean;
  enabled?: boolean;
}

export interface AlertLogEntry {
  id: string;
  channel_id?: string;
  tenant_id: string;
  event_type: string;
  subject: string;
  payload: Record<string, unknown>;
  status: 'sent' | 'failed';
  error: string;
  created_at: string;
}

const BASE = '/api/v1/alerts';

export async function listChannels(): Promise<AlertChannel[]> {
  const r = await axios.get<{ channels: AlertChannel[] }>(`${BASE}/channels`);
  return r.data.channels ?? [];
}

export async function getChannel(id: string): Promise<AlertChannel> {
  const r = await axios.get<AlertChannel>(`${BASE}/channels/${id}`);
  return r.data;
}

export async function createChannel(input: ChannelInput): Promise<AlertChannel> {
  const r = await axios.post<AlertChannel>(`${BASE}/channels`, input);
  return r.data;
}

export async function updateChannel(id: string, input: ChannelInput): Promise<AlertChannel> {
  const r = await axios.put<AlertChannel>(`${BASE}/channels/${id}`, input);
  return r.data;
}

export async function deleteChannel(id: string): Promise<void> {
  await axios.delete(`${BASE}/channels/${id}`);
}

export async function testChannel(id: string): Promise<{ status: string; message: string }> {
  const r = await axios.post<{ status: string; message: string }>(`${BASE}/channels/${id}/test`);
  return r.data;
}

export async function listLog(channelId?: string): Promise<AlertLogEntry[]> {
  const r = await axios.get<{ logs: AlertLogEntry[] }>(`${BASE}/log`, {
    params: channelId ? { channel_id: channelId } : undefined,
  });
  return r.data.logs ?? [];
}
