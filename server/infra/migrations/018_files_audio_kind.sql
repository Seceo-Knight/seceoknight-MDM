-- 018_files_audio_kind.sql
-- Add 'audio' to the allowed file_objects.kind values. The live-audio feature
-- uploads mic segments with kind='audio' (via /files/device-upload); the kind
-- CHECK constraint (last set in 014) didn't include it, so every audio segment
-- failed its DB insert with a check-constraint violation (HTTP 500) — the
-- recording worked, the row just couldn't be stored. Mirrors how 010 added
-- 'photo' and 014 added 'unlock_photo'.

ALTER TABLE file_objects DROP CONSTRAINT IF EXISTS file_objects_kind_check;
ALTER TABLE file_objects ADD CONSTRAINT file_objects_kind_check
  CHECK (kind IN ('apk','log','generic','config','photo','unlock_photo','audio'));
