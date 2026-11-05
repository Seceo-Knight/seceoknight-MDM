-- 009_seed.sql
-- Seeds the default tenant. The super-admin USER is no longer seeded here:
-- its email + password are NOT hardcoded anymore — they come from the
-- SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD env vars and are inserted (with a
-- freshly-computed bcrypt hash) by 010_seed_superadmin.sh, which runs right
-- after this file. See server/.env(.example) and docker-compose.yml.

INSERT INTO tenants (id, slug, name) VALUES
    ('00000000-0000-0000-0000-000000000001'::uuid, 'default', 'Default Tenant')
ON CONFLICT (slug) DO NOTHING;
