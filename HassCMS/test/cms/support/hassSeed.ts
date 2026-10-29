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
('CTR-ZM','ZM','Zambia','Africa/Lusaka','ZMW',1,CURRENT_TIMESTAMP),
('CTR-CD','CD','DR Congo','Africa/Lubumbashi','USD',1,CURRENT_TIMESTAMP),
('CTR-SS','SS','South Sudan','Africa/Juba','SSP',1,CURRENT_TIMESTAMP);

-- THE EIGHT ENTITIES OF THE OPERATOR'S ALIGNMENT SCRIPT, mirrored. The
-- script added extract_code (the token the monthly extract filenames carry)
-- and three entities: DRC as HPD, South Sudan as HPS and the terminal as
-- HTW. Named columns, because the live table now has one more column than
-- a positional VALUES list was written for.
-- THE OPERATOR'S AFFILIATE SCRIPT, MIRRORED (Build Prompt 45 prerequisite):
-- DRC was HPD and South Sudan was HPS; the script corrects them to HPC and
-- HSS. The codes are what the country tabs draw, so they are read from here
-- rather than compiled into a component.
INSERT OR IGNORE INTO affiliates
(affiliate_id, affiliate_code, affiliate_name, country_id, active, created_at, extract_code) VALUES
('AFF-KE','HPK','Hass Petroleum Kenya','CTR-KE',1,CURRENT_TIMESTAMP,'KE'),
('AFF-UG','HPU','Hass Petroleum Uganda','CTR-UG',1,CURRENT_TIMESTAMP,'UG'),
('AFF-TZ','HPT','Hass Petroleum Tanzania','CTR-TZ',1,CURRENT_TIMESTAMP,'TZ'),
('AFF-RW','HPR','Hass Petroleum Rwanda','CTR-RW',1,CURRENT_TIMESTAMP,'RW'),
('AFF-ZM','HPZ','Hass Petroleum Zambia','CTR-ZM',1,CURRENT_TIMESTAMP,'ZM'),
('AFF-CD','HPC','Hass Petroleum DRC','CTR-CD',1,CURRENT_TIMESTAMP,'DRC'),
('AFF-SS','HSS','Hass Petroleum South Sudan','CTR-SS',1,CURRENT_TIMESTAMP,'SSD'),
('AFF-TW','HTW','Hass Terminal','CTR-KE',1,CURRENT_TIMESTAMP,'TERMINAL');

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
-- THE OPERATOR'S TARGETS SCRIPT, MIRRORED (Build Prompt 45 prerequisite): all
-- three active SALES_ORDER rules now sit at 30 minutes with a 25-minute
-- warning, business hours only against the Kenya calendar's 08:00-17:00 day.
-- Loading authority came down from 90 in Build Prompt 45, so every approval
-- function in the system carries the same number.
--
-- THEY SHARE A VALUE AND ARE STILL READ SEPARATELY, which is the one thing
-- three equal numbers make impossible to see: code that reads one target and
-- draws it three times looks identical to code that reads three. Moving one
-- rule must move one line, and a test holds that.
('SLAR-003','SLAP-004','SO finance approval','SALES_ORDER','FINANCE_APPROVAL',NULL,30,25,'CAL-KE',1,0,30,1),
('SLAR-004','SLAP-004','SO credit approval','SALES_ORDER','CREDIT_APPROVAL',NULL,30,25,'CAL-KE',1,0,30,1),
('SLAR-SO-LA','SLAP-004','SO loading authority','SALES_ORDER','LOADING_AUTHORITY',NULL,30,25,'CAL-KE',1,0,30,1),
-- THE OPERATOR'S SLA SCRIPT, MIRRORED (Build Prompt 43 prerequisite): the old
-- 180-minute stage rule is deactivated and the one active PURCHASE_ORDER rule
-- is SLAR-PO-30 — 30-minute target, 25-minute warning, business hours only,
-- against the Kenya calendar's 08:00–17:00 day. The row stays because
-- workflow_stages references it; only its active flag changed.
('SLAR-005','SLAP-004','PO approval stage','PURCHASE_ORDER','PO_APPROVAL',NULL,180,150,'CAL-KE',1,0,180,0),
('SLAR-PO-30','SLAP-004','PO approval target','PURCHASE_ORDER',NULL,NULL,30,25,'CAL-KE',1,0,30,1),
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

-- ============================================================================
-- The CRM, service, SLA runtime, order and ingestion seed rows.
--
-- Copied verbatim from the operator's hass_cms_turso_v1_FINAL.sql, in that
-- file's own order, which is already foreign-key safe. The blocks above arrived
-- with Build Prompts 03 to 09; these 37 are the remainder, added for the
-- 10-to-19 batch, so an assertion like "the Kenya pipeline's first stage is
-- Qualification" is a statement about real configuration rather than about a
-- fixture written to make a test pass.
--
-- SEVEN BLOCKS ARE DELIBERATELY NOT COPIED, and the reason matters.
--
-- auth_credentials, auth_sessions, email_verification_tokens,
-- password_reset_tokens, login_attempts and mfa_methods: the authentication
-- tests build their own credentials and sessions, and seeded password hashes
-- and live sessions would collide with what those tests arrange for themselves.
--
-- audit_events: almost every test in this suite asserts on the audit rows it
-- caused. A pre-populated trail would turn "exactly one APPROVAL_EXCEPTION row"
-- and "no row has a null actor" into statements about the seed rather than
-- about the code under test.
-- ============================================================================

