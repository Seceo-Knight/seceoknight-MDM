import { api as axios } from './client';

export type TriggerField = 'posture_score' | 'battery_level';
export type Operator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
export type EventStatus = 'triggered' | 'skipped' | 'failed';

export interface ComplianceRule {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  trigger_field: TriggerField;
  operator: Operator;
  threshold: number;
  action: string;
  action_payload: Record<string, unknown>;
  cooldown_minutes: number;
  enabled: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ComplianceEvent {
  id: string;
  rule_id: string;
  device_id: string;
  tenant_id: string;
  trigger_value?: number;
  action: string;
  status: EventStatus;
  command_id?: string;
  note: string;
  created_at: string;
}

export interface RuleInput {
  name: string;
  description?: string;
  trigger_field: TriggerField;
  operator: Operator;
  threshold: number;
  action: string;
  action_payload?: Record<string, unknown>;
  cooldown_minutes?: number;
  enabled?: boolean;
}

const BASE = '/api/v1/compliance';

export async function listRules(): Promise<ComplianceRule[]> {
  const r = await axios.get<{ rules: ComplianceRule[] }>(`${BASE}/rules`);
  return r.data.rules;
}

export async function createRule(input: RuleInput): Promise<ComplianceRule> {
  const r = await axios.post<ComplianceRule>(`${BASE}/rules`, input);
  return r.data;
}

export async function updateRule(id: string, input: RuleInput): Promise<ComplianceRule> {
  const r = await axios.put<ComplianceRule>(`${BASE}/rules/${id}`, input);
  return r.data;
}

export async function deleteRule(id: string): Promise<void> {
  await axios.delete(`${BASE}/rules/${id}`);
}

export interface ListEventsParams {
  device_id?: string;
  rule_id?: string;
  limit?: number;
}

export async function listEvents(params?: ListEventsParams): Promise<ComplianceEvent[]> {
  const r = await axios.get<{ events: ComplianceEvent[] }>(`${BASE}/events`, { params });
  return r.data.events;
}
