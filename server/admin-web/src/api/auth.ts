import { api } from './client';

export interface AuthUserDTO {
  id: string; email: string; role: string; tenant_id: string; permissions?: string[];
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: AuthUserDTO;
}

/** Returned when the server needs an MFA code before issuing tokens. */
export interface MFARequiredResponse {
  mfa_required: true;
}

export type LoginResult = LoginResponse | MFARequiredResponse;

export function isMFARequired(r: LoginResult): r is MFARequiredResponse {
  return 'mfa_required' in r && r.mfa_required === true;
}

/** First step: email + password only. Second step: include mfa_code. */
export async function login(
  email: string,
  password: string,
  mfa_code?: string,
): Promise<LoginResult> {
  const r = await api.post<LoginResult>('/api/v1/auth/login', {
    email,
    password,
    ...(mfa_code ? { mfa_code } : {}),
  });
  return r.data;
}

export async function me() {
  const r = await api.get('/api/v1/auth/me');
  return r.data as AuthUserDTO;
}

// ---- RBAC: roles matrix + user management (super_admin) ----

export interface RolesMatrix {
  roles: string[];
  permissions: string[];
  matrix: Record<string, string[]>;
}

export async function getRoles(): Promise<RolesMatrix> {
  const r = await api.get<RolesMatrix>('/api/v1/auth/roles');
  return r.data;
}

export async function createUser(email: string, password: string, role: string): Promise<TenantUser> {
  const r = await api.post<TenantUser>('/api/v1/auth/users', { email, password, role });
  return r.data;
}

export async function updateUserRole(id: string, role: string) {
  await api.patch(`/api/v1/auth/users/${id}/role`, { role });
}

export async function deactivateUser(id: string) {
  await api.post(`/api/v1/auth/users/${id}/deactivate`, {});
}

export async function logoutServer(refresh_token: string) {
  await api.post('/api/v1/auth/logout', { refresh_token });
}

export interface TenantUser { id: string; email: string; role: string; tenant_id: string }

// listUsers returns the tenant's admin users so the audit log can resolve an
// actor UUID to an email. super_admin/admin only on the server.
export async function listUsers(): Promise<TenantUser[]> {
  const r = await api.get<{ items: TenantUser[] }>('/api/v1/auth/users');
  return r.data.items;
}

// ---- Access Log: active admin sessions ----

export interface Session {
  id: string;
  user_id: string;
  email: string;
  role: string;
  ip: string;
  user_agent: string;
  issued_at: string;   // also "last active" — advances on each token refresh
  expires_at: string;
}

// listSessions returns the tenant's live admin sessions (user:read).
export async function listSessions(): Promise<Session[]> {
  const r = await api.get<{ items: Session[] }>('/api/v1/auth/sessions');
  return r.data.items;
}

// revokeSession force-logs-out a session by id (user:manage). 204 on success.
export async function revokeSession(id: string) {
  await api.post(`/api/v1/auth/sessions/${id}/revoke`, {});
}

// changePassword updates the logged-in user's own password (server verifies the
// current one). 204 on success.
export async function changePassword(old_password: string, new_password: string) {
  await api.post('/api/v1/auth/change-password', { old_password, new_password });
}

// updateEmail changes the logged-in user's own email; returns the updated user.
export async function updateEmail(email: string): Promise<TenantUser> {
  const r = await api.patch<TenantUser>('/api/v1/auth/me', { email });
  return r.data;
}

// ---- MFA TOTP API -------------------------------------------------------

export interface MFAStatus {
  enabled: boolean;
}

export interface MFASetupResponse {
  /** Base32 TOTP secret for manual entry into an authenticator app. */
  secret: string;
  /** data:image/png;base64,... QR code to scan. */
  qr_code: string;
}

export interface BackupCodesResponse {
  codes: string[];
}

/** Returns whether MFA is currently active for the logged-in user. */
export async function mfaStatus(): Promise<MFAStatus> {
  const r = await api.get<MFAStatus>('/api/v1/auth/mfa/status');
  return r.data;
}

/**
 * Initiates MFA setup: generates a TOTP secret and returns the QR code.
 * MFA is NOT yet enabled — call confirmMFA with a valid code to activate.
 */
export async function setupMFA(): Promise<MFASetupResponse> {
  const r = await api.post<MFASetupResponse>('/api/v1/auth/mfa/setup');
  return r.data;
}

/**
 * Confirms MFA setup by verifying the first TOTP code from the authenticator.
 * On success, MFA is activated and the returned backup codes are shown once.
 */
export async function confirmMFA(code: string): Promise<BackupCodesResponse> {
  const r = await api.post<BackupCodesResponse>('/api/v1/auth/mfa/confirm', { code });
  return r.data;
}

/**
 * Disables MFA. Requires the current TOTP code or a backup code to prevent
 * accidental or unauthorised disablement.
 */
export async function disableMFA(code: string): Promise<void> {
  await api.delete('/api/v1/auth/mfa', { data: { code } });
}

/**
 * Regenerates all backup codes. Requires a live TOTP code for confirmation.
 * The old backup codes are immediately invalidated.
 */
export async function regenerateBackupCodes(code: string): Promise<BackupCodesResponse> {
  const r = await api.post<BackupCodesResponse>('/api/v1/auth/mfa/backup-codes', { code });
  return r.data;
}
