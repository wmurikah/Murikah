-- Virtual Internship Phase 10 forward correction.
-- 0016 populated retired_at for published template versions; published versions must not be retired.
PRAGMA foreign_keys = ON;

UPDATE scenario_template_versions
SET retired_at = NULL
WHERE status = 'published'
  AND retired_at IS NOT NULL;
