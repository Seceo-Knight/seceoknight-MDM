import { api } from './client';

export interface LatLng { lat: number; lng: number }

export type GeofenceKind   = 'polygon' | 'circle';
export type GeofenceAction = 'alert' | 'lock' | 'wipe';

export interface Geofence {
  id:            string;
  tenant_id:     string;
  name:          string;
  description:   string;
  kind:          GeofenceKind;
  coordinates:   LatLng[];
  center_lat:    number;
  center_lng:    number;
  radius_meters: number;
  action:        GeofenceAction;
  color:         string;
  enabled:       boolean;
  created_by?:   string;
  created_at:    string;
  updated_at:    string;
}

export interface GeofenceEvent {
  id:           string;
  tenant_id:    string;
  geofence_id:  string;
  device_id:    string;
  event_type:   'enter' | 'exit';
  device_lat?:  number;
  device_lng?:  number;
  action_taken: string;
  note:         string;
  created_at:   string;
}

export interface GeofenceInput {
  name:          string;
  description?:  string;
  kind:          GeofenceKind;
  coordinates:   LatLng[];
  center_lat:    number;
  center_lng:    number;
  radius_meters?: number;
  action:        GeofenceAction;
  color?:        string;
  enabled?:      boolean;
}

const BASE = '/api/v1/compliance/geofences';

export async function listGeofences(): Promise<Geofence[]> {
  const r = await api.get<{ geofences: Geofence[] }>(BASE);
  return r.data.geofences ?? [];
}

export async function createGeofence(input: GeofenceInput): Promise<Geofence> {
  const r = await api.post<Geofence>(BASE, input);
  return r.data;
}

export async function updateGeofence(id: string, input: GeofenceInput): Promise<Geofence> {
  const r = await api.put<Geofence>(`${BASE}/${id}`, input);
  return r.data;
}

export async function deleteGeofence(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

export async function listGeofenceEvents(limit = 100): Promise<GeofenceEvent[]> {
  const r = await api.get<{ events: GeofenceEvent[] }>(`${BASE}/events`, { params: { limit } });
  return r.data.events ?? [];
}
