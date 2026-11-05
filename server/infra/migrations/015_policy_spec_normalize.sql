-- 015_policy_spec_normalize.sql
-- One-shot cleanup of policies whose spec has url_blocklist / blocklist at the
-- top level instead of nested under apps.*. The agent's PolicySpec decodes
-- with ignoreUnknownKeys=true, so those misplaced fields silently no-op'd —
-- making URL/app blocking look broken even though the policy "saved fine".
-- The admin Upsert handler now normalizes new writes; this migration retro-
-- actively fixes anything already stored.

UPDATE policies
   SET spec = jsonb_set(
                 jsonb_set(spec - 'url_blocklist', '{apps}', COALESCE(spec->'apps', '{}'::jsonb), true),
                 '{apps,url_blocklist}',
                 spec->'url_blocklist',
                 true)
 WHERE spec ? 'url_blocklist'
   AND jsonb_typeof(spec->'url_blocklist') = 'array'
   AND NOT COALESCE(spec->'apps' ? 'url_blocklist', false);

UPDATE policies
   SET spec = jsonb_set(
                 jsonb_set(spec - 'blocklist', '{apps}', COALESCE(spec->'apps', '{}'::jsonb), true),
                 '{apps,blocklist}',
                 spec->'blocklist',
                 true)
 WHERE spec ? 'blocklist'
   AND jsonb_typeof(spec->'blocklist') = 'array'
   AND NOT COALESCE(spec->'apps' ? 'blocklist', false);
