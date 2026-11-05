// Package sender delivers alert notifications via SMTP email or HTTP webhook.
package sender

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/mdm/alert-service/internal/store"
)

// AlertPayload is the structured event passed to every delivery channel.
type AlertPayload struct {
	EventType string         `json:"event_type"`
	Subject   string         `json:"subject"`
	TenantID  string         `json:"tenant_id"`
	Data      map[string]any `json:"data"`
	Timestamp time.Time      `json:"timestamp"`
}

// DeliverAll fans an alert out to every channel in the list and records results.
func DeliverAll(ctx context.Context, s *store.Store, channels []store.Channel, p AlertPayload) {
	raw, _ := json.Marshal(p)
	for _, ch := range channels {
		var status, errStr string
		var err error
		switch ch.Kind {
		case "email":
			err = sendEmail(ch, p)
		case "webhook":
			err = sendWebhook(ctx, ch, raw)
		default:
			err = fmt.Errorf("unknown channel kind: %s", ch.Kind)
		}
		if err != nil {
			status = "failed"
			errStr = err.Error()
			log.Warn().Err(err).Str("channel", ch.Name).Str("kind", ch.Kind).Msg("alert delivery failed")
		} else {
			status = "sent"
			log.Info().Str("channel", ch.Name).Str("kind", ch.Kind).Str("event", p.EventType).Msg("alert delivered")
		}
		chID := ch.ID
		entry := &store.LogEntry{
			ChannelID: &chID,
			TenantID:  ch.TenantID,
			EventType: p.EventType,
			Subject:   p.Subject,
			Payload:   raw,
			Status:    status,
			Error:     errStr,
		}
		if logErr := s.InsertLog(ctx, entry); logErr != nil {
			log.Error().Err(logErr).Msg("alert: failed to write log")
		}
	}
}

// ─── Email ────────────────────────────────────────────────────────────────────

func sendEmail(ch store.Channel, p AlertPayload) error {
	if len(ch.SMTPTo) == 0 {
		return fmt.Errorf("no recipients configured")
	}

	body := buildEmailBody(ch, p)
	addr := fmt.Sprintf("%s:%d", ch.SMTPHost, ch.SMTPPort)

	var auth smtp.Auth
	if ch.SMTPUser != "" {
		auth = smtp.PlainAuth("", ch.SMTPUser, ch.SMTPPass, ch.SMTPHost)
	}

	if ch.SMTPTLS {
		return sendTLS(addr, auth, ch.SMTPFrom, ch.SMTPTo, body, ch.SMTPHost)
	}
	return smtp.SendMail(addr, auth, ch.SMTPFrom, ch.SMTPTo, body)
}

func buildEmailBody(ch store.Channel, p AlertPayload) []byte {
	dataLines := new(strings.Builder)
	for k, v := range p.Data {
		dataLines.WriteString(fmt.Sprintf("  %s: %v\r\n", k, v))
	}
	msg := fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: [SeceoKnight MDM] %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"+
			"SeceoKnight MDM Alert\r\n"+"═══════════════════\r\n\r\n"+
			"Event:   %s\r\n"+
			"Time:    %s\r\n\r\n"+
			"Details:\r\n%s\r\n"+
			"──────────────────────────────\r\n"+
			"This alert was sent automatically by the SeceoKnight MDM Compliance Engine.\r\n",
		ch.SMTPFrom,
		strings.Join(ch.SMTPTo, ", "),
		p.Subject,
		p.EventType,
		p.Timestamp.UTC().Format(time.RFC1123),
		dataLines.String(),
	)
	return []byte(msg)
}

func sendTLS(addr string, auth smtp.Auth, from string, to []string, body []byte, host string) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err != nil {
		// Fall back to STARTTLS via net.Dial
		netConn, err2 := net.Dial("tcp", addr)
		if err2 != nil {
			return err2
		}
		c, err2 := smtp.NewClient(netConn, host)
		if err2 != nil {
			return err2
		}
		defer c.Close()
		if err2 = c.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err2 != nil {
			return err2
		}
		if auth != nil {
			if err2 = c.Auth(auth); err2 != nil {
				return err2
			}
		}
		return sendViaSMTPClient(c, from, to, body)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer c.Close()
	if auth != nil {
		if err = c.Auth(auth); err != nil {
			return err
		}
	}
	return sendViaSMTPClient(c, from, to, body)
}

func sendViaSMTPClient(c *smtp.Client, from string, to []string, body []byte) error {
	if err := c.Mail(from); err != nil {
		return err
	}
	for _, r := range to {
		if err := c.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err = w.Write(body); err != nil {
		return err
	}
	return w.Close()
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

func sendWebhook(ctx context.Context, ch store.Channel, body []byte) error {
	if ch.WebhookURL == "" {
		return fmt.Errorf("webhook URL not configured")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ch.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "SeceoKnight-MDM-AlertService/1.0")

	// Optional HMAC-SHA256 signature so receivers can verify authenticity.
	if ch.WebhookSecret != "" {
		mac := hmac.New(sha256.New, []byte(ch.WebhookSecret))
		mac.Write(body)
		req.Header.Set("X-SeceoKnight-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned HTTP %d", resp.StatusCode)
	}
	return nil
}
