import { api } from './client';

export interface Policy {
  id: string;
  name: string;
  version: number;
  spec: Record<string, unknown>;
  updated_at: string;
}

export interface PolicyAssignment {
  id: string;
  tenant_id: string;
  policy_id: string;
  target_kind: 'tenant' | 'group' | 'device';
  target_id?: string | null;
  created_at: string;
}

export async function listPolicies() {
  const r = await api.get<{ items: Policy[] }>('/api/v1/policies');
  return r.data.items;
}

export async function getPolicy(id: string) {
  const r = await api.get<Policy>(`/api/v1/policies/${id}`);
  return r.data;
}

export async function savePolicy(p: { id?: string; name: string; spec: Record<string, unknown> }) {
  const r = await api.post<Policy>('/api/v1/policies', p);
  return r.data;
}

export async function deletePolicy(id: string) {
  await api.delete(`/api/v1/policies/${id}`);
}

export async function assignPolicy(policy_id: string, target_kind: 'tenant' | 'group' | 'device', target_id?: string) {
  await api.post('/api/v1/policies/assign', { policy_id, target_kind, target_id });
}

export async function unassignPolicy(policy_id: string, target_kind: 'tenant' | 'group' | 'device', target_id?: string) {
  await api.post('/api/v1/policies/unassign', { policy_id, target_kind, target_id });
}

export async function listAssignmentsFor(policyID: string) {
  const r = await api.get<{ items: PolicyAssignment[] }>(`/api/v1/policies/${policyID}/assignments`);
  return r.data.items;
}

export async function listAssignmentsForDevice(deviceID: string) {
  const r = await api.get<{ items: PolicyAssignment[] }>(`/api/v1/policies/for-device/${deviceID}`);
  return r.data.items;
}

export async function resolvedPolicyForDevice(deviceID: string): Promise<Policy | null> {
  try {
    const r = await api.get<Policy>(`/api/v1/policies/resolved-for/${deviceID}`);
    return r.data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}
