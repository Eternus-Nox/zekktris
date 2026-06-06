-- Attachment compression watermark
-- --------------------------------
-- Tracks which attachments have been re-encoded by the periodic
-- compression sweep so the sweep can skip them on subsequent runs.
--
-- The sweep walks attachments older than COMPRESS_AFTER_DAYS that
-- have compressed_at IS NULL and an image content_type, re-encodes
-- them at a lower quality target (typically saves 30-50% on JPEGs
-- and WebPs), and stamps this column with the time it succeeded.
-- Rows where compression isn't applicable (GIFs that might be
-- animated, non-image types, files smaller than COMPRESS_MIN_BYTES)
-- are also marked compressed_at=now() so they don't get re-evaluated
-- forever — the column doubles as a "this row has been processed,
-- regardless of whether the file actually changed" marker.
--
-- Nullable; NULL means "not yet processed by the sweep", which is the
-- correct default state for every existing attachment. Add WITHOUT
-- a default so the ALTER TABLE doesn't rewrite every row.
ALTER TABLE attachments ADD COLUMN compressed_at TIMESTAMPTZ;

-- Partial index on the eligibility set: image attachments that haven't
-- been processed yet. The sweep query joins this with a created_at
-- cutoff; the partial index keeps the candidate set small even as the
-- compressed pile grows.
CREATE INDEX attachments_pending_compression_idx
  ON attachments (created_at)
  WHERE compressed_at IS NULL;
