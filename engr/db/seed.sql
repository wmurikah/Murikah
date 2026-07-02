-- ============================================================================
-- ENGINEERING RHYTHM  (Murikah Labs)  global seed
-- Loads the product catalogue that every tenant shares: subscription plans,
-- the permission registry, and the nine system roles with baseline grants.
-- Safe to re-run. Tenant data (organisations, users, stations) is created by
-- the app at signup, not here.
--
--   turso db shell engineering-rhythm < seed.sql
-- ============================================================================

PRAGMA foreign_keys = ON;

-- Guard so system roles (org_id IS NULL) are unique and INSERT OR IGNORE works.
CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_system ON roles(code) WHERE org_id IS NULL;

-- ---------------------------------------------------------------------------
-- Subscription plans. Prices are KES minor units (cents). Adjust freely.
-- features_json flags gate product capability by tier.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO plans
  (code, name, description, price_monthly_minor, price_annual_minor, currency,
   max_stations, max_users, max_contractors, features_json, sort_order)
VALUES
  ('TRIAL','Trial','14 day evaluation',0,0,'KES',3,10,5,
   json('{"rfq":true,"pm_automation":true,"mileage_lpo":true,"multi_level_billing":true,"api_access":false,"sso":false}'),0),
  ('STARTER','Starter','Predefined-rate assignment, manual PM, single-site teams',
   2500000,25500000,'KES',5,25,25,
   json('{"rfq":false,"pm_automation":false,"mileage_lpo":false,"multi_level_billing":true,"api_access":false,"sso":false}'),1),
  ('GROWTH','Growth','Adds RFQ, automated PM and multi-station LPO with mileage',
   6000000,61200000,'KES',25,150,150,
   json('{"rfq":true,"pm_automation":true,"mileage_lpo":true,"multi_level_billing":true,"api_access":true,"sso":false}'),2),
  ('ENTERPRISE','Enterprise','Unlimited scale, SSO and API, priced on application',
   0,0,'KES',NULL,NULL,NULL,
   json('{"rfq":true,"pm_automation":true,"mileage_lpo":true,"multi_level_billing":true,"api_access":true,"sso":true}'),3);

-- ---------------------------------------------------------------------------
-- Permission registry.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (key, module, description) VALUES
  ('org.view','org','View organisation profile'),
  ('org.manage','org','Manage organisation profile and subscription'),
  ('users.view','users','View users'),
  ('users.manage','users','Create and manage users'),
  ('roles.view','roles','View roles'),
  ('roles.manage','roles','Create and manage roles'),
  ('stations.view','stations','View stations'),
  ('stations.manage','stations','Create and manage stations'),
  ('assets.view','assets','View assets'),
  ('assets.manage','assets','Create and manage assets'),
  ('contractors.view','contractors','View contractors'),
  ('contractors.manage','contractors','Create and manage contractors'),
  ('technicians.view','technicians','View technicians'),
  ('technicians.manage','technicians','Assign technicians to work'),
  ('slas.view','slas','View SLAs'),
  ('slas.manage','slas','Create and manage SLAs'),
  ('rates.view','rates','View rate cards'),
  ('rates.manage','rates','Create and manage rate cards'),
  ('requests.view','requests','View service requests'),
  ('requests.create','requests','Raise a service request'),
  ('requests.accept','requests','Accept a service request'),
  ('requests.reject','requests','Reject a service request'),
  ('rfq.view','rfq','View RFQs'),
  ('rfq.create','rfq','Create an RFQ and invite contractors'),
  ('rfq.award','rfq','Select a quote and award work'),
  ('quotes.view','quotes','View quotes'),
  ('quotes.submit','quotes','Submit a quote against an RFQ'),
  ('quotes.select','quotes','Select the winning quote'),
  ('pm.view','pm','View preventive maintenance schedules'),
  ('pm.manage','pm','Create and manage PM schedules'),
  ('pm.allocate','pm','Allocate a contractor to a PM occurrence'),
  ('workorder.view','workorder','View work orders'),
  ('workorder.create','workorder','Create a work order'),
  ('workorder.assign','workorder','Assign a contractor to a work order'),
  ('workorder.accept','workorder','Accept assigned work'),
  ('workorder.close','workorder','Close a work order'),
  ('jsa.submit','jsa','Submit a job safety analysis'),
  ('arrival.confirm','arrival','Confirm technician arrival on site'),
  ('jobcard.view','jobcard','View job cards'),
  ('jobcard.create','jobcard','Create and fill a job card'),
  ('jobcard.submit','jobcard','Request closure confirmation'),
  ('jobcard.confirm','jobcard','Confirm resolution and job card'),
  ('cost.view','cost','View work costs'),
  ('cost.create','cost','Create and cost completed work'),
  ('cost.submit','cost','Submit a cost for approval'),
  ('cost.approve.l1','cost','Approve a cost at level 1'),
  ('cost.approve.l2','cost','Approve a cost at level 2'),
  ('bill.view','bill','View bills'),
  ('bill.create','bill','Create a bill from approved costs'),
  ('bill.submit','bill','Submit a bill for approval'),
  ('bill.approve.l1','bill','Approve a bill at level 1 (Engineer)'),
  ('bill.approve.l2','bill','Approve a bill at level 2 (Engineering Manager)'),
  ('bill.approve.l3','bill','Approve a bill at level 3 (Financial Controller)'),
  ('payment.view','payment','View payments'),
  ('payment.record','payment','Record a payment against a bill'),
  ('reports.view','reports','View reports and dashboards'),
  ('settings.view','settings','View settings'),
  ('settings.manage','settings','Manage settings');

