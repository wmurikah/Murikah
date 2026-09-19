ALTER TABLE persistence_objects
ADD COLUMN mtime_ms INTEGER NOT NULL DEFAULT 0 CHECK (mtime_ms >= 0);
