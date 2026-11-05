-- 010_files_device.sql
-- Allow device-authored uploads (camera captures, log bundles) tied to a
-- specific device. uploaded_by becomes nullable; uploaded_by_device captures
-- the device that produced the bytes when applicable.

ALTER TABLE file_objects DROP CONSTRAINT IF EXISTS file_objects_kind_check;
ALTER TABLE file_objects ADD CONSTRAINT file_objects_kind_check
  CHECK (kind IN ('apk','log','generic','config','photo'));

ALTER TABLE file_objects ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE file_objects ADD COLUMN IF NOT EXISTS uploaded_by_device UUID REFERENCES devices(id);
ALTER TABLE file_objects ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id);

CREATE INDEX IF NOT EXISTS idx_files_device ON file_objects(device_id) WHERE deleted_at IS NULL;
