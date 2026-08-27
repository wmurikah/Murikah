/**
 * The operator's own seed rows, copied VERBATIM from
 * hass_cms_turso_v1_FINAL.sql.
 *
 * Build Prompts 06 to 09 are asserted against named people and configured
 * thresholds: Gabriel Musembi approving Kenya, Grace Atieno approving Uganda,
 * Hassan Ali at Group, a rule capping at fifty million. A hand-written fixture
 * that paraphrased those would prove the paraphrase. These are the rows
 * themselves, in foreign-key-safe order, so a test that says "the Uganda order
 * resolves to Grace Atieno" is a statement about the configuration the operator
 * will actually run against.
 *
 * The authentication rows are deliberately not here. The seed ships unusable,
 * expired credentials, and a test that needs to sign somebody in creates a real
 * one; see the per-phase fixtures.
 *
 * Nothing here points at hass-cms. It builds an in-memory database from
 * ./schema.ts, which is the same DDL.
 */
import type { TestClient } from './db.ts';

/** The ids the tests name, so a rename in the seed is a compile error here. */
export const SEED = {
  kenya: 'CTR-KE',
  uganda: 'CTR-UG',
  tanzania: 'CTR-TZ',
  affKenya: 'AFF-KE',
  affUganda: 'AFF-UG',
  affTanzania: 'AFF-TZ',
  retail: 'BU-RET',
  commercial: 'BU-CI',
  aviation: 'BU-AV',
  finance: 'DEP-FIN',
  titleFinanceManager: 'JT-FM',
  titleCountryManager: 'JT-CM',
  titleGroupCfo: 'JT-GCFO',
  admin: 'USR-CATH',
  gabriel: 'USR-GAB',
  zuleika: 'USR-ZUL',
  victor: 'USR-VIC',
  amina: 'USR-AMN',
  james: 'USR-JAM',
  grace: 'USR-FMUG',
  neema: 'USR-FMTZ',
  daniel: 'USR-CMUG',
  hassan: 'USR-GCFO',
  external: ['USR-EXT001', 'USR-EXT002', 'USR-EXT003', 'USR-EXT004', 'USR-EXT005'],
  roleAdmin: 'ROLE-ADMIN',
  rolePortal: 'ROLE-PORTAL',
  roleFinance: 'ROLE-FIN',
  permUsersManage: 'PERM-016',
  permRolesManage: 'PERM-015',
  permWorkflowsManage: 'PERM-017',
  permWorkflowRolesManage: 'PERM-021',
  permProductCatalogManage: 'PERM-028',
} as const;

