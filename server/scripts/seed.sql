-- Optional sample seed: a default policy and a device group.
INSERT INTO device_groups (id, tenant_id, name, description) VALUES
  ('00000000-0000-0000-0000-000000000020'::uuid,
   '00000000-0000-0000-0000-000000000001'::uuid,
   'corporate-laptops-replacement-android',
   'Default group for newly enrolled devices')
ON CONFLICT (tenant_id, name) DO NOTHING;

-- A baseline policy that disables camera + USB transfer + screen capture.
INSERT INTO policies (id, tenant_id, name, version, spec, created_by) VALUES
  ('00000000-0000-0000-0000-000000000030'::uuid,
   '00000000-0000-0000-0000-000000000001'::uuid,
   'baseline-security',
   1,
   '{
      "version": 1,
      "restrictions": {
        "disable_camera": true,
        "disable_screen_capture": true,
        "disable_usb_file_transfer": true,
        "disable_factory_reset": true
      },
      "password": {
        "complexity": "high",
        "min_length": 8,
        "max_failed_attempts": 10,
        "inactivity_lock_sec": 300
      },
      "compliance": {
        "reject_rooted": true,
        "require_encryption": true
      }
    }'::jsonb,
   '00000000-0000-0000-0000-000000000010'::uuid)
ON CONFLICT DO NOTHING;

-- Assign as tenant-default.
INSERT INTO policy_assignments (tenant_id, policy_id, target_kind, target_id) VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000030'::uuid,
   'tenant', NULL)
ON CONFLICT DO NOTHING;
