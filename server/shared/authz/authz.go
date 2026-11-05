// Package authz is the single source of truth for the platform's RBAC model:
// the set of permissions, the role→permission matrix, and the helpers every
// service uses to make authorization decisions. Keeping this in shared/ means
// all services (and, mirrored, the admin UI) agree on exactly who can do what.
//
// Design notes:
//   - Roles are fixed and well-defined (viewer < operator < admin < super_admin).
//     super_admin is a wildcard. The matrix is code-defined today; it is laid
//     out so a future DB-backed custom-role store can replace RoleGrants
//     without touching call sites.
//   - Authorization is permission-centric: handlers/middleware ask "can this
//     role do X permission", never "is this role == admin". Adding a route is
//     a matter of picking the right permission.
//   - Command issuance is risk-tiered: destructive (wipe/reset/clear) and
//     surveillance (camera/mic) commands require strictly more than the basic
//     help-desk operations (lock/locate/ring/inventory).
//   - Fail closed: unknown role → no permissions; unknown command kind →
//     treated as privileged.
package authz

import "sort"

type Permission string

const (
	// Devices
	PermDeviceRead   Permission = "device:read"
	PermDeviceUpdate Permission = "device:update" // alias, group membership
	PermDeviceRetire Permission = "device:retire"
	PermEnrollCreate Permission = "enroll:create" // mint enrollment tokens

	// Groups
	PermGroupRead   Permission = "group:read"
	PermGroupManage Permission = "group:manage"

	// Policies
	PermPolicyRead   Permission = "policy:read"
	PermPolicyWrite  Permission = "policy:write"
	PermPolicyAssign Permission = "policy:assign"

	// Commands (read + risk-tiered issuance)
	PermCommandRead         Permission = "command:read"
	PermCommandBasic        Permission = "command:issue:basic"        // lock, locate, ring, inventory, ping
	PermCommandPrivileged   Permission = "command:issue:privileged"   // wipe, reset pw, install, restrictions, certs…
	PermCommandSurveillance Permission = "command:issue:surveillance" // camera photo, mic audio stream

	// Files
	PermFileRead   Permission = "file:read"
	PermFileWrite  Permission = "file:write"
	PermFileDelete Permission = "file:delete"

	// Audit / telemetry
	PermAuditRead     Permission = "audit:read"
	PermAuditWrite    Permission = "audit:write"
	PermTelemetryRead Permission = "telemetry:read"

	// Users / roles
	PermUserRead   Permission = "user:read"
	PermUserManage Permission = "user:manage" // create users, change roles, deactivate
	PermRoleRead   Permission = "role:read"   // view the permission matrix

	// Platform (global, cross-tenant) settings — e.g. the debug-unlock password.
	PermPlatformManage Permission = "platform:manage"
)

// Role strings — mirror models.Role (kept as plain strings here so the authz
// package has no dependency on models and can be imported anywhere).
const (
	RoleSuperAdmin = "super_admin"
	RoleAdmin      = "admin"
	RoleOperator   = "operator"
	RoleViewer     = "viewer"
)

// allPermissions is the canonical ordered list (used for super_admin and for
// the matrix the UI renders).
var allPermissions = []Permission{
	PermDeviceRead, PermDeviceUpdate, PermDeviceRetire, PermEnrollCreate,
	PermGroupRead, PermGroupManage,
	PermPolicyRead, PermPolicyWrite, PermPolicyAssign,
	PermCommandRead, PermCommandBasic, PermCommandPrivileged, PermCommandSurveillance,
	PermFileRead, PermFileWrite, PermFileDelete,
	PermAuditRead, PermAuditWrite, PermTelemetryRead,
	PermUserRead, PermUserManage, PermRoleRead,
	PermPlatformManage,
}

// Read-only baseline shared by every role at or above viewer.
var readerPerms = []Permission{
	PermDeviceRead, PermGroupRead, PermPolicyRead, PermCommandRead,
	PermFileRead, PermAuditRead, PermTelemetryRead,
}

// RoleGrants maps a role to the permissions it holds. super_admin is handled by
// the wildcard in Can() and intentionally omitted here.
var RoleGrants = map[string]map[Permission]bool{
	RoleViewer:   set(readerPerms...),
	RoleOperator: set(append(clone(readerPerms), PermCommandBasic)...),
	RoleAdmin: set(append(clone(readerPerms),
		PermCommandBasic,
		PermDeviceUpdate, PermDeviceRetire, PermEnrollCreate,
		PermGroupManage,
		PermPolicyWrite, PermPolicyAssign,
		PermCommandPrivileged, PermCommandSurveillance,
		PermFileWrite, PermFileDelete,
		PermAuditWrite,
		PermUserRead, PermRoleRead,
		// admins manage users too — but only at or below their own rank
		// (no escalation to super_admin). Enforced via CanManageRole.
		PermUserManage,
		// admins may set the global debug-unlock password.
		PermPlatformManage,
	)...),
}

// RoleRank is a privilege ordinal (higher = more privileged) used for hierarchy
// checks. Unknown roles rank -1.
func RoleRank(role string) int {
	switch role {
	case RoleViewer:
		return 0
	case RoleOperator:
		return 1
	case RoleAdmin:
		return 2
	case RoleSuperAdmin:
		return 3
	}
	return -1
}

