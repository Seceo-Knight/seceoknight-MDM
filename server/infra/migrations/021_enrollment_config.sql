-- 021_enrollment_config.sql
-- Per-tenant Android Device-Owner QR provisioning config, editable by
-- admin / super_admin in the admin console (Enrollment page). Drives the QR
-- payload returned by GET /api/v1/enroll/qr/:tokenID:
--   * apk_download_url      → PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION
--   * apk_signature_checksum→ PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM
--   * dpc_component_name    → PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME
--   * wifi_*                → PROVISIONING_WIFI_* (so a factory-reset device with
--                              no network can join WiFi during setup, *before*
--                              it downloads the agent APK).
-- One row per tenant; absent row ⇒ service falls back to built-in defaults.

CREATE TABLE IF NOT EXISTS enrollment_config (
  tenant_id              UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  apk_download_url       TEXT    NOT NULL DEFAULT '',
  apk_signature_checksum TEXT    NOT NULL DEFAULT '',
  dpc_package_name       TEXT    NOT NULL DEFAULT 'com.mdm.agent',
  dpc_component_name     TEXT    NOT NULL DEFAULT 'com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver',
  wifi_ssid              TEXT    NOT NULL DEFAULT '',
  wifi_password          TEXT    NOT NULL DEFAULT '',
  wifi_security_type     TEXT    NOT NULL DEFAULT 'WPA',   -- NONE | WPA | WEP | EAP
  wifi_hidden            BOOLEAN NOT NULL DEFAULT FALSE,
  skip_encryption        BOOLEAN NOT NULL DEFAULT FALSE,
  leave_system_apps      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             UUID
);