-- ---------------------------------------------------------------------------
-- System roles (org_id NULL). Tenants may add custom roles later.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (org_id, code, name, description, is_system) VALUES
  (NULL,'OWNER','Owner','Full control of the organisation account',1),
  (NULL,'ADMIN','Administrator','Full operational and administrative access',1),
  (NULL,'ENGINEERING_MANAGER','Engineering Manager','Oversight, level 2 cost and bill approval',1),
  (NULL,'ENGINEER','Engineer','Request triage, assignment, RFQ, level 1 approval',1),
  (NULL,'STATION_MANAGER','Station Manager','Raise requests, confirm arrival and closure',1),
  (NULL,'FINANCIAL_CONTROLLER','Financial Controller','Level 3 bill approval and payments',1),
  (NULL,'CONTRACTOR','Contractor','Accept work, assign technicians, cost and bill',1),
  (NULL,'TECHNICIAN','Technician','Execute work, submit JSA and job cards',1),
  (NULL,'VIEWER','Viewer','Read-only access',1);

-- ---------------------------------------------------------------------------
-- Role to permission grants.
-- ---------------------------------------------------------------------------

-- OWNER and ADMIN get everything.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.code IN ('OWNER','ADMIN');

-- VIEWER gets every read permission.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.key LIKE '%.view'
WHERE r.org_id IS NULL AND r.code = 'VIEWER';

-- ENGINEERING_MANAGER: all views plus full operational and L1 or L2 approvals.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key LIKE '%.view'
  OR p.key IN ('requests.accept','requests.reject','rfq.create','rfq.award',
               'quotes.select','pm.manage','pm.allocate','workorder.create',
               'workorder.assign','workorder.close','arrival.confirm','jobcard.confirm',
               'cost.approve.l1','cost.approve.l2','bill.approve.l1','bill.approve.l2',
               'reports.view')
WHERE r.org_id IS NULL AND r.code = 'ENGINEERING_MANAGER';

-- ENGINEER: triage, assignment, RFQ, PM, L1 approvals.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key LIKE '%.view'
  OR p.key IN ('requests.accept','requests.reject','rfq.create','rfq.award',
               'quotes.select','pm.manage','pm.allocate','workorder.create',
               'workorder.assign','workorder.close','cost.approve.l1','bill.approve.l1')
WHERE r.org_id IS NULL AND r.code = 'ENGINEER';

-- STATION_MANAGER: raise requests, confirm arrival and closure.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key IN ('stations.view','assets.view','requests.view','requests.create',
               'workorder.view','arrival.confirm','jobcard.view','jobcard.confirm')
WHERE r.org_id IS NULL AND r.code = 'STATION_MANAGER';

-- FINANCIAL_CONTROLLER: views, L3 bill approval, payments, reports.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key LIKE '%.view'
  OR p.key IN ('bill.approve.l3','payment.record','reports.view')
WHERE r.org_id IS NULL AND r.code = 'FINANCIAL_CONTROLLER';

-- CONTRACTOR: accept work, assign technicians, quote, cost, bill.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key IN ('workorder.view','workorder.accept','technicians.view','technicians.manage',
               'quotes.view','quotes.submit','cost.view','cost.create','cost.submit',
               'bill.view','bill.create','bill.submit')
WHERE r.org_id IS NULL AND r.code = 'CONTRACTOR';

-- TECHNICIAN: accept work, submit JSA and job cards.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p
  ON p.key IN ('workorder.view','workorder.accept','jsa.submit',
               'jobcard.view','jobcard.create','jobcard.submit')
WHERE r.org_id IS NULL AND r.code = 'TECHNICIAN';

-- End of seed.