const SEED_SQL = `
INSERT OR IGNORE INTO countries VALUES
('CTR-KE','KE','Kenya','Africa/Nairobi','KES',1,CURRENT_TIMESTAMP),
('CTR-UG','UG','Uganda','Africa/Kampala','UGX',1,CURRENT_TIMESTAMP),
('CTR-TZ','TZ','Tanzania','Africa/Dar_es_Salaam','TZS',1,CURRENT_TIMESTAMP),
('CTR-RW','RW','Rwanda','Africa/Kigali','RWF',1,CURRENT_TIMESTAMP),
('CTR-ZM','ZM','Zambia','Africa/Lusaka','ZMW',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO affiliates VALUES
('AFF-KE','HPK','Hass Petroleum Kenya','CTR-KE',1,CURRENT_TIMESTAMP),
('AFF-UG','HPU','Hass Petroleum Uganda','CTR-UG',1,CURRENT_TIMESTAMP),
('AFF-TZ','HPT','Hass Petroleum Tanzania','CTR-TZ',1,CURRENT_TIMESTAMP),
('AFF-RW','HPR','Hass Petroleum Rwanda','CTR-RW',1,CURRENT_TIMESTAMP),
('AFF-ZM','HPZ','Hass Petroleum Zambia','CTR-ZM',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO business_units VALUES
('BU-RET','RETAIL','Retail','Retail station and forecourt business',1,CURRENT_TIMESTAMP),
('BU-CI','C&I','Commercial & Industrial','Commercial, industrial and bulk customer business',1,CURRENT_TIMESTAMP),
('BU-AV','AVIATION','Aviation','Aviation fuels business',1,CURRENT_TIMESTAMP),
('BU-LPG','LPG','LPG','Liquefied petroleum gas business',1,CURRENT_TIMESTAMP),
('BU-LUB','LUBRICANTS','Lubricants','Lubricants business',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO departments VALUES
('DEP-CS','Customer Service','Customer experience, helpdesk and relationship management',1,CURRENT_TIMESTAMP),
('DEP-FIN','Finance','Financial control, finance approvals and reporting',1,CURRENT_TIMESTAMP),
('DEP-CRD','Credit','Credit limits, credit days and exception approvals',1,CURRENT_TIMESTAMP),
('DEP-SAL','Sales & Business Development','Lead generation and commercial conversion',1,CURRENT_TIMESTAMP),
('DEP-OPS','Operations','Depots, loading, stock and fulfilment operations',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO job_titles VALUES
('JT-CSM','Customer Service Manager','DEP-CS','Leads customer service and SLA monitoring',1,CURRENT_TIMESTAMP),
('JT-FM','Finance Manager','DEP-FIN','Entity or country finance approval and financial oversight',1,CURRENT_TIMESTAMP),
('JT-CM','Country Manager','DEP-OPS','Country executive and final operational approvals',1,CURRENT_TIMESTAMP),
('JT-CRM','Credit Manager','DEP-CRD','Credit risk and exception approvals; may be entity or Group scoped',1,CURRENT_TIMESTAMP),
('JT-SE','Sales Executive','DEP-SAL','Lead and opportunity owner',1,CURRENT_TIMESTAMP),
('JT-GCFO','Group CFO','DEP-FIN','Group-wide finance authority and escalation approvals',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO teams
(team_id,team_name,team_type,affiliate_id,business_unit_id,manager_user_id,active,created_at) VALUES
('TEAM-CS-KE','Kenya Customer Service','CUSTOMER_SERVICE','AFF-KE',NULL,NULL,1,CURRENT_TIMESTAMP),
('TEAM-FIN-KE','Kenya Finance','FINANCE','AFF-KE',NULL,NULL,1,CURRENT_TIMESTAMP),
('TEAM-CRD-GRP','Group Credit','CREDIT',NULL,NULL,NULL,1,CURRENT_TIMESTAMP),
('TEAM-SALES-KE','Kenya Sales','SALES','AFF-KE','BU-CI',NULL,1,CURRENT_TIMESTAMP),
('TEAM-OPS-KE','Kenya Operations','OPERATIONS','AFF-KE','BU-RET',NULL,1,CURRENT_TIMESTAMP),
('TEAM-FIN-UG','Uganda Finance','FINANCE','AFF-UG',NULL,NULL,1,CURRENT_TIMESTAMP),
('TEAM-FIN-TZ','Tanzania Finance','FINANCE','AFF-TZ',NULL,NULL,1,CURRENT_TIMESTAMP),
('TEAM-OPS-UG','Uganda Operations','OPERATIONS','AFF-UG','BU-RET',NULL,1,CURRENT_TIMESTAMP),
('TEAM-FIN-GRP','Group Finance','FINANCE',NULL,NULL,NULL,1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO users
(user_id,user_type,employee_no,first_name,last_name,display_name,email,phone,status,email_verified_at,timezone,locale,last_login_at,created_at,updated_at) VALUES
('USR-CATH','INTERNAL','EMP-1001','Catherine','Mwangi','Catherine Mwangi','catherine.mwangi@hasspetroleum.com','+254700000101','ACTIVE','2026-01-05 08:00:00','Africa/Nairobi','en-KE','2026-08-26 07:40:00','2026-01-05 08:00:00','2026-08-26 07:40:00'),
('USR-GAB','INTERNAL','EMP-1002','Gabriel','Musembi','Gabriel Musembi','gabriel.musembi@hasspetroleum.com','+254700000102','ACTIVE','2026-01-06 08:00:00','Africa/Nairobi','en-KE','2026-08-26 08:05:00','2026-01-06 08:00:00','2026-08-26 08:05:00'),
('USR-ZUL','INTERNAL','EMP-1003','Zuleika','Omar','Zuleika Omar','zuleika.omar@hasspetroleum.com','+254700000103','ACTIVE','2026-01-07 08:00:00','Africa/Nairobi','en-KE','2026-08-26 08:11:00','2026-01-07 08:00:00','2026-08-26 08:11:00'),
('USR-VIC','INTERNAL','EMP-1004','Victor','Njoroge','Victor Njoroge','victor.njoroge@hasspetroleum.com','+254700000104','ACTIVE','2026-01-08 08:00:00','Africa/Nairobi','en-KE','2026-08-26 08:19:00','2026-01-08 08:00:00','2026-08-26 08:19:00'),
('USR-AMN','INTERNAL','EMP-1005','Amina','Yusuf','Amina Yusuf','amina.yusuf@hasspetroleum.com','+254700000105','ACTIVE','2026-01-09 08:00:00','Africa/Nairobi','en-KE','2026-08-26 08:30:00','2026-01-09 08:00:00','2026-08-26 08:30:00'),
('USR-JAM','INTERNAL','EMP-1006','James','Maina','James Maina','james.maina@hasspetroleum.com','+254700000106','ACTIVE','2026-01-10 08:00:00','Africa/Nairobi','en-KE','2026-08-26 09:00:00','2026-01-10 08:00:00','2026-08-26 09:00:00'),
('USR-FMUG','INTERNAL','EMP-1101','Grace','Atieno','Grace Atieno','grace.atieno.demo@hasspetroleum.com','+256700000201','ACTIVE','2026-01-11 08:00:00','Africa/Kampala','en-UG',NULL,'2026-01-11 08:00:00','2026-01-11 08:00:00'),
('USR-FMTZ','INTERNAL','EMP-1201','Neema','Hassan','Neema Hassan','neema.hassan.demo@hasspetroleum.com','+255700000202','ACTIVE','2026-01-12 08:00:00','Africa/Dar_es_Salaam','en-TZ',NULL,'2026-01-12 08:00:00','2026-01-12 08:00:00'),
('USR-CMUG','INTERNAL','EMP-1102','Daniel','Okello','Daniel Okello','daniel.okello.demo@hasspetroleum.com','+256700000203','ACTIVE','2026-01-13 08:00:00','Africa/Kampala','en-UG',NULL,'2026-01-13 08:00:00','2026-01-13 08:00:00'),
('USR-GCFO','INTERNAL','EMP-9001','Hassan','Ali','Hassan Ali','group.cfo.demo@hasspetroleum.com','+254700000900','ACTIVE','2026-01-14 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-01-14 08:00:00','2026-01-14 08:00:00'),
('USR-EXT001','EXTERNAL',NULL,'John','Kamau','John Kamau','john.kamau@bluepeak.example','+254722200001','ACTIVE','2026-08-01 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-08-01 08:00:00','2026-08-01 08:00:00'),
('USR-EXT002','EXTERNAL',NULL,'Mary','Wanjiku','Mary Wanjiku','mary.wanjiku@riftline.example','+254722200002','ACTIVE','2026-08-02 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-08-02 08:00:00','2026-08-02 08:00:00'),
('USR-EXT003','EXTERNAL',NULL,'Peter','Otieno','Peter Otieno','peter.otieno@eastgate.example','+254722200003','ACTIVE','2026-08-03 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-08-03 08:00:00','2026-08-03 08:00:00'),
('USR-EXT004','EXTERNAL',NULL,'Faith','Njeri','Faith Njeri','faith.njeri@lakeviewfoods.example','+254722200004','ACTIVE','2026-08-04 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-08-04 08:00:00','2026-08-04 08:00:00'),
('USR-EXT005','EXTERNAL',NULL,'David','Mutua','David Mutua','david.mutua@savannahagg.example','+254722200005','ACTIVE','2026-08-05 08:00:00','Africa/Nairobi','en-KE',NULL,'2026-08-05 08:00:00','2026-08-05 08:00:00');

INSERT OR IGNORE INTO user_assignments
(assignment_id,user_id,job_title_id,department_id,assignment_level,country_id,affiliate_id,business_unit_id,effective_from,effective_to,is_primary,active,created_at) VALUES
('UA-001','USR-CATH','JT-CSM','DEP-CS','AFFILIATE','CTR-KE','AFF-KE',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-002','USR-GAB','JT-FM','DEP-FIN','AFFILIATE','CTR-KE','AFF-KE',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-003','USR-ZUL','JT-FM','DEP-FIN','BUSINESS_UNIT','CTR-KE','AFF-KE','BU-RET','2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-004','USR-VIC','JT-CRM','DEP-CRD','GROUP',NULL,NULL,NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-005','USR-AMN','JT-CM','DEP-OPS','AFFILIATE','CTR-KE','AFF-KE',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-006','USR-JAM','JT-SE','DEP-SAL','BUSINESS_UNIT','CTR-KE','AFF-KE','BU-CI','2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-007','USR-FMUG','JT-FM','DEP-FIN','AFFILIATE','CTR-UG','AFF-UG',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-008','USR-FMTZ','JT-FM','DEP-FIN','AFFILIATE','CTR-TZ','AFF-TZ',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-009','USR-CMUG','JT-CM','DEP-OPS','AFFILIATE','CTR-UG','AFF-UG',NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP),
('UA-010','USR-GCFO','JT-GCFO','DEP-FIN','GROUP',NULL,NULL,NULL,'2026-01-01',NULL,1,1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO team_members VALUES
('TM-001','TEAM-CS-KE','USR-CATH','Manager','2026-01-01',NULL,1),
('TM-002','TEAM-FIN-KE','USR-GAB','Manager','2026-01-01',NULL,1),
('TM-003','TEAM-FIN-KE','USR-ZUL','Approver','2026-01-01',NULL,1),
('TM-004','TEAM-CRD-GRP','USR-VIC','Manager','2026-01-01',NULL,1),
('TM-005','TEAM-OPS-KE','USR-AMN','Manager','2026-01-01',NULL,1),
('TM-006','TEAM-SALES-KE','USR-JAM','Sales Executive','2026-01-01',NULL,1),
('TM-007','TEAM-FIN-UG','USR-FMUG','Manager','2026-01-01',NULL,1),
('TM-008','TEAM-FIN-TZ','USR-FMTZ','Manager','2026-01-01',NULL,1),
('TM-009','TEAM-OPS-UG','USR-CMUG','Manager','2026-01-01',NULL,1),
('TM-010','TEAM-FIN-GRP','USR-GCFO','Group Executive','2026-01-01',NULL,1);

INSERT OR IGNORE INTO access_roles VALUES
('ROLE-ADMIN','System Administrator','Full configuration and security administration',1,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-CSM','Customer Service Manager','Manage customer service, cases and SLA',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-FIN','Finance Manager','Review finance transactions within assigned data scope',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-CRD','Credit Manager','Manage credit exceptions and approvals',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-CM','Country Manager','Country or affiliate operational visibility and approvals',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-SALES','Sales Executive','Manage own leads and opportunities',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-GRP-FIN','Group Finance','Group-wide finance visibility and approved administrative actions',0,1,'USR-CATH',CURRENT_TIMESTAMP),
('ROLE-PORTAL','Customer Portal User','External customer self-service access restricted by portal membership',1,1,'USR-CATH',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO permissions VALUES
('PERM-001','CRM','LEADS','VIEW','View leads'),
('PERM-002','CRM','LEADS','CREATE','Create leads'),
('PERM-003','CRM','LEADS','ASSIGN','Assign leads'),
('PERM-004','CRM','OPPORTUNITIES','EDIT','Edit opportunities'),
('PERM-005','SERVICE','CASES','VIEW','View service cases'),
('PERM-006','SERVICE','CASES','CREATE','Create service cases'),
('PERM-007','SERVICE','CASES','REASSIGN','Reassign service cases'),
('PERM-008','ORDERS','SALES_ORDER','VIEW','View sales orders'),
('PERM-009','ORDERS','SALES_ORDER','UPLOAD','Upload sales order extracts'),
('PERM-010','ORDERS','PURCHASE_ORDER','VIEW','View purchase orders'),
('PERM-011','ORDERS','PURCHASE_ORDER','UPLOAD','Upload purchase order extracts'),
('PERM-012','CREDIT','EXCEPTION','APPROVE','Approve credit exceptions'),
('PERM-013','SLA','DASHBOARD','VIEW','View SLA dashboard'),
('PERM-014','SLA','RULES','MANAGE','Manage SLA rules'),
('PERM-015','ADMIN','ROLES','MANAGE','Create roles and assign permissions'),
('PERM-016','ADMIN','USERS','MANAGE','Create and manage users'),
('PERM-017','ADMIN','WORKFLOWS','MANAGE','Configure workflows'),
('PERM-018','DATA','IMPORTS','VIEW','View import history'),
('PERM-019','DATA','IMPORTS','UPLOAD','Run data imports'),
('PERM-020','AUDIT','EVENTS','VIEW','View audit trail'),
('PERM-021','ADMIN','WORKFLOW_ROLES','MANAGE','Create workflow roles and scoped workflow authorities'),
('PERM-022','PORTAL','ACCOUNT','VIEW','View own customer account portal'),
('PERM-023','PORTAL','ORDERS','VIEW','View own customer orders'),
('PERM-024','PORTAL','CASES','CREATE','Raise customer service cases from portal'),
('PERM-025','PORTAL','CASES','VIEW','View own customer service cases'),
('PERM-026','PORTAL','DOCUMENTS','VIEW','View portal-approved customer documents'),
('PERM-027','PORTAL','FEEDBACK','CREATE','Submit customer feedback and surveys'),
('PERM-028','ADMIN','PRODUCT_CATALOG','MANAGE','Manage product groups, categories and products');

INSERT OR IGNORE INTO role_permissions
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions;

INSERT OR IGNORE INTO role_permissions VALUES
('RP-CS-001','ROLE-CSM','PERM-001',1,CURRENT_TIMESTAMP),
('RP-CS-002','ROLE-CSM','PERM-002',1,CURRENT_TIMESTAMP),
('RP-CS-003','ROLE-CSM','PERM-003',1,CURRENT_TIMESTAMP),
('RP-CS-004','ROLE-CSM','PERM-005',1,CURRENT_TIMESTAMP),
('RP-CS-005','ROLE-CSM','PERM-006',1,CURRENT_TIMESTAMP),
('RP-CS-006','ROLE-CSM','PERM-007',1,CURRENT_TIMESTAMP),
('RP-CS-007','ROLE-CSM','PERM-013',1,CURRENT_TIMESTAMP),
('RP-FIN-001','ROLE-FIN','PERM-008',1,CURRENT_TIMESTAMP),
('RP-FIN-002','ROLE-FIN','PERM-010',1,CURRENT_TIMESTAMP),
('RP-FIN-003','ROLE-FIN','PERM-013',1,CURRENT_TIMESTAMP),
('RP-FIN-004','ROLE-FIN','PERM-018',1,CURRENT_TIMESTAMP),
('RP-FIN-005','ROLE-FIN','PERM-020',1,CURRENT_TIMESTAMP),
('RP-CRD-001','ROLE-CRD','PERM-008',1,CURRENT_TIMESTAMP),
('RP-CRD-002','ROLE-CRD','PERM-012',1,CURRENT_TIMESTAMP),
('RP-CRD-003','ROLE-CRD','PERM-013',1,CURRENT_TIMESTAMP),
('RP-CRD-004','ROLE-CRD','PERM-001',1,CURRENT_TIMESTAMP),
('RP-CRD-005','ROLE-CRD','PERM-005',1,CURRENT_TIMESTAMP),
('RP-CM-001','ROLE-CM','PERM-001',1,CURRENT_TIMESTAMP),
('RP-CM-002','ROLE-CM','PERM-005',1,CURRENT_TIMESTAMP),
('RP-CM-003','ROLE-CM','PERM-008',1,CURRENT_TIMESTAMP),
('RP-CM-004','ROLE-CM','PERM-010',1,CURRENT_TIMESTAMP),
('RP-CM-005','ROLE-CM','PERM-013',1,CURRENT_TIMESTAMP),
('RP-SAL-001','ROLE-SALES','PERM-001',1,CURRENT_TIMESTAMP),
('RP-SAL-002','ROLE-SALES','PERM-002',1,CURRENT_TIMESTAMP),
('RP-SAL-003','ROLE-SALES','PERM-004',1,CURRENT_TIMESTAMP),
('RP-SAL-004','ROLE-SALES','PERM-005',1,CURRENT_TIMESTAMP),
('RP-SAL-005','ROLE-SALES','PERM-013',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO role_permissions VALUES
('RP-GF-001','ROLE-GRP-FIN','PERM-008',1,CURRENT_TIMESTAMP),
('RP-GF-002','ROLE-GRP-FIN','PERM-010',1,CURRENT_TIMESTAMP),
('RP-GF-003','ROLE-GRP-FIN','PERM-013',1,CURRENT_TIMESTAMP),
('RP-GF-004','ROLE-GRP-FIN','PERM-018',1,CURRENT_TIMESTAMP),
('RP-GF-005','ROLE-GRP-FIN','PERM-020',1,CURRENT_TIMESTAMP),
('RP-PORT-001','ROLE-PORTAL','PERM-022',1,CURRENT_TIMESTAMP),
('RP-PORT-002','ROLE-PORTAL','PERM-023',1,CURRENT_TIMESTAMP),
('RP-PORT-003','ROLE-PORTAL','PERM-024',1,CURRENT_TIMESTAMP),
('RP-PORT-004','ROLE-PORTAL','PERM-025',1,CURRENT_TIMESTAMP),
('RP-PORT-005','ROLE-PORTAL','PERM-026',1,CURRENT_TIMESTAMP),
('RP-PORT-006','ROLE-PORTAL','PERM-027',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO user_roles VALUES
('UR-001','USR-CATH','ROLE-ADMIN','2026-01-01',NULL,'USR-CATH',1),
('UR-002','USR-CATH','ROLE-CSM','2026-01-01',NULL,'USR-CATH',1),
('UR-003','USR-GAB','ROLE-FIN','2026-01-01',NULL,'USR-CATH',1),
('UR-004','USR-ZUL','ROLE-FIN','2026-01-01',NULL,'USR-CATH',1),
('UR-005','USR-VIC','ROLE-CRD','2026-01-01',NULL,'USR-CATH',1),
('UR-006','USR-AMN','ROLE-CM','2026-01-01',NULL,'USR-CATH',1),
('UR-007','USR-JAM','ROLE-SALES','2026-01-01',NULL,'USR-CATH',1),
('UR-008','USR-FMUG','ROLE-FIN','2026-01-01',NULL,'USR-CATH',1),
('UR-009','USR-FMTZ','ROLE-FIN','2026-01-01',NULL,'USR-CATH',1),
('UR-010','USR-CMUG','ROLE-CM','2026-01-01',NULL,'USR-CATH',1),
('UR-011','USR-GCFO','ROLE-GRP-FIN','2026-01-01',NULL,'USR-CATH',1),
('UR-012','USR-EXT001','ROLE-PORTAL','2026-08-01',NULL,'USR-CATH',1),
('UR-013','USR-EXT002','ROLE-PORTAL','2026-08-02',NULL,'USR-CATH',1),
('UR-014','USR-EXT003','ROLE-PORTAL','2026-08-03',NULL,'USR-CATH',1),
('UR-015','USR-EXT004','ROLE-PORTAL','2026-08-04',NULL,'USR-CATH',1),
('UR-016','USR-EXT005','ROLE-PORTAL','2026-08-05',NULL,'USR-CATH',1);

INSERT OR IGNORE INTO user_role_scopes
(scope_id,user_role_id,scope_type,country_id,affiliate_id,business_unit_id,team_id,created_at) VALUES
('SCOPE-001','UR-001','GROUP',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-002','UR-002','GROUP',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-003','UR-003','AFFILIATE',NULL,'AFF-KE',NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-004','UR-004','BUSINESS_UNIT',NULL,'AFF-KE','BU-RET',NULL,CURRENT_TIMESTAMP),
('SCOPE-005','UR-005','GROUP',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-006','UR-006','AFFILIATE',NULL,'AFF-KE',NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-007','UR-007','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-008','UR-008','AFFILIATE',NULL,'AFF-UG',NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-009','UR-009','AFFILIATE',NULL,'AFF-TZ',NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-010','UR-010','AFFILIATE',NULL,'AFF-UG',NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-011','UR-011','GROUP',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-012','UR-012','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-013','UR-013','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-014','UR-014','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-015','UR-015','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP),
('SCOPE-016','UR-016','OWN',NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO source_systems VALUES
('SRC-ORACLE','Oracle EBS','ORACLE',1,CURRENT_TIMESTAMP),
('SRC-EXCEL','Managed Excel Upload','EXCEL',1,CURRENT_TIMESTAMP),
('SRC-WEB','CRM Web Form','WEB_FORM',1,CURRENT_TIMESTAMP),
('SRC-EMAIL','Customer Service Email','EMAIL',1,CURRENT_TIMESTAMP),
('SRC-MANUAL','Manual Entry','MANUAL',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO source_identities VALUES
('SID-001','SRC-ORACLE','USR-GAB','GABRIEL.MUSEMBI','AFF-KE',1,CURRENT_TIMESTAMP),
('SID-002','SRC-ORACLE','USR-ZUL','ZULEIKA.OMAR','AFF-KE',1,CURRENT_TIMESTAMP),
('SID-003','SRC-ORACLE','USR-VIC','VICTOR.NJOROGE','AFF-KE',1,CURRENT_TIMESTAMP),
('SID-004','SRC-ORACLE','USR-AMN','AMINA.YUSUF','AFF-KE',1,CURRENT_TIMESTAMP),
('SID-005','SRC-ORACLE','USR-JAM','JAMES.MAINA','AFF-KE',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO product_groups VALUES
('PG-FUEL','FUELS','Ground Fuels','Petroleum motor and diesel fuels',1,10),
('PG-AVI','AVIATION','Aviation Fuels','Aviation fuel products',1,20),
('PG-LPG','LPG','LPG','Liquefied petroleum gas products',1,30),
('PG-LUB','LUBRICANTS','Lubricants','Lubricants and related products',1,40),
('PG-OTH','OTHER','Other Products','Other commercial products',1,90);

INSERT OR IGNORE INTO product_categories VALUES
('PC-AGO','PG-FUEL',NULL,'AGO','Automotive Gas Oil','LITRE','Diesel / automotive gas oil',1,10),
('PC-PMS','PG-FUEL',NULL,'PMS','Premium Motor Spirit','LITRE','Petrol / premium motor spirit',1,20),
('PC-JET','PG-AVI',NULL,'JET_A1','Jet A1','LITRE','Jet A-1 aviation fuel',1,10),
('PC-LPG','PG-LPG',NULL,'LPG','Liquefied Petroleum Gas','KG','LPG products',1,10),
('PC-LUBE','PG-LUB',NULL,'LUBRICANTS','Lubricants','UNIT','Lubricants master category',1,10);

INSERT OR IGNORE INTO products VALUES
('PROD-AGO','AGO','Automotive Gas Oil','PC-AGO','LITRE',1,CURRENT_TIMESTAMP),
('PROD-PMS','PMS','Premium Motor Spirit','PC-PMS','LITRE',1,CURRENT_TIMESTAMP),
('PROD-JET','JET-A1','Jet A1 Aviation Fuel','PC-JET','LITRE',1,CURRENT_TIMESTAMP),
('PROD-LPG','LPG','Liquefied Petroleum Gas','PC-LPG','KG',1,CURRENT_TIMESTAMP),
('PROD-LUBE','LUBES','Lubricants','PC-LUBE','UNIT',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounts VALUES
('ACC-001','CUST-001','BluePeak Transport Ltd','CUSTOMER','ORA-KE-1001','Transport','Key Account','CTR-KE','AFF-KE','Industrial Area, Nairobi','+254711100001','procurement@bluepeak.example','https://bluepeak.example','P051001001A',5000000,30,'USR-JAM','2025-03-01','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('ACC-002','CUST-002','Riftline Logistics Ltd','CUSTOMER','ORA-KE-1002','Logistics','Corporate','CTR-KE','AFF-KE','Athi River, Machakos','+254711100002','ops@riftline.example','https://riftline.example','P051001002B',2500000,21,'USR-JAM','2025-08-15','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('ACC-003','PROS-003','EastGate Manufacturing Ltd','PROSPECT',NULL,'Manufacturing','Prospect','CTR-KE','AFF-KE','Thika, Kiambu','+254711100003','supply@eastgate.example','https://eastgate.example','P051001003C',NULL,NULL,'USR-JAM',NULL,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('ACC-004','CUST-004','Lakeview Foods Ltd','CUSTOMER','ORA-KE-1004','FMCG','Corporate','CTR-KE','AFF-KE','Naivasha, Nakuru','+254711100004','finance@lakeviewfoods.example','https://lakeviewfoods.example','P051001004D',1800000,30,'USR-JAM','2024-11-01','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('ACC-005','PROS-005','Savannah Aggregates Ltd','PROSPECT',NULL,'Construction','Prospect','CTR-KE','AFF-KE','Kitengela, Kajiado','+254711100005','admin@savannahagg.example','https://savannahagg.example','P051001005E',NULL,NULL,'USR-JAM',NULL,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO business_calendars VALUES
('CAL-KE','Kenya Business Hours','Africa/Nairobi','08:00','17:00',1,1,1,1,1,0,0,1),
('CAL-UG','Uganda Business Hours','Africa/Kampala','08:00','17:00',1,1,1,1,1,0,0,1),
('CAL-TZ','Tanzania Business Hours','Africa/Dar_es_Salaam','08:00','17:00',1,1,1,1,1,0,0,1),
('CAL-RW','Rwanda Business Hours','Africa/Kigali','08:00','17:00',1,1,1,1,1,0,0,1),
('CAL-ZM','Zambia Business Hours','Africa/Lusaka','08:00','17:00',1,1,1,1,1,0,0,1);

INSERT OR IGNORE INTO sla_profiles VALUES
('SLAP-001','Group Internal Standard','INTERNAL',30,NULL,NULL,NULL,'2026-01-01',NULL,1),
('SLAP-002','Group External Standard','EXTERNAL',40,NULL,NULL,NULL,'2026-01-01',NULL,1),
('SLAP-003','Key Account External SLA','EXTERNAL',80,NULL,'Key Account',NULL,'2026-01-01',NULL,1),
('SLAP-004','Kenya Operational Internal SLA','INTERNAL',60,NULL,NULL,'AFF-KE','2026-01-01',NULL,1),
('SLAP-005','BluePeak Contract SLA','EXTERNAL',100,'ACC-001',NULL,'AFF-KE','2026-01-01',NULL,1);

INSERT OR IGNORE INTO sla_rules VALUES
('SLAR-001','SLAP-002','Customer case first response','CASE','FIRST_RESPONSE','HIGH',60,45,'CAL-KE',1,0,60,1),
('SLAR-002','SLAP-001','Lead first contact','LEAD','FIRST_CONTACT',NULL,120,90,'CAL-KE',1,0,120,1),
('SLAR-003','SLAP-004','SO finance approval','SALES_ORDER','FINANCE_APPROVAL',NULL,60,45,'CAL-KE',1,0,60,1),
('SLAR-004','SLAP-004','SO credit approval','SALES_ORDER','CREDIT_APPROVAL',NULL,120,90,'CAL-KE',1,0,120,1),
('SLAR-005','SLAP-004','PO approval stage','PURCHASE_ORDER','PO_APPROVAL',NULL,180,150,'CAL-KE',1,0,180,1),
('SLAR-006','SLAP-005','BluePeak complaint response','CASE','FIRST_RESPONSE','HIGH',30,20,'CAL-KE',1,0,30,1);

INSERT OR IGNORE INTO workflow_roles VALUES
('WROLE-SO-FIN','SO_FINANCE_APPROVER','SO Finance Approver','SALES_ORDER','Finance approval for sales orders',1,CURRENT_TIMESTAMP),
('WROLE-SO-CRD','SO_CREDIT_APPROVER','SO Credit Approver','CREDIT_EXCEPTION','Credit exception approval for sales orders',1,CURRENT_TIMESTAMP),
('WROLE-PO-FIN','PO_FINANCE_APPROVER','PO Finance Approver','PURCHASE_ORDER','Finance approval for purchase orders',1,CURRENT_TIMESTAMP),
('WROLE-CM','COUNTRY_MANAGER_APPROVER','Country Manager Approver',NULL,'Country or affiliate management approval',1,CURRENT_TIMESTAMP),
('WROLE-GFIN','GROUP_FINANCE_APPROVER','Group Finance Approver',NULL,'Group-wide finance approval and escalation authority',1,CURRENT_TIMESTAMP),
('WROLE-CASE','CASE_RESOLVER','Customer Case Resolver','CASE','Customer service or internal case resolution authority',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO workflow_role_assignments VALUES
('WRA-001','WROLE-SO-FIN','USR-GAB','AFFILIATE',NULL,'AFF-KE',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-002','WROLE-SO-FIN','USR-ZUL','BUSINESS_UNIT','CTR-KE','AFF-KE','BU-RET',20,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-003','WROLE-SO-FIN','USR-FMUG','AFFILIATE',NULL,'AFF-UG',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-004','WROLE-SO-FIN','USR-FMTZ','AFFILIATE',NULL,'AFF-TZ',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-005','WROLE-PO-FIN','USR-GAB','AFFILIATE',NULL,'AFF-KE',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-006','WROLE-CM','USR-AMN','AFFILIATE',NULL,'AFF-KE',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-007','WROLE-CM','USR-CMUG','AFFILIATE',NULL,'AFF-UG',NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-008','WROLE-GFIN','USR-GCFO','GROUP',NULL,NULL,NULL,1,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-009','WROLE-SO-CRD','USR-VIC','GROUP',NULL,NULL,NULL,1,'2026-01-01',NULL,1,CURRENT_TIMESTAMP),
('WRA-010','WROLE-CASE','USR-CATH','GROUP',NULL,NULL,NULL,10,'2026-01-01',NULL,1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO approval_authority_rules VALUES
('AAR-001','WRA-001','SALES_ORDER','KES',0,50000000,'PG-FUEL',NULL,10,1,'2026-01-01',NULL),
('AAR-002','WRA-002','SALES_ORDER','KES',0,25000000,'PG-FUEL',NULL,20,1,'2026-01-01',NULL),
('AAR-003','WRA-005','PURCHASE_ORDER','USD',0,250000,NULL,NULL,10,1,'2026-01-01',NULL),
('AAR-004','WRA-008','PURCHASE_ORDER','USD',250000.01,NULL,NULL,NULL,1,1,'2026-01-01',NULL),
('AAR-005','WRA-009','CREDIT_EXCEPTION',NULL,0,NULL,NULL,NULL,1,1,'2026-01-01',NULL);

INSERT OR IGNORE INTO workflow_definitions VALUES
('WFD-001','Kenya Sales Order Approval','SALES_ORDER','CTR-KE','AFF-KE',NULL,1,1,'2026-01-01',NULL),
('WFD-002','Kenya Purchase Order Approval','PURCHASE_ORDER','CTR-KE','AFF-KE',NULL,1,1,'2026-01-01',NULL),
('WFD-003','Lead Qualification Workflow','LEAD','CTR-KE','AFF-KE','BU-CI',1,1,'2026-01-01',NULL),
('WFD-004','Customer Service Case Workflow','CASE','CTR-KE','AFF-KE',NULL,1,1,'2026-01-01',NULL),
('WFD-005','Credit Exception Workflow','CREDIT_EXCEPTION',NULL,NULL,NULL,1,1,'2026-01-01',NULL);

INSERT OR IGNORE INTO workflow_stages VALUES
('WST-001','WFD-001','FINANCE_APPROVAL','Finance Approval',1,'WORKFLOW_ROLE',NULL,'WROLE-SO-FIN',NULL,'ANY_ONE',1,'SLAR-003',0),
('WST-002','WFD-001','CREDIT_CHECK','Credit Check',2,'WORKFLOW_ROLE',NULL,'WROLE-SO-CRD',NULL,'ANY_ONE',1,'SLAR-004',0),
('WST-003','WFD-001','LOADING','Loading / Invoice',3,'TEAM',NULL,NULL,'TEAM-OPS-KE','ANY_ONE',1,NULL,1),
('WST-004','WFD-002','PO_LEVEL_1','PO Cost Review',1,'TEAM',NULL,NULL,'TEAM-FIN-KE','ANY_ONE',1,'SLAR-005',0),
('WST-005','WFD-002','PO_LEVEL_2','PO Finance Approval',2,'WORKFLOW_ROLE',NULL,'WROLE-PO-FIN',NULL,'ANY_ONE',1,'SLAR-005',0),
('WST-006','WFD-002','PO_FINAL','Country Manager Approval',3,'WORKFLOW_ROLE',NULL,'WROLE-CM',NULL,'ANY_ONE',1,'SLAR-005',1),
('WST-007','WFD-003','FIRST_CONTACT','Lead First Contact',1,'USER','USR-JAM',NULL,'TEAM-SALES-KE','NAMED',1,'SLAR-002',0),
('WST-008','WFD-003','QUALIFY','Lead Qualification',2,'USER','USR-JAM',NULL,'TEAM-SALES-KE','NAMED',1,NULL,1),
('WST-009','WFD-004','TRIAGE','Case Triage',1,'TEAM',NULL,NULL,'TEAM-CS-KE','ANY_ONE',1,'SLAR-001',0),
('WST-010','WFD-004','RESOLVE','Case Resolution',2,'WORKFLOW_ROLE',NULL,'WROLE-CASE','TEAM-CS-KE','ANY_ONE',1,NULL,1),
('WST-011','WFD-005','CREDIT_REVIEW','Credit Exception Review',1,'WORKFLOW_ROLE',NULL,'WROLE-SO-CRD','TEAM-CRD-GRP','ANY_ONE',1,'SLAR-004',0),
('WST-012','WFD-005','CREDIT_DECISION','Credit Decision',2,'WORKFLOW_ROLE',NULL,'WROLE-SO-CRD','TEAM-CRD-GRP','ANY_ONE',1,NULL,1);
`;

/**
 * Load the operator's seed into a test database.
 *
 * Statement by statement rather than one `exec`, so a failing row names itself
 * instead of the whole block failing as one.
 */
export async function seedHass(db: TestClient): Promise<void> {
  for (const statement of SEED_SQL.split(';\n')) {
    const sql = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (sql === '') continue;
    await db.execute(sql);
  }
}
