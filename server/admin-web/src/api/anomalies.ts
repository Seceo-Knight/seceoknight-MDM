import axios from 'axios';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export type AnomalyType =
  | 'battery_drain'
  | 'posture_drop'
  | 'offline_spike'
  | 'location_jump'
  | 'app_burst'
  | 'storage_drop';

export interface Anomaly {
  id: string;
  tenant_id: string;
  device_id: string;
  anomaly_type: AnomalyType;
  severity: AnomalySeverity;
  z_score: number;
  description: string;
  details: Record<string, unknown>;
  resolved: boolean;
  resolved_at?: string;
  detected_at: string;
}

export const ANOMALY_META: Record<AnomalyType, { label: string; icon: string; color: string }> = {
  battery_drain:  { label: 'Battery Drain',    icon: '🔋', color: '#f59e0b' },
  posture_drop:   { label: 'Posture Drop',      icon: '🛡️', color: '#ef4444' },
  offline_spike:  { label: 'Offline Spike',     icon: '📡', color: '#8b5cf6' },
  location_jump:  { label: 'Location Jump',     icon: '📍', color: '#06b6d4' },
  app_burst:      { label: 'App Burst',         icon: '📦', color: '#f97316' },
  storage_drop:   { label: 'Storage Drop',      icon: '💾', color: '#ec4899' },
};

export const SEVERITY_META: Record<AnomalySeverity, { label: string; color: string; bg: string }> = {
  info:     { label: 'Info',     color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
  warning:  { label: 'Warning',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  critical: { label: 'Critical', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
};

const BASE = '/api/v1/telemetry';

export async function listAnomalies(limit = 200): Promise<Anomaly[]> {
  const { data } = await axios.get<{ items: Anomaly[] }>(`${BASE}/anomalies`, {
    params: { limit },
  });
  return data.items ?? [];
}

export async function listDeviceAnomalies(deviceId: string, limit = 100): Promise<Anomaly[]> {
  const { data } = await axios.get<{ items: Anomaly[] }>(`${BASE}/devices/${deviceId}/anomalies`, {
    params: { limit },
  });
  return data.items ?? [];
}

export async function resolveAnomaly(anomalyId: string): Promise<void> {
  await axios.post(`${BASE}/anomalies/${anomalyId}/resolve`);
}