INSERT OR IGNORE INTO contacts VALUES
('CON-001','ACC-001','John Kamau','Procurement Director','john.kamau@bluepeak.example','+254722200001','+254722200001','WHATSAPP',1,1,CURRENT_TIMESTAMP),
('CON-002','ACC-002','Mary Wanjiku','Operations Manager','mary.wanjiku@riftline.example','+254722200002','+254722200002','EMAIL',1,1,CURRENT_TIMESTAMP),
('CON-003','ACC-003','Peter Otieno','Supply Chain Manager','peter.otieno@eastgate.example','+254722200003','+254722200003','PHONE',1,1,CURRENT_TIMESTAMP),
('CON-004','ACC-004','Faith Njeri','Finance Manager','faith.njeri@lakeviewfoods.example','+254722200004','+254722200004','EMAIL',1,1,CURRENT_TIMESTAMP),
('CON-005','ACC-005','David Mutua','Managing Director','david.mutua@savannahagg.example','+254722200005','+254722200005','WHATSAPP',1,1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO customer_portal_memberships VALUES
('CPM-001','USR-EXT001','ACC-001','CON-001','ROLE-PORTAL','ACTIVE','2026-08-01 07:30:00','USR-CATH','2026-08-01 08:00:00',NULL,CURRENT_TIMESTAMP),
('CPM-002','USR-EXT002','ACC-002','CON-002','ROLE-PORTAL','ACTIVE','2026-08-02 07:30:00','USR-CATH','2026-08-02 08:00:00',NULL,CURRENT_TIMESTAMP),
('CPM-003','USR-EXT003','ACC-003','CON-003','ROLE-PORTAL','ACTIVE','2026-08-03 07:30:00','USR-CATH','2026-08-03 08:00:00',NULL,CURRENT_TIMESTAMP),
('CPM-004','USR-EXT004','ACC-004','CON-004','ROLE-PORTAL','ACTIVE','2026-08-04 07:30:00','USR-CATH','2026-08-04 08:00:00',NULL,CURRENT_TIMESTAMP),
('CPM-005','USR-EXT005','ACC-005','CON-005','ROLE-PORTAL','ACTIVE','2026-08-05 07:30:00','USR-CATH','2026-08-05 08:00:00',NULL,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO lead_sources VALUES
('LS-001','Customer Service Referral','Opportunity discovered during a service interaction',1),
('LS-002','Website Enquiry','Lead captured from web form',1),
('LS-003','Sales Prospecting','Direct prospecting by sales team',1),
('LS-004','Customer Referral','Referral from an existing customer',1),
('LS-005','Industry Event','Lead sourced from event or conference',1);

INSERT OR IGNORE INTO campaigns VALUES
('CMP-001','Kenya Fleet Growth Q3','DIRECT','2026-07-01','2026-09-30',25000000,'TEAM-SALES-KE','ACTIVE',CURRENT_TIMESTAMP),
('CMP-002','Lubes Cross-Sell','RETENTION','2026-08-01','2026-10-31',8000000,'TEAM-SALES-KE','ACTIVE',CURRENT_TIMESTAMP),
('CMP-003','Manufacturing AGO Drive','DIRECT','2026-08-01','2026-12-15',30000000,'TEAM-SALES-KE','ACTIVE',CURRENT_TIMESTAMP),
('CMP-004','Digital LPG Leads','DIGITAL','2026-06-01','2026-09-30',6000000,'TEAM-SALES-KE','ACTIVE',CURRENT_TIMESTAMP),
('CMP-005','Transport Forum 2026','EVENT','2026-08-10','2026-08-12',12000000,'TEAM-SALES-KE','COMPLETED',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO pipelines VALUES
('PIPE-001','Kenya B2B Fuel Pipeline','CTR-KE','AFF-KE',1,CURRENT_TIMESTAMP),
('PIPE-002','Uganda B2B Fuel Pipeline','CTR-UG','AFF-UG',1,CURRENT_TIMESTAMP),
('PIPE-003','Tanzania B2B Fuel Pipeline','CTR-TZ','AFF-TZ',1,CURRENT_TIMESTAMP),
('PIPE-004','Rwanda B2B Fuel Pipeline','CTR-RW','AFF-RW',1,CURRENT_TIMESTAMP),
('PIPE-005','Zambia B2B Fuel Pipeline','CTR-ZM','AFF-ZM',1,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO pipeline_stages VALUES
('PST-KE-01','PIPE-001','Qualified',1,0.20,3,0,0,1),
('PST-KE-02','PIPE-001','Proposal',2,0.45,5,0,0,1),
('PST-KE-03','PIPE-001','Negotiation',3,0.70,7,0,0,1),
('PST-KE-04','PIPE-001','Won',4,1.00,0,1,0,1),
('PST-KE-05','PIPE-001','Lost',5,0.00,0,0,1,1);

INSERT OR IGNORE INTO leads
(lead_id,lead_number,account_id,primary_contact_id,lead_source_id,campaign_id,business_unit_id,owner_user_id,title,description,product_interest,estimated_volume,estimated_value,currency_code,captured_at,first_contact_at,status,disqualification_reason,created_by_user_id,created_at) VALUES
('LEAD-001','LD-2026-0001','ACC-003','CON-003','LS-002','CMP-001','BU-CI','USR-JAM','Bulk AGO supply enquiry','Website enquiry for monthly AGO supply','AGO',80000,9200000,'KES','2026-08-12 08:20:00','2026-08-12 09:05:00','QUALIFIED',NULL,'USR-CATH',CURRENT_TIMESTAMP),
('LEAD-002','LD-2026-0002','ACC-005','CON-005','LS-003','CMP-004','BU-CI','USR-JAM','Fleet AGO proposal','Referral for fleet fuel supply','AGO',45000,5200000,'KES','2026-08-13 11:10:00','2026-08-13 13:00:00','QUALIFIED',NULL,'USR-JAM',CURRENT_TIMESTAMP),
('LEAD-003','LD-2026-0003','ACC-001','CON-001','LS-001','CMP-002','BU-LUB','USR-JAM','Lubricants cross-sell','Customer service call identified workshop demand','LUBRICANTS',150,900000,'KES','2026-08-14 13:40:00','2026-08-14 14:10:00','CONVERTED',NULL,'USR-CATH',CURRENT_TIMESTAMP),
('LEAD-004','LD-2026-0004','ACC-002','CON-002','LS-004','CMP-001','BU-CI','USR-JAM','Additional AGO volume','Existing customer referred sister fleet','AGO',30000,3450000,'KES','2026-08-15 09:10:00','2026-08-15 09:45:00','CONTACTED',NULL,'USR-JAM',CURRENT_TIMESTAMP),
('LEAD-005','LD-2026-0005','ACC-004','CON-004','LS-005','CMP-005','BU-LPG','USR-JAM','LPG supply enquiry','Business contact from transport forum','LPG',12000,2100000,'KES','2026-08-16 15:00:00','2026-08-17 08:15:00','DISQUALIFIED','Current contract locked for 12 months','USR-JAM',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO lead_qualifications VALUES
('LQ-001','LEAD-001',4,4,5,4,'Budget confirmed; decision maker engaged','USR-JAM','2026-08-12 12:00:00'),
('LQ-002','LEAD-002',3,4,5,3,'Need is strong; budget range still being confirmed','USR-JAM','2026-08-13 15:20:00'),
('LQ-003','LEAD-003',5,5,4,5,'Existing key account; immediate need','USR-JAM','2026-08-14 16:00:00'),
('LQ-004','LEAD-004',4,3,4,4,'Introduced by existing customer','USR-JAM','2026-08-15 14:30:00'),
('LQ-005','LEAD-005',2,4,3,1,'Timing does not support near-term conversion','USR-JAM','2026-08-17 09:30:00');

INSERT OR IGNORE INTO lost_reasons VALUES
('LR-001','Price','Commercial','Competitor or market pricing',1),
('LR-002','Credit Terms','Commercial','Requested credit terms not accepted',1),
('LR-003','Competitor Retained','Competition','Existing supplier retained',1),
('LR-004','No Decision','Customer','Customer made no decision',1),
('LR-005','Timing','Customer','Opportunity timing moved out of current horizon',1);

INSERT OR IGNORE INTO opportunities
(opportunity_id,opportunity_number,lead_id,account_id,business_unit_id,pipeline_id,current_stage_id,owner_user_id,title,estimated_value,currency_code,probability,estimated_close_date,actual_close_date,status,won_amount,lost_reason_id,lost_notes,created_at,updated_at) VALUES
('OPP-001','OP-2026-0001','LEAD-001','ACC-003','BU-CI','PIPE-001','PST-KE-02','USR-JAM','EastGate AGO Supply',9200000,'KES',0.45,'2026-09-15',NULL,'OPEN',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('OPP-002','OP-2026-0002','LEAD-002','ACC-005','BU-CI','PIPE-001','PST-KE-03','USR-JAM','Savannah Fleet AGO',5200000,'KES',0.70,'2026-09-05',NULL,'OPEN',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('OPP-003','OP-2026-0003','LEAD-003','ACC-001','BU-LUB','PIPE-001','PST-KE-04','USR-JAM','BluePeak Lubricants',900000,'KES',1.00,'2026-08-25','2026-08-22','WON',860000,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('OPP-004','OP-2026-0004','LEAD-004','ACC-002','BU-CI','PIPE-001','PST-KE-01','USR-JAM','Riftline Additional AGO',3450000,'KES',0.20,'2026-09-30',NULL,'OPEN',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('OPP-005','OP-2026-0005','LEAD-005','ACC-004','BU-LPG','PIPE-001','PST-KE-05','USR-JAM','Lakeview LPG',2100000,'KES',0.00,'2026-09-20','2026-08-17','LOST',NULL,'LR-005','Customer contract locked for 12 months',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO opportunity_products VALUES
('OPPPR-001','OPP-001','PROD-AGO',80000,115,9200000),
('OPPPR-002','OPP-002','PROD-AGO',45000,115.56,5200200),
('OPPPR-003','OPP-003','PROD-LUBE',150,6000,900000),
('OPPPR-004','OPP-004','PROD-AGO',30000,115,3450000),
('OPPPR-005','OPP-005','PROD-LPG',12000,175,2100000);

INSERT OR IGNORE INTO opportunity_stage_history VALUES
('OSH-001','OPP-001','PST-KE-01','PST-KE-02','USR-JAM','2026-08-18 10:00:00',8640,'Requirements confirmed; proposal prepared'),
('OSH-002','OPP-002','PST-KE-02','PST-KE-03','USR-JAM','2026-08-20 14:00:00',5760,'Commercial discussion started'),
('OSH-003','OPP-003','PST-KE-03','PST-KE-04','USR-JAM','2026-08-22 16:40:00',2880,'Customer accepted offer'),
('OSH-004','OPP-004',NULL,'PST-KE-01','USR-JAM','2026-08-15 14:35:00',NULL,'Opportunity created'),
('OSH-005','OPP-005','PST-KE-01','PST-KE-05','USR-JAM','2026-08-17 10:00:00',30,'Timing disqualifier confirmed');

INSERT OR IGNORE INTO activities VALUES
('ACT-001','LEAD','LEAD-001','ACC-003','CON-003','CALL','USR-JAM','Initial qualification call','Confirmed monthly volume and decision process','2026-08-12 09:05:00','2026-08-12 09:35:00','Qualified','Prepare proposal','2026-08-13 12:00:00',CURRENT_TIMESTAMP),
('ACT-002','OPPORTUNITY','OPP-002','ACC-005','CON-005','MEETING','USR-JAM','Commercial negotiation','Discussed price and delivery frequency','2026-08-20 14:00:00','2026-08-20 15:20:00','Negotiation ongoing','Revise proposal','2026-08-22 12:00:00',CURRENT_TIMESTAMP),
('ACT-003','OPPORTUNITY','OPP-003','ACC-001','CON-001','PROPOSAL','USR-JAM','Lubricants quotation','Final quotation submitted','2026-08-21 10:00:00','2026-08-21 10:10:00','Accepted next day',NULL,NULL,CURRENT_TIMESTAMP),
('ACT-004','LEAD','LEAD-004','ACC-002','CON-002','EMAIL','USR-JAM','Follow-up email','Requested additional fleet details','2026-08-18 08:00:00','2026-08-18 08:05:00','Awaiting response','Call customer','2026-08-27 09:00:00',CURRENT_TIMESTAMP),
('ACT-005','ACCOUNT','ACC-001','ACC-001','CON-001','CALL','USR-CATH','Customer service review call','Customer mentioned new workshop lubricants demand','2026-08-14 13:20:00','2026-08-14 13:40:00','Lead created','Assign to sales','2026-08-14 14:00:00',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO case_categories VALUES
('CC-001','Delivery','Late Delivery','HIGH',1),
('CC-002','Billing','Invoice Discrepancy','HIGH',1),
('CC-003','Product','Product Availability','MEDIUM',1),
('CC-004','Credit','Credit Limit Query','MEDIUM',1),
('CC-005','Service','General Enquiry','LOW',1);

INSERT OR IGNORE INTO service_cases
(case_id,case_number,account_id,contact_id,business_unit_id,case_type,case_category_id,priority,subject,description,channel,status,assigned_team_id,assigned_user_id,raised_at,first_response_at,resolved_at,closed_at,root_cause,resolution_summary,created_by_user_id,created_at) VALUES
('CASE-001','CS-2026-0001','ACC-001','CON-001','BU-CI','COMPLAINT','CC-001','HIGH','Late delivery to Nairobi yard','Customer reports tanker arrived outside agreed window','PHONE','IN_PROGRESS','TEAM-CS-KE','USR-CATH','2026-08-25 08:10:00','2026-08-25 08:18:00',NULL,NULL,NULL,NULL,'USR-CATH',CURRENT_TIMESTAMP),
('CASE-002','CS-2026-0002','ACC-002','CON-002','BU-CI','COMPLAINT','CC-002','HIGH','Invoice value discrepancy','Invoice differs from agreed quotation','EMAIL','WAITING_INTERNAL','TEAM-FIN-KE','USR-GAB','2026-08-25 09:15:00','2026-08-25 09:35:00',NULL,NULL,NULL,NULL,'USR-CATH',CURRENT_TIMESTAMP),
('CASE-003','CS-2026-0003','ACC-003','CON-003','BU-CI','ENQUIRY','CC-003','MEDIUM','AGO availability for September','Prospect requests supply availability confirmation','WEB','RESOLVED','TEAM-SALES-KE','USR-JAM','2026-08-24 11:00:00','2026-08-24 11:25:00','2026-08-24 13:00:00',NULL,'Stock confirmed','Availability shared with prospect','USR-CATH',CURRENT_TIMESTAMP),
('CASE-004','CS-2026-0004','ACC-004','CON-004','BU-LPG','ENQUIRY','CC-004','MEDIUM','Credit limit confirmation','Customer wants confirmation before next order','EMAIL','CLOSED','TEAM-CRD-GRP','USR-VIC','2026-08-23 10:00:00','2026-08-23 10:20:00','2026-08-23 12:30:00','2026-08-23 13:00:00','Routine credit enquiry','Credit terms confirmed','USR-CATH',CURRENT_TIMESTAMP),
('CASE-005','CS-2026-0005','ACC-005','CON-005','BU-CI','REQUEST','CC-005','LOW','Request product catalogue','Prospect requested current product catalogue','WHATSAPP','RESOLVED','TEAM-CS-KE','USR-CATH','2026-08-22 15:00:00','2026-08-22 15:05:00','2026-08-22 15:12:00',NULL,'Information request','Catalogue sent by email','USR-CATH',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO case_assignment_history VALUES
('CAH-001','CASE-001',NULL,NULL,'TEAM-CS-KE','USR-CATH','USR-CATH','2026-08-25 08:11:00','Initial assignment'),
('CAH-002','CASE-002','TEAM-CS-KE','USR-CATH','TEAM-FIN-KE','USR-GAB','USR-CATH','2026-08-25 09:40:00','Finance investigation required'),
('CAH-003','CASE-003',NULL,NULL,'TEAM-SALES-KE','USR-JAM','USR-CATH','2026-08-24 11:05:00','Product availability sales enquiry'),
('CAH-004','CASE-004','TEAM-CS-KE','USR-CATH','TEAM-CRD-GRP','USR-VIC','USR-CATH','2026-08-23 10:25:00','Credit confirmation required'),
('CAH-005','CASE-005',NULL,NULL,'TEAM-CS-KE','USR-CATH','USR-CATH','2026-08-22 15:01:00','Initial assignment');

INSERT OR IGNORE INTO case_status_history VALUES
('CSH-001','CASE-001','NEW','IN_PROGRESS','USR-CATH','2026-08-25 08:18:00','Customer acknowledged; depot contacted'),
('CSH-002','CASE-002','ASSIGNED','WAITING_INTERNAL','USR-GAB','2026-08-25 09:45:00','Invoice reconciliation underway'),
('CSH-003','CASE-003','IN_PROGRESS','RESOLVED','USR-JAM','2026-08-24 13:00:00','Availability confirmed'),
('CSH-004','CASE-004','RESOLVED','CLOSED','USR-CATH','2026-08-23 13:00:00','Customer confirmed receipt'),
('CSH-005','CASE-005','NEW','RESOLVED','USR-CATH','2026-08-22 15:12:00','Catalogue sent');

INSERT OR IGNORE INTO case_communications VALUES
('COM-001','CASE-001','INBOUND','PHONE','CON-001','USR-CATH','Late delivery','Customer reported delayed tanker','2026-08-25 08:10:00'),
('COM-002','CASE-002','INBOUND','EMAIL','CON-002','USR-CATH','Invoice discrepancy','Customer emailed disputed invoice','2026-08-25 09:15:00'),
('COM-003','CASE-003','OUTBOUND','EMAIL','CON-003','USR-JAM','AGO availability','Availability confirmed for requested period','2026-08-24 13:00:00'),
('COM-004','CASE-004','OUTBOUND','EMAIL','CON-004','USR-VIC','Credit terms','Credit limit and days confirmed','2026-08-23 12:30:00'),
('COM-005','CASE-005','OUTBOUND','EMAIL','CON-005','USR-CATH','Product catalogue','Catalogue sent as requested','2026-08-22 15:12:00');

INSERT OR IGNORE INTO customer_surveys VALUES
('SUR-001','Case Closure CSAT','CSAT','How satisfied are you with how we handled your case?',1),
('SUR-002','Resolution Effort','CES','How easy was it to get your issue resolved?',1),
('SUR-003','Relationship NPS','NPS','How likely are you to recommend Hass Petroleum?',1),
('SUR-004','Delivery CSAT','CSAT','How satisfied are you with the delivery experience?',1),
('SUR-005','Sales Experience CSAT','CSAT','How satisfied are you with our commercial engagement?',1);

INSERT OR IGNORE INTO survey_responses VALUES
('SR-001','SUR-001','CASE-005','ACC-005','CON-005',9,'Very fast response','2026-08-22 16:00:00'),
('SR-002','SUR-001','CASE-004','ACC-004','CON-004',8,'Clear response','2026-08-23 14:10:00'),
('SR-003','SUR-002','CASE-003','ACC-003','CON-003',9,'Easy process','2026-08-24 14:00:00'),
('SR-004','SUR-003',NULL,'ACC-001','CON-001',8,'Generally reliable','2026-08-20 10:00:00'),
('SR-005','SUR-005',NULL,'ACC-002','CON-002',7,'Would like faster quotations','2026-08-21 11:00:00');

INSERT OR IGNORE INTO holidays VALUES
('HOL-001','CAL-KE','2026-06-01','Madaraka Day'),
('HOL-002','CAL-UG','2026-10-09','Independence Day'),
('HOL-003','CAL-TZ','2026-12-09','Independence Day'),
('HOL-004','CAL-RW','2026-07-04','Liberation Day'),
('HOL-005','CAL-ZM','2026-10-24','Independence Day');

INSERT OR IGNORE INTO sales_orders VALUES
('SO-001','SO-KE-10001','AFF-KE','BU-CI','ACC-001','2026-08-25 08:00:00','KES',1150000,1,0,NULL,'INV-10001','2026-08-25 09:10:00','2026-08-25 09:20:00','2026-08-25 10:15:00','LOADED',NULL,CURRENT_TIMESTAMP),
('SO-002','SO-KE-10002','AFF-KE','BU-CI','ACC-002','2026-08-25 08:30:00','KES',1725000,1,1,'Credit limit exceeded',NULL,NULL,NULL,NULL,'PENDING_CREDIT',NULL,CURRENT_TIMESTAMP),
('SO-003','SO-KE-10003','AFF-KE','BU-RET','ACC-004','2026-08-25 09:00:00','KES',805000,1,0,NULL,'INV-10003','2026-08-25 10:05:00','2026-08-25 10:10:00',NULL,'LOADING',NULL,CURRENT_TIMESTAMP),
('SO-004','SO-KE-10004','AFF-KE','BU-CI','ACC-001','2026-08-26 07:45:00','KES',460000,1,0,NULL,NULL,NULL,NULL,NULL,'PENDING_FINANCE',NULL,CURRENT_TIMESTAMP),
('SO-005','SO-KE-10005','AFF-KE','BU-CI','ACC-002','2026-08-26 08:10:00','KES',920000,1,1,'Credit days exceeded',NULL,NULL,NULL,NULL,'PENDING_CREDIT',NULL,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO sales_order_lines VALUES
('SOL-001','SO-001',1,'PROD-AGO',10000,115,1150000),
('SOL-002','SO-002',1,'PROD-AGO',15000,115,1725000),
('SOL-003','SO-003',1,'PROD-PMS',7000,115,805000),
('SOL-004','SO-004',1,'PROD-AGO',4000,115,460000),
('SOL-005','SO-005',1,'PROD-AGO',8000,115,920000);

-- Named columns rather than the operator's positional VALUES: the
-- source-completeness script added submitted_for_approval_at, which the
-- operator's earlier seed rows predate, so they name what they carry and the
-- new column stays NULL on all five, exactly as it would on the live rows.
INSERT OR IGNORE INTO purchase_orders
(purchase_order_id, document_number, affiliate_id, business_unit_id, supplier_name,
 po_created_at, currency_code, po_value, physical_received_at, oracle_stock_posted_at,
 status, latest_snapshot_id, created_at) VALUES
('PO-001','PO-KE-20001','AFF-KE','BU-CI','Demo Supplier Alpha','2026-08-24 07:30:00','USD',220000,'2026-08-25 06:00:00','2026-08-25 07:20:00','POSTED',NULL,CURRENT_TIMESTAMP),
('PO-002','PO-KE-20002','AFF-KE','BU-RET','Demo Supplier Beta','2026-08-24 08:00:00','USD',175000,NULL,NULL,'IN_APPROVAL',NULL,CURRENT_TIMESTAMP),
('PO-003','PO-KE-20003','AFF-KE','BU-AV','Demo Supplier Gamma','2026-08-24 08:30:00','USD',95000,'2026-08-25 08:30:00',NULL,'RECEIVED',NULL,CURRENT_TIMESTAMP),
('PO-004','PO-KE-20004','AFF-KE','BU-LPG','Demo Supplier Delta','2026-08-25 09:00:00','USD',48000,NULL,NULL,'APPROVED',NULL,CURRENT_TIMESTAMP),
('PO-005','PO-KE-20005','AFF-KE','BU-CI','Demo Supplier Epsilon','2026-08-26 07:50:00','USD',130000,NULL,NULL,'CREATED',NULL,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO purchase_order_lines VALUES
('POL-001','PO-001',1,'PROD-AGO',200000,1.10,220000),
('POL-002','PO-002',1,'PROD-PMS',140000,1.25,175000),
('POL-003','PO-003',1,'PROD-JET',76000,1.25,95000),
('POL-004','PO-004',1,'PROD-LPG',40000,1.20,48000),
('POL-005','PO-005',1,'PROD-AGO',118181.82,1.10,130000);

INSERT OR IGNORE INTO workflow_instances VALUES
('WFI-001','WFD-001','SALES_ORDER','SO-001','COMPLETED','2026-08-25 08:00:00','2026-08-25 10:15:00','WST-003',CURRENT_TIMESTAMP),
('WFI-002','WFD-001','SALES_ORDER','SO-002','IN_PROGRESS','2026-08-25 08:30:00',NULL,'WST-002',CURRENT_TIMESTAMP),
('WFI-003','WFD-002','PURCHASE_ORDER','PO-002','IN_PROGRESS','2026-08-24 08:00:00',NULL,'WST-005',CURRENT_TIMESTAMP),
('WFI-004','WFD-003','LEAD','LEAD-001','COMPLETED','2026-08-12 08:20:00','2026-08-12 12:00:00','WST-008',CURRENT_TIMESTAMP),
('WFI-005','WFD-004','CASE','CASE-002','IN_PROGRESS','2026-08-25 09:15:00',NULL,'WST-010',CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO workflow_stage_instances VALUES
('WSI-001','WFI-001','WST-001','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-25 08:00:00','2026-08-25 08:05:00','2026-08-25 08:42:00','Approved'),
('WSI-002','WFI-002','WST-002','USR-VIC','TEAM-CRD-GRP','ACTIVE','2026-08-25 09:10:00','2026-08-25 09:12:00',NULL,'Credit limit exception under review'),
('WSI-003','WFI-003','WST-005','USR-GAB','TEAM-FIN-KE','ACTIVE','2026-08-24 09:00:00','2026-08-24 09:15:00',NULL,'Finance approval pending'),
('WSI-004','WFI-004','WST-007','USR-JAM','TEAM-SALES-KE','COMPLETED','2026-08-12 08:20:00','2026-08-12 08:30:00','2026-08-12 09:05:00','Customer contacted'),
('WSI-005','WFI-005','WST-010','USR-CATH','TEAM-CS-KE','ACTIVE','2026-08-25 09:40:00','2026-08-25 09:45:00',NULL,'Customer service resolution tracking');

INSERT OR IGNORE INTO workflow_stage_assignees VALUES
('WSA-001','WSI-001','USR-GAB','WRA-001',1,1,'APPROVED','2026-08-25 08:00:00','2026-08-25 08:42:00','APPROVE','Finance approved'),
('WSA-002','WSI-002','USR-VIC','WRA-009',1,1,'ACTIVE','2026-08-25 09:10:00',NULL,NULL,'Credit limit exception under review'),
('WSA-003','WSI-003','USR-GAB','WRA-005',1,1,'ACTIVE','2026-08-24 09:00:00',NULL,NULL,'PO finance approval pending'),
('WSA-004','WSI-004','USR-JAM',NULL,1,1,'COMPLETED','2026-08-12 08:20:00','2026-08-12 09:05:00','COMPLETE','Customer contacted'),
('WSA-005','WSI-005','USR-CATH','WRA-010',1,1,'ACTIVE','2026-08-25 09:40:00',NULL,NULL,'Customer service resolution tracking');

INSERT OR IGNORE INTO sla_instances VALUES
('SLAI-001','SLAR-003','SALES_ORDER','SO-001','WSI-001','USR-GAB','TEAM-FIN-KE','2026-08-25 08:00:00','2026-08-25 09:00:00','2026-08-25 08:45:00','2026-08-25 08:42:00',0,'MET',NULL),
('SLAI-002','SLAR-004','SALES_ORDER','SO-002','WSI-002','USR-VIC','TEAM-CRD-GRP','2026-08-25 09:10:00','2026-08-25 11:10:00','2026-08-25 10:40:00',NULL,0,'BREACHED','2026-08-25 11:10:00'),
('SLAI-003','SLAR-005','PURCHASE_ORDER','PO-002','WSI-003','USR-GAB','TEAM-FIN-KE','2026-08-24 09:00:00','2026-08-24 12:00:00','2026-08-24 11:30:00',NULL,0,'BREACHED','2026-08-24 12:00:00'),
('SLAI-004','SLAR-002','LEAD','LEAD-001','WSI-004','USR-JAM','TEAM-SALES-KE','2026-08-12 08:20:00','2026-08-12 10:20:00','2026-08-12 09:50:00','2026-08-12 09:05:00',0,'MET',NULL),
('SLAI-005','SLAR-001','CASE','CASE-002','WSI-005','USR-CATH','TEAM-CS-KE','2026-08-25 09:15:00','2026-08-25 10:15:00','2026-08-25 10:00:00','2026-08-25 09:35:00',0,'MET',NULL);

INSERT OR IGNORE INTO sla_timer_events VALUES
('SLATE-001','SLAI-001','START','2026-08-25 08:00:00','SO finance SLA started','USR-GAB'),
('SLATE-002','SLAI-001','STOP','2026-08-25 08:42:00','Finance approved','USR-GAB'),
('SLATE-003','SLAI-002','BREACH','2026-08-25 11:10:00','Credit approval SLA exceeded','USR-VIC'),
('SLATE-004','SLAI-004','STOP','2026-08-12 09:05:00','Lead contacted','USR-JAM'),
('SLATE-005','SLAI-005','STOP','2026-08-25 09:35:00','First response sent','USR-CATH');

INSERT OR IGNORE INTO import_batches VALUES
('IMP-001','SRC-EXCEL','SALES_ORDER','SO-Aug-25.xlsx','demo_sha_so_001','USR-CATH','2026-08-25 17:00:00','2026-08-01','2026-08-25',500,470,20,8,2,'IMPORTED'),
('IMP-002','SRC-EXCEL','PURCHASE_ORDER','PO-Aug-25.xlsx','demo_sha_po_002','USR-CATH','2026-08-25 17:10:00','2026-08-01','2026-08-25',120,110,5,5,0,'IMPORTED'),
('IMP-003','SRC-WEB','LEAD','web-leads-20260825.json','demo_sha_lead_003','USR-CATH','2026-08-25 17:20:00','2026-08-25','2026-08-25',12,12,0,0,0,'IMPORTED'),
('IMP-004','SRC-EMAIL','CASE','customer-service-20260825.json','demo_sha_case_004','USR-CATH','2026-08-25 17:30:00','2026-08-25','2026-08-25',18,18,0,0,0,'IMPORTED'),
('IMP-005','SRC-MANUAL','CONTACT','manual-contact-seed.json','demo_sha_contact_005','USR-CATH','2026-08-25 17:40:00','2026-08-25','2026-08-25',5,5,0,0,0,'IMPORTED');

INSERT OR IGNORE INTO import_rows VALUES
('IR-001','IMP-001',2,'SO-KE-10001','SALES_ORDER','SO-001','rowhash-so-1','NEW',NULL,'{"document_number":"SO-KE-10001"}','2026-08-25 17:01:00'),
('IR-002','IMP-002',2,'PO-KE-20001','PURCHASE_ORDER','PO-001','rowhash-po-1','NEW',NULL,'{"document_number":"PO-KE-20001"}','2026-08-25 17:11:00'),
('IR-003','IMP-003',1,'LD-2026-0001','LEAD','LEAD-001','rowhash-lead-1','NEW',NULL,'{"lead_number":"LD-2026-0001"}','2026-08-25 17:21:00'),
('IR-004','IMP-004',1,'CS-2026-0001','CASE','CASE-001','rowhash-case-1','NEW',NULL,'{"case_number":"CS-2026-0001"}','2026-08-25 17:31:00'),
('IR-005','IMP-005',1,'CON-001','CONTACT','CON-001','rowhash-contact-1','NEW',NULL,'{"contact_id":"CON-001"}','2026-08-25 17:41:00');

INSERT OR IGNORE INTO record_snapshots VALUES
('SNAP-001','SALES_ORDER','SO-001','IMP-001','SO-KE-10001',1,'rowhash-so-1','{"status":"LOADED","document_number":"SO-KE-10001"}','2026-08-25 17:01:00',1),
('SNAP-002','PURCHASE_ORDER','PO-001','IMP-002','PO-KE-20001',1,'rowhash-po-1','{"status":"POSTED","document_number":"PO-KE-20001"}','2026-08-25 17:11:00',1),
('SNAP-003','LEAD','LEAD-001','IMP-003','LD-2026-0001',1,'rowhash-lead-1','{"status":"QUALIFIED","lead_number":"LD-2026-0001"}','2026-08-25 17:21:00',1),
('SNAP-004','CASE','CASE-001','IMP-004','CS-2026-0001',1,'rowhash-case-1','{"status":"IN_PROGRESS","case_number":"CS-2026-0001"}','2026-08-25 17:31:00',1),
('SNAP-005','CONTACT','CON-001','IMP-005','CON-001',1,'rowhash-contact-1','{"full_name":"John Kamau"}','2026-08-25 17:41:00',1);

INSERT OR IGNORE INTO unresolved_actors VALUES
('UAQ-001','IMP-001','SRC-ORACLE','UNKNOWN.APPROVER1','AFF-KE','OPEN',NULL,NULL,NULL,'Needs mapping to a user with verified email'),
('UAQ-002','IMP-002','SRC-ORACLE','UNKNOWN.APPROVER2','AFF-KE','OPEN',NULL,NULL,NULL,'Needs mapping before workflow attribution'),
('UAQ-003','IMP-001','SRC-ORACLE','LEGACY.USER1','AFF-KE','IGNORED',NULL,'USR-CATH','2026-08-25 18:00:00','Legacy system technical account'),
('UAQ-004','IMP-002','SRC-ORACLE','GABRIEL.MUSEMBI','AFF-KE','MAPPED','USR-GAB','USR-CATH','2026-08-25 18:02:00','Mapped to finance manager'),
('UAQ-005','IMP-001','SRC-ORACLE','VICTOR.NJOROGE','AFF-KE','MAPPED','USR-VIC','USR-CATH','2026-08-25 18:03:00','Mapped to credit manager');

INSERT OR IGNORE INTO file_objects VALUES
('FILE-001','SO-Aug-25.xlsx','imports/2026/08/SO-Aug-25.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',125000,'demo_sha_so_001','USR-CATH','2026-08-25 17:00:00'),
('FILE-002','PO-Aug-25.xlsx','imports/2026/08/PO-Aug-25.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',78000,'demo_sha_po_002','USR-CATH','2026-08-25 17:10:00'),
('FILE-003','EastGate-Proposal.pdf','crm/opportunities/OPP-001/EastGate-Proposal.pdf','application/pdf',310000,'demo_file_003','USR-JAM','2026-08-18 09:50:00'),
('FILE-004','Invoice-Dispute.pdf','cases/CASE-002/Invoice-Dispute.pdf','application/pdf',85000,'demo_file_004','USR-CATH','2026-08-25 09:20:00'),
('FILE-005','Product-Catalogue.pdf','crm/catalogue/Product-Catalogue.pdf','application/pdf',950000,'demo_file_005','USR-CATH','2026-08-22 15:10:00');

-- Named columns, because the operator's portal script adds customer_visible
-- and portal_document_title to this table and a positional insert would
-- break the day it runs.
INSERT OR IGNORE INTO entity_attachments
(entity_attachment_id, file_id, entity_type, entity_id, attachment_type,
 attached_by_user_id, attached_at) VALUES
('EA-001','FILE-001','SALES_ORDER','SO-001','SOURCE_UPLOAD','USR-CATH','2026-08-25 17:00:00'),
('EA-002','FILE-002','PURCHASE_ORDER','PO-001','SOURCE_UPLOAD','USR-CATH','2026-08-25 17:10:00'),
('EA-003','FILE-003','OPPORTUNITY','OPP-001','PROPOSAL','USR-JAM','2026-08-18 09:50:00'),
('EA-004','FILE-004','CASE','CASE-002','CUSTOMER_EVIDENCE','USR-CATH','2026-08-25 09:20:00'),
('EA-005','FILE-005','ACTIVITY','ACT-005','CATALOGUE','USR-CATH','2026-08-22 15:10:00');

INSERT OR IGNORE INTO notifications VALUES
('NOT-001','USR-VIC','SLA_BREACH','Credit SLA breached','SO-KE-10002 has exceeded the credit approval SLA.','SALES_ORDER','SO-002','2026-08-25 11:10:00',NULL),
('NOT-002','USR-ZUL','SLA_BREACH','PO approval overdue','PO-KE-20002 is overdue at Finance Approval.','PURCHASE_ORDER','PO-002','2026-08-24 12:00:00',NULL),
('NOT-003','USR-JAM','FOLLOW_UP','Lead follow-up due','Riftline additional AGO follow-up is due.','LEAD','LEAD-004','2026-08-26 08:00:00',NULL),
('NOT-004','USR-GAB','ASSIGNMENT','New case assigned','Invoice discrepancy case CS-2026-0002 is assigned to you.','CASE','CASE-002','2026-08-25 09:40:00','2026-08-25 09:42:00'),
('NOT-005','USR-CATH','IMPORT_EXCEPTION','Unresolved import actors','Two Oracle usernames require mapping.','IMPORT_BATCH','IMP-001','2026-08-25 17:05:00',NULL);
`;

/**
 * Load the operator's seed into a test database.
 *
 * Statement by statement rather than one `exec`, so a failing row names itself
 * instead of the whole block failing as one.
 */
/**
 * Split the seed into statements, respecting quoted values and line comments.
 *
 * A naive split on ";\n" was enough while every seeded value was a code or a
 * name. It stops being enough at lead_qualifications, whose notes read
 * "Budget confirmed; decision maker engaged" and contain exactly the character
 * the splitter looked for. The result was an unterminated string literal and a
 * SQL logic error two hundred rows into the seed.
 *
 * So a boundary is a semicolon that is neither inside a single-quoted string
 * nor inside a line comment.
 *
 * SQLite escapes a quote by doubling it, and that needs no special case: the
 * second quote of a doubled pair flips the state back, so a value like
 * 'it''s' opens, closes, opens and closes again, ending outside a string
 * exactly as it should.
 *
 * Line comments are skipped for the mirror-image reason. The comment blocks in
 * this file are English, English is full of apostrophes, and an unpaired one in
 * "the operator's schema" would otherwise open a string that swallowed every
 * boundary until the next apostrophe came along.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inString = false;
  let inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (!inString && ch === '-' && sql[i + 1] === '-') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = !inString;
    } else if (ch === ';' && !inString) {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  const tail = sql.slice(start);
  if (tail.trim() !== '') statements.push(tail);
  return statements;
}

export async function seedHass(db: TestClient): Promise<void> {
  for (const statement of splitStatements(SEED_SQL)) {
    const sql = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (sql === '') continue;
    await db.execute(sql);
  }
}
