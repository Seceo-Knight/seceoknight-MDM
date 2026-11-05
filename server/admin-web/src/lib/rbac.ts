import { useAuth } from '../stores/authStore';

// Client-side mirror of shared/authz. The server is the authority — this only
// drives UI affordances (hiding/disabling controls the user can't use). The
// permission list comes from the server (login / GET /auth/me), so we never
// hardcode the role→permission matrix here; we only map command kinds to the
// permission they require, mirroring authz.CommandPermission.

export type Permission = string;

// can() — does the current user hold a permission (non-reactive read).
export function can(perm: Permission): boolean {
  const u = useAuth.getState().user;
  return !!u?.permissions?.includes(perm);
}

// useCan() — reactive hook for components.
export function useCan(perm: Permission): boolean {
  return useAuth(s => !!s.user?.permissions?.includes(perm));
}

const COMMAND_BASIC = new Set([
  'LOCK', 'PING', 'GET_LOCATION', 'PLAY_SOUND', 'SET_FLASHLIGHT',
  'FETCH_DEVICE_INFO', 'FETCH_APP_INVENTORY', 'FETCH_APP_USAGE', 'FETCH_RUNNING_PROCESSES',
  'COLLECT_LOGS', 'APPLY_POLICY', 'SYNC_POLICY', 'PUSH_TELEMETRY'
]);
const COMMAND_SURVEILLANCE = new Set(['CAPTURE_PHOTO', 'START_AUDIO_STREAM', 'STOP_AUDIO_STREAM', 'START_SCREEN_SHARE', 'STOP_SCREEN_SHARE', 'WAKE_DEVICE']);

// commandPermission mirrors authz.CommandPermission: anything not basic or
// surveillance is privileged (fail safe).
export function commandPermission(kind: string): Permission {
  if (COMMAND_BASIC.has(kind)) return 'command:issue:basic';
  if (COMMAND_SURVEILLANCE.has(kind)) return 'command:issue:surveillance';
  return 'command:issue:privileged';
}

// canIssue() — may the current user issue this command kind?
export function canIssue(kind: string): boolean {
  return can(commandPermission(kind));
}
export function useCanIssue(kind: string): boolean {
  return useCan(commandPermission(kind));
}

// --- role hierarchy (mirrors authz.RoleRank / CanManageRole) ---
const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2, super_admin: 3 };
export function roleRank(role?: string): number {
  return role && role in ROLE_RANK ? ROLE_RANK[role] : -1;
}
// Roles an actor may assign / create (at or below their own rank). No escalation.
export function assignableRoles(actorRole: string | undefined, all: string[]): string[] {
  const ar = roleRank(actorRole);
  return all.filter(r => roleRank(r) <= ar && roleRank(r) >= 0);
}
// Whether an actor may act on a user holding targetRole.
export function canManageTarget(actorRole: string | undefined, targetRole: string): boolean {
  return roleRank(targetRole) >= 0 && roleRank(actorRole) >= roleRank(targetRole);
}
