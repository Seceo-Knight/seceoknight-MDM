package service

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mdm/shared/auth"
)

func TestIssuerRoundtrip(t *testing.T) {
	iss := auth.NewIssuer("00000000000000000000000000000000", 5*time.Minute)
	uid := uuid.New()
	tid := uuid.New()
	sid := uuid.NewString()
	tok, err := iss.IssueUser(uid, tid, "admin", sid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := iss.Parse(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.Subject != uid.String() {
		t.Fatalf("subject mismatch: got %s want %s", claims.Subject, uid)
	}
	if claims.TenantID != tid.String() {
		t.Fatalf("tenant mismatch: got %s want %s", claims.TenantID, tid)
	}
	if claims.Role != "admin" {
		t.Fatalf("role mismatch: %s", claims.Role)
	}
	if claims.SID != sid {
		t.Fatalf("sid mismatch: got %s want %s", claims.SID, sid)
	}
}

func TestRefreshTokenIsHighEntropy(t *testing.T) {
	plain, hash, err := auth.NewRefreshToken()
	if err != nil {
		t.Fatalf("new refresh: %v", err)
	}
	if len(plain) < 80 {
		t.Fatalf("refresh too short: %d", len(plain))
	}
	if auth.HashRefresh(plain) != hash {
		t.Fatalf("hash mismatch")
	}
}
