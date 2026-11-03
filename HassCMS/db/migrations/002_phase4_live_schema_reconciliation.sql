-- RETIRED: incompatible with the reviewed CMS authentication schema.
-- Original DDL is retained in Git history and historical negative test fixtures.
-- Do not use this file for bootstrap or repair. No schema/data changes follow.
-- See docs/cms/AUTH_MIGRATION_ROLLOUT.md and the preview-first replacement:
-- db/migrations/006_reviewed_auth_reconciliation.ts
SELECT 'BLOCKED_RETIRED_MIGRATION' AS status,
       'Use the reviewed authentication rollout; no changes were made.' AS action;
