-- ---------------------------------------------------------------------------
-- CMS Build Prompt 19: Upload Centre grants.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- NO NEW PERMISSION IS NEEDED. All four codes the Upload Centre checks are
-- already in the seeded catalogue:
--
--   PERM-018  DATA.IMPORTS.VIEW             read import history and exceptions
--   PERM-019  DATA.IMPORTS.UPLOAD           run an import at all
--   PERM-009  ORDERS.SALES_ORDER.UPLOAD     load a sales order extract
--   PERM-011  ORDERS.PURCHASE_ORDER.UPLOAD  load a purchase order extract
--
-- What is missing is a grant. The seed gives all four to ROLE-ADMIN through
-- its grant-everything insert and to nobody else, so today only a system
-- administrator can run the monthly upload, which is not who does it.
--
-- An upload is authorised by TWO codes: DATA.IMPORTS.UPLOAD says a person may
-- use the Upload Centre, and the type's own code says what they may put
-- through it. A finance manager who loads sales and purchase extracts holds
-- three; a person who should only ever load purchase orders holds two, and
-- the sales order door stays shut for them. Nothing anywhere reads a job
-- title.
--
-- ROLE-FIN is the affiliate finance manager and ROLE-GRP-FIN the group
-- finance role; both already hold DATA.IMPORTS.VIEW (PERM-018) and both
-- already read the orders they would be loading.
--
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-FIN-010','ROLE-FIN','PERM-019',1,CURRENT_TIMESTAMP),
('RP-FIN-011','ROLE-FIN','PERM-009',1,CURRENT_TIMESTAMP),
('RP-FIN-012','ROLE-FIN','PERM-011',1,CURRENT_TIMESTAMP),
('RP-GF-010','ROLE-GRP-FIN','PERM-019',1,CURRENT_TIMESTAMP),
('RP-GF-011','ROLE-GRP-FIN','PERM-009',1,CURRENT_TIMESTAMP),
('RP-GF-012','ROLE-GRP-FIN','PERM-011',1,CURRENT_TIMESTAMP);

-- Verification. Expect two roles, each holding three codes, beside ROLE-ADMIN.
-- SELECT rp.role_id, p.module_name || '.' || p.resource_name || '.' || p.action_name AS code
-- FROM role_permissions rp
-- JOIN permissions p ON p.permission_id = rp.permission_id
-- WHERE p.permission_id IN ('PERM-009','PERM-011','PERM-019') AND rp.allowed = 1
-- ORDER BY rp.role_id, code;
