package dto

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	MFACode  string `json:"mfa_code,omitempty"`
}

type LoginResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	User         struct {
		ID          string   `json:"id"`
		Email       string   `json:"email"`
		Role        string   `json:"role"`
		TenantID    string   `json:"tenant_id"`
		Permissions []string `json:"permissions"`
	} `json:"user"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type RefreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

type MeResponse struct {
	ID          string   `json:"id"`
	Email       string   `json:"email"`
	Role        string   `json:"role"`
	TenantID    string   `json:"tenant_id"`
	Permissions []string `json:"permissions,omitempty"`
}

type CreateUserRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

type UpdateRoleRequest struct {
	Role string `json:"role"`
}

// RolesResponse describes the full RBAC matrix for the admin UI's Roles page.
type RolesResponse struct {
	Roles       []string            `json:"roles"`
	Permissions []string            `json:"permissions"`        // all known permissions
	Matrix      map[string][]string `json:"matrix"`             // role → granted permissions
}

type ChangePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

type UpdateProfileRequest struct {
	Email *string `json:"email,omitempty"`
}

// SessionDTO is one active admin session for the Access Log page.
type SessionDTO struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Email      string `json:"email"`
	Role       string `json:"role"`
	IP         string `json:"ip"`
	UserAgent  string `json:"user_agent"`
	IssuedAt   string `json:"issued_at"`   // also "last active" (advances each refresh)
	ExpiresAt  string `json:"expires_at"`
}
