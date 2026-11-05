-- 014_files_unlock_photo_kind.sql
-- Add 'unlock_photo' to the allowed file_objects.kind values. The ActivityMonitor's
-- capture_on_unlock surveillance flow uploads these distinctly from on-demand
-- CAPTURE_PHOTO so the admin UI can filter / badge them differently in the
-- Photos tab. Without this, the insert fails the CHECK constraint and the
-- whole upload returns HTTP 500, which surfaces in the Activity tab as
-- activity.unlock_photo.error rows reading "upload http 500".

ALTER TABLE file_objects DROP CONSTRAINT IF EXISTS file_objects_kind_check;

ALTER TABLE file_objects
    ADD CONSTRAINT file_objects_kind_check
    CHECK (kind = ANY (ARRAY['apk'::text, 'log'::text, 'generic'::text, 'config'::text, 'photo'::text, 'unlock_photo'::text]));
