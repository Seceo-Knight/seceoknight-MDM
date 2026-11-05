-- 013_policy_multi_assign.sql
-- Allow N policies bound to the same target (device/group/tenant) so admins
-- can layer policies (e.g. "block YouTube" + "capture on unlock" instead of
-- having to merge them into one big spec). Server-side merging composes the
-- effective spec at /policies/assigned read time.
--
-- The unique constraint on (tenant_id, policy_id, target_kind, target_id)
-- guarantees we never end up with two rows pinning the same policy to the
-- same target — re-assigning the same policy is a no-op.

-- Drop any duplicate rows that snuck in before the constraint existed.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY tenant_id, policy_id, target_kind, COALESCE(target_id::text, '_null_')
             ORDER BY created_at DESC, id
           ) AS rn
      FROM policy_assignments
)
DELETE FROM policy_assignments WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS u_policy_assign_unique
    ON policy_assignments (
        tenant_id, policy_id, target_kind, COALESCE(target_id, '00000000-0000-0000-0000-000000000000')
    );
