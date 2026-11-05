import { api } from './client';

export interface EnrollmentToken {
  id: string;
  token: string;
  expires_at: string;
  qr_url: string;
  provision_url: string;
}

export type ProvisioningMode = 'device_owner' | 'work_profile' | 'device_admin' | 'stealth';

export async function createEnrollmentToken(input: { one_shot: boolean; max_uses: number; expires_in: string; policy_id?: string; provisioning_mode?: ProvisioningMode }) {
  const r = await api.post<EnrollmentToken>('/api/v1/enroll/tokens', input);
  return r.data;
}

export async function fetchQRPayload(tokenID: string) {
  const r = await api.get(`/api/v1/enroll/qr/${tokenID}`);
  return r.data;
}

export interface EnrollmentConfig {
  server_base_url: string;
  apk_download_url: string;
  apk_signature_checksum: string;
  dpc_package_name: string;
  dpc_component_name: string;
  wifi_ssid: string;
  wifi_password: string;
  wifi_security_type: string; // NONE | WPA | WEP | EAP
  wifi_hidden: boolean;
  skip_encryption: boolean;
  leave_system_apps: boolean;
}

export async function getEnrollmentConfig() {
  const r = await api.get<EnrollmentConfig>('/api/v1/enroll/config');
  return r.data;
}

export async function saveEnrollmentConfig(cfg: EnrollmentConfig) {
  const r = await api.put<EnrollmentConfig>('/api/v1/enroll/config', cfg);
  return r.data;
}