// CanManageRole enforces no-upward-escalation: an actor may only create, assign,
// modify, or deactivate users whose role is at or below the actor's own. So a
// super_admin manages everyone (incl. other super_admins); an admin manages
// viewer/operator/admin but can neither mint a super_admin nor touch one.
func CanManageRole(actorRole, targetRole string) bool {
	tr := RoleRank(targetRole)
	return tr >= 0 && RoleRank(actorRole) >= tr
}

// Can reports whether a role may exercise a permission. super_admin can do
// everything; any unknown role gets nothing (fail closed).
func Can(role string, perm Permission) bool {
	if role == RoleSuperAdmin {
		return true
	}
	grants, ok := RoleGrants[role]
	if !ok {
		return false
	}
	return grants[perm]
}

// PermissionsFor returns the sorted permission list a role holds (super_admin →
// all). Used by the API to tell the UI what to enable.
func PermissionsFor(role string) []Permission {
	var out []Permission
	if role == RoleSuperAdmin {
		out = clone(allPermissions)
	} else {
		for p := range RoleGrants[role] {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// AllPermissions returns every defined permission (ordered).
func AllPermissions() []Permission { return clone(allPermissions) }

// Roles returns the fixed role names, lowest→highest privilege.
func Roles() []string { return []string{RoleViewer, RoleOperator, RoleAdmin, RoleSuperAdmin} }

// ValidRole reports whether s is a known role.
func ValidRole(s string) bool {
	switch s {
	case RoleSuperAdmin, RoleAdmin, RoleOperator, RoleViewer:
		return true
	}
	return false
}

// commandTier maps a command kind (server wire string, see
// command-service/internal/types) to the permission required to issue it.
// Anything not listed is treated as privileged (fail safe).
var commandTier = map[string]Permission{
	// basic / help-desk
	"LOCK": PermCommandBasic, "PING": PermCommandBasic, "GET_LOCATION": PermCommandBasic,
	"PLAY_SOUND": PermCommandBasic, "SET_FLASHLIGHT": PermCommandBasic, "SHOW_MESSAGE": PermCommandBasic,
	"FETCH_DEVICE_INFO": PermCommandBasic, "FETCH_APP_INVENTORY": PermCommandBasic,
	"FETCH_APP_USAGE": PermCommandBasic,
	"FETCH_RUNNING_PROCESSES": PermCommandBasic, "COLLECT_LOGS": PermCommandBasic,
	"APPLY_POLICY": PermCommandBasic, "SYNC_POLICY": PermCommandBasic,
	// surveillance
	"CAPTURE_PHOTO": PermCommandSurveillance, "START_AUDIO_STREAM": PermCommandSurveillance,
	"STOP_AUDIO_STREAM": PermCommandSurveillance,
	"START_SCREEN_SHARE": PermCommandSurveillance, "STOP_SCREEN_SHARE": PermCommandSurveillance,
	// waking the screen only exists to revive the mirror — same tier as it
	"WAKE_DEVICE": PermCommandSurveillance,
	// privileged / destructive / config
	"WIPE": PermCommandPrivileged, "REBOOT": PermCommandPrivileged,
	"RESET_PASSWORD": PermCommandPrivileged, "CLEAR_PASSWORD": PermCommandPrivileged,
	"CLEAR_POLICY": PermCommandPrivileged, "CLEAR_APP_DATA": PermCommandPrivileged,
	"INSTALL_APP": PermCommandPrivileged, "UNINSTALL_APP": PermCommandPrivileged,
	"HIDE_APP": PermCommandPrivileged, "SHOW_APP": PermCommandPrivileged,
	"BLOCK_UNINSTALL": PermCommandPrivileged, "ALLOW_UNINSTALL": PermCommandPrivileged,
	"INSTALL_CERTIFICATE": PermCommandPrivileged, "REMOVE_CERTIFICATE": PermCommandPrivileged,
	"INSTALL_CERT": PermCommandPrivileged, "REMOVE_CERT": PermCommandPrivileged,
	"SET_VPN": PermCommandPrivileged, "SET_PROXY": PermCommandPrivileged,
	"SET_GLOBAL_PROXY": PermCommandPrivileged, "SET_WIFI": PermCommandPrivileged,
	"SET_RESTRICTION": PermCommandPrivileged, "SET_PASSWORD_POLICY": PermCommandPrivileged,
	"SET_SYSTEM_UPDATE": PermCommandPrivileged, "LOG_OFF_USER": PermCommandPrivileged,
	"RUN_INTEGRITY_CHECK": PermCommandPrivileged, "PUSH_FILE": PermCommandPrivileged,
	"PULL_FILE": PermCommandPrivileged, "PUSH_TELEMETRY": PermCommandBasic,
	"REMOVE_WORK_PROFILE": PermCommandPrivileged,
}

// CommandPermission returns the permission required to issue a command kind.
func CommandPermission(kind string) Permission {
	if p, ok := commandTier[kind]; ok {
		return p
	}
	return PermCommandPrivileged
}

// --- small helpers ---

func set(perms ...Permission) map[Permission]bool {
	m := make(map[Permission]bool, len(perms))
	for _, p := range perms {
		m[p] = true
	}
	return m
}

func clone(in []Permission) []Permission {
	out := make([]Permission, len(in))
	copy(out, in)
	return out
}
