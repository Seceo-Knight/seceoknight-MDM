// Package auth holds primitives for issuing and verifying JWT tokens used by
// the admin web, internal service-to-service calls, and Android agents.
//
// Two token kinds exist:
//   - "user"   — issued to admin/operator humans signed into the dashboard.
//   - "device" — issued to enrolled devices; the subject is the device UUID.
//
// Access tokens are short-lived (15m default). Refresh tokens are long-lived,
// rotation-aware, and stored hashed in the database so they can be revoked.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type TokenKind string

const (
	KindUser   TokenKind = "user"
	KindDevice TokenKind = "device"
)

type Claims struct {
	Kind     TokenKind `json:"knd"`
	TenantID string    `json:"tid"`
	Role     string    `json:"rol,omitempty"` // user tokens only
	DeviceID string    `json:"did,omitempty"` // device tokens only
	SID      string    `json:"sid,omitempty"` // session id (refresh-chain head) — enables instant force-logout
	jwt.RegisteredClaims
}

type Issuer struct {
	secret []byte
	access time.Duration
}

func NewIssuer(secret string, accessTTL time.Duration) *Issuer {
	return &Issuer{secret: []byte(secret), access: accessTTL}
}

// IssueUser creates a short-lived access token for an admin/operator. sid is the
// session id (the current refresh-chain head); embedding it lets the auth
// middleware reject this token the instant its session is force-revoked. Pass ""
// for sessionless tokens.
func (i *Issuer) IssueUser(userID uuid.UUID, tenantID uuid.UUID, role, sid string) (string, error) {
	now := time.Now()
	c := Claims{
		Kind:     KindUser,
		TenantID: tenantID.String(),
		Role:     role,
		SID:      sid,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(i.access)),
			Issuer:    "mdm",
			ID:        uuid.NewString(),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(i.secret)
}

// IssueDevice creates a short-lived access token for an enrolled device.
func (i *Issuer) IssueDevice(deviceID uuid.UUID, tenantID uuid.UUID) (string, error) {
	now := time.Now()
	c := Claims{
		Kind:     KindDevice,
		TenantID: tenantID.String(),
		DeviceID: deviceID.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   deviceID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(i.access)),
			Issuer:    "mdm",
			ID:        uuid.NewString(),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(i.secret)
}

func (i *Issuer) Parse(tokenStr string) (*Claims, error) {
	c := &Claims{}
	t, err := jwt.ParseWithClaims(tokenStr, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return i.secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !t.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

// NewRefreshToken returns a high-entropy opaque refresh token plus its SHA-256
// hash. Store the hash; hand the plain token to the client. Refresh tokens are
// rotated: each /refresh exchange revokes the previous and issues a new pair.
func NewRefreshToken() (plain string, hash string, err error) {
	b := make([]byte, 48)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	plain = hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(plain))
	hash = hex.EncodeToString(sum[:])
	return plain, hash, nil
}

func HashRefresh(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
