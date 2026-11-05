-- 019_files_screen_kind.sql
-- Add 'screen' and 'screendiag' to the allowed file_objects.kind values. The live
-- screen-mirror feature stores session recordings with kind='screen' (uploaded by
-- the browser viewer via /files/upload) and a lifecycle breadcrumb with
-- kind='screendiag' (uploaded by the agent via /files/device-upload). The kind
-- CHECK constraint (last set in 018) didn't include them, so every screen upload
-- failed its DB insert with a check-constraint violation (HTTP 500) — the upload
-- worked, the row just couldn't be stored. Same fix pattern as 018 (audio),
-- 014 (unlock_photo), 010 (photo).

ALTER TABLE file_objects DROP CONSTRAINT IF EXISTS file_objects_kind_check;
ALTER TABLE file_objects ADD CONSTRAINT file_objects_kind_check
  CHECK (kind IN ('apk','log','generic','config','photo','unlock_photo','audio','screen','screendiag'));
