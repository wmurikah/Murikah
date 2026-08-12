/**
 * Demo seed for the smoke database: one active organisation on a full-feature
 * plan, the seeded sign-in user (a platform-owner SUPER_ADMIN, so every screen
 * and workflow action is reachable), the instance admin beside them (the same
 * SUPER_ADMIN role inside Hass, pinned to it, so the smoke run can prove the two
 * kinds of user apart), a second organisation to enter and leave, the
 * data-driven workflow reference rows (enum_values, status_transitions,
 * workflow_terminal_states), and one of everything the pages drill into: a
 * draft work paper, one sent to the auditee, action plans in mid-lifecycle
 * states, a response, notifications and activity. IDs are fixed and exported so
 * the smoke test can address detail routes and mutations deterministically.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
// The permission modules and actions come from the one catalogue the product
// itself enforces, never a hand-kept copy: two lists drifting apart is exactly
// what made every role save violate a foreign key and fail (Build Prompt 43).
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PLATFORM_DEFAULT_ORG,
} from '../../../src/lib/grc/auth/permissionModules.ts';
// The same sealed box the worker opens, so the seeded storage connection is a
// real one the running app can read rather than a shape that only looks right.
import { seal } from '../../../src/lib/grc/auth/secretBox.ts';

/**
 * The session secret the harness starts the worker with. It is here rather than
 * in the harness because the seed has to seal with the very same key the worker
 * unseals with; two copies of a secret that must match is exactly the drift
 * worth designing out.
 */
export const SMOKE_SESSION_SECRET = Buffer.from('grc-smoke-harness-session-secret').toString(
  'base64',
);

export const SMOKE = {
  orgId: 'ORG-HASS',
  orgName: 'Hass Petroleum Group',
  otherOrgId: 'ORG-COAST',
  otherOrgName: 'Coast Energy Limited',
  // The platform owner (Murikah Labs), who is pinned to no organisation and
  // enters an instance to work inside it.
  email: 'wmurikah@gmail.com',
  password: 'Grc-Smoke-Harness-2026',
  userId: 'USR-WM',
  // The Hass instance admin: the same SUPER_ADMIN role, pinned to Hass, with no
  // platform view and no switcher.
  instanceAdminEmail: 'wilberforce.murikah@hasspetroleum.com',
  instanceAdminId: 'USR-HASS-ADMIN',
  auditorId: 'USR-AUD',
  auditeeId: 'USR-OWN',
  lockoutUserId: 'USR-LOCK',
  // A user in the other organisation, so the smoke run can prove an email is
  // unique across the whole platform and not merely within one instance.
  otherOrgUserEmail: 'coast.admin@coastenergy.example',
  otherOrgUserId: 'USR-COAST',
  affiliateCode: 'HKL',
  // Hass has an evidence storage connection; Coast deliberately has none, so
  // the smoke run can prove the provider is resolved per organisation and that
  // an unconfigured organisation is told so rather than silently failing at the
  // moment of upload (Build Prompt 51).
  storageProvider: 'r2',
  storageBucket: 'hass-evidence',
  storageFolder: 'audit-evidence',
  // A second affiliate, and a finding inside it, so affiliate confinement has
  // something real to exclude (Build Prompt 45). Without a second affiliate a
  // confined viewer would see everything anyway and the test would prove nothing.
  otherAffiliateCode: 'HPL',
  otherAffiliateWorkPaperId: 'WP-HPL-1',
  // A role confined to its user's affiliate, and two users in it: one with an
  // affiliate, one with none. The second is the state that must refuse rather
  // than quietly show an empty list.
  confinedRole: 'AFFILIATE_LEAD',
  confinedUserId: 'USR-AFF-LEAD',
  confinedUserEmail: 'lead.hkl@hasspetroleum.com',
  unassignedUserId: 'USR-AFF-NONE',
  unassignedUserEmail: 'lead.none@hasspetroleum.com',
  // The Group affiliate and a user posted to it. Same confined role as the pair
  // above, so the only difference between them is affiliates.is_group, which is
  // what makes the exemption test mean something (Build Prompt 48).
  groupAffiliateCode: 'GRP',
  groupUserId: 'USR-AFF-GROUP',
  groupUserEmail: 'lead.group@hasspetroleum.com',
  auditAreaId: 'AA-FIN',
  subAreaId: 'SA-TREAS',
  draftWorkPaperId: 'WP-DRAFT-1',
  sentWorkPaperId: 'WP-SENT-1',
  requirementId: 'REQ-1',
  // A second requirement, already received, so the smoke run can prove
  // outstanding and received apart on one screen (Build Prompt 52). One state
  // alone would pass whatever the page rendered.
  receivedRequirementId: 'REQ-2',
  actionPlanId: 'AP-PROG-1',
  orphanPlanId: 'AP-ORPHAN-1',
  verifyActionPlanId: 'AP-VERIFY-1',
  responseId: 'RESP-1',
  notificationId: 'NQ-1',
  attachmentId: 'ATT-MISSING',
  heldAttachmentId: 'ATT-HELD',
  freeAttachmentId: 'ATT-FREE',
  heldFileId: 'FILE-HELD',
  freeFileId: 'FILE-FREE',
  driveFileId: 'FILE-DRIVE',
  // A third organisation whose access control has never been edited: it holds
  // no `role_permissions` rows of its own, so every grant its roles have is
  // inherited from the GLOBAL platform default (Build Prompt 57). Hass starts
  // in that state too, but the access-control save later in the run gives it
  // rows of its own, so an organisation that stays inheriting to the end is
  // what proves the submit guard resolves the fallback rather than reading the
  // acting organisation's rows alone. It is deliberately never saved, never
  // switched into and never provisioned.
  inheritOrgId: 'ORG-TANA',
  inheritOrgName: 'Tana Energy Limited',
  inheritAffiliateCode: 'TNA',
  inheritAuditAreaId: 'AA-TANA',
  inheritSubAreaId: 'SA-TANA',
  inheritAuditorId: 'USR-TANA-AUD',
  inheritAuditorEmail: 'auditor@tanaenergy.example',
  // One draft to submit on its own, and two to release together.
  inheritDraftIds: ['WP-TANA-1', 'WP-TANA-2', 'WP-TANA-3'],
} as const;

/**
 * The enum_type the live database keys the work-paper workflow by, in the live
 * spelling (Build Prompt 61).
 */
const LIVE_WP_ENUM = 'work_paper_status';

/** The other workflow in the same table that also defines Draft -> Submitted. */
const RESPONSE_ENUM = 'response_status';

/** The same workflow, spelled as a hand-edited reference row may spell it. */
const MIXED_CASE_WP_ENUM = 'Work_Paper_Status';

const WP_STATUSES = [
  'Draft',
  'Submitted',
  'Under Review',
  'Approved',
  'Sent to Auditee',
  'Response Received',
  'Response Reviewed',
  'Revision Required',
];

const AP_STATUSES = [
  'Not Due',
  'Pending',
  'In Progress',
  'Overdue',
  'Implemented',
  'Pending Verification',
  'Verified',
  'Closed',
  'Rejected',
];

// Chained pairs cover the forward lifecycle; the loops cover rework paths. No
// required_role, so the engine gates on the catalogue permission alone.
const WP_TRANSITIONS: [string, string][] = [
  ['Draft', 'Submitted'],
  ['Submitted', 'Under Review'],
  ['Under Review', 'Approved'],
  ['Under Review', 'Revision Required'],
  ['Revision Required', 'Submitted'],
  ['Approved', 'Sent to Auditee'],
  ['Sent to Auditee', 'Response Received'],
  ['Response Received', 'Response Reviewed'],
  // Requesting changes reopens the finding to the auditee for the next round.
  ['Response Received', 'Sent to Auditee'],
];

const AP_TRANSITIONS: [string, string][] = [
  ['Not Due', 'Pending'],
  ['Pending', 'In Progress'],
  ['In Progress', 'Implemented'],
  ['In Progress', 'Pending Verification'],
  ['Implemented', 'Pending Verification'],
  ['Overdue', 'In Progress'],
  ['Pending Verification', 'Verified'],
  ['Pending Verification', 'In Progress'],
  ['Verified', 'Closed'],
  ['Verified', 'Rejected'],
];

const ROLES: [string, string][] = [
  ['SUPER_ADMIN', 'Super Administrator'],
  ['HEAD_OF_AUDIT', 'Head of Audit'],
  ['SENIOR_AUDITOR', 'Senior Auditor'],
  ['AUDITOR', 'Auditor'],
  ['BOARD_MEMBER', 'Board Member'],
  ['SENIOR_MGMT', 'Senior Management'],
  ['UNIT_MANAGER', 'Unit Manager'],
  ['JUNIOR_STAFF', 'Junior Staff'],
  ['AFFILIATE_LEAD', 'Affiliate Lead'],
];

const MODULES = PERMISSION_MODULES.map((m) => m.code);

const ACTIONS = PERMISSION_ACTIONS.map((a) => a.code);

/** A stored hash in the exact seeded format (pbkdf2$iterations$salt$hash). */
export function seedPasswordHash(plain: string): string {
  const iterations = 10000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(plain, salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function insert(db: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...keys.map((k) => row[k] as null | number | string));
}

export async function seedDatabase(db: DatabaseSync, s3Origin = ''): Promise<void> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  for (const [orgId, code, name] of [
    [SMOKE.orgId, 'HASS', SMOKE.orgName],
    [SMOKE.otherOrgId, 'COAST', SMOKE.otherOrgName],
    [SMOKE.inheritOrgId, 'TANA', SMOKE.inheritOrgName],
  ] as const) {
    insert(db, 'organizations', {
      organization_id: orgId,
      org_code: code,
      org_name: name,
      country: 'KE',
      timezone: 'Africa/Nairobi',
      is_active: 1,
      created_at: now,
    });
  }
  // The platform-default sentinel, inactive so it never appears in a list or the
  // switcher. The platform-default permission grants hang off it, along with the
  // platform-wide config rows.
  insert(db, 'organizations', {
    organization_id: PLATFORM_DEFAULT_ORG,
    org_code: PLATFORM_DEFAULT_ORG,
    org_name: 'Platform (global configuration)',
    is_active: 0,
    created_at: now,
  });

  insert(db, 'plans', {
    plan_code: 'ENTERPRISE',
    name: 'Enterprise',
    features_json: JSON.stringify({
      ai: true,
      ai_assistance: true,
      board_reporting: true,
      notifications: true,
      evidence: true,
    }),
    is_active: 1,
    created_at: now,
  });
  for (const orgId of [SMOKE.orgId, SMOKE.otherOrgId, SMOKE.inheritOrgId]) {
    insert(db, 'subscriptions', {
      subscription_id: `SUB-${orgId}`,
      organization_id: orgId,
      plan_code: 'ENTERPRISE',
      status: 'ACTIVE',
      created_at: now,
    });
  }

  for (const [code, name] of ROLES) {
    insert(db, 'roles', { role_code: code, role_name: name, is_system: 1, created_at: now });
  }
  for (const module of PERMISSION_MODULES) {
    insert(db, 'permission_modules', {
      module_code: module.code,
      module_name: module.name,
      description: module.description,
    });
  }
  for (const action of PERMISSION_ACTIONS) {
    insert(db, 'permission_actions', { action_code: action.code, action_name: action.name });
  }
  // The grants are seeded as PLATFORM DEFAULTS, under the sentinel, and Hass is
  // given none of its own. That is the state a live database is in the moment
  // after migration 001 runs, so the smoke run exercises the inheritance path on
  // every page load rather than only the own-rows path: a full grant for the
  // admin role and a read-heavy grant for auditors, so the access-control screen
  // has a real matrix to render and save.
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      insert(db, 'role_permissions', {
        organization_id: PLATFORM_DEFAULT_ORG,
        role_code: 'SUPER_ADMIN',
        module_code: module,
        action_code: action,
        is_allowed: 1,
        scope_to_affiliate: 0,
      });
      insert(db, 'role_permissions', {
        organization_id: PLATFORM_DEFAULT_ORG,
        role_code: 'AUDITOR',
        module_code: module,
        action_code: action,
        is_allowed: action === 'read' || action === 'create' || action === 'update' ? 1 : 0,
        scope_to_affiliate: 0,
      });
    }
  }
  // The auditee role: read findings (the list is row-scoped to their own),
  // respond, and read their action plans. No CONFIG or USER grant, so the
  // central page map keeps them out of settings and the send queue.
  for (const [module, action] of [
    ['WORK_PAPER', 'read'],
    ['ACTION_PLAN', 'read'],
    ['AUDITEE_RESPONSE', 'read'],
    ['AUDITEE_RESPONSE', 'create'],
  ] as const) {
    insert(db, 'role_permissions', {
      organization_id: PLATFORM_DEFAULT_ORG,
      role_code: 'UNIT_MANAGER',
      module_code: module,
      action_code: action,
      is_allowed: 1,
      scope_to_affiliate: 0,
    });
  }
  // Hass's own grants for the confined role (Build Prompt 45). Auditor-side
  // permissions deliberately, so the row-level visibility rules would show them
  // the whole organisation and the affiliate confinement is the only thing
  // narrowing what they see. That is what makes the assertions about it mean
  // something.
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      insert(db, 'role_permissions', {
        organization_id: SMOKE.orgId,
        role_code: SMOKE.confinedRole,
        module_code: module,
        action_code: action,
        is_allowed:
          module === 'WORK_PAPER' || module === 'ACTION_PLAN' || module === 'REPORT'
            ? action === 'read' || action === 'create' || action === 'update'
              ? 1
              : 0
            : 0,
        scope_to_affiliate: 1,
      });
    }
  }
  // The other organisation holds its OWN auditor grants, deliberately narrower
  // than the defaults. This is the control for the tenant-scoping fix: when the
  // smoke run saves Hass's AUDITOR matrix, these rows must be exactly as they
  // are here afterwards. Before Build Prompt 44 that same save rewrote them.
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      insert(db, 'role_permissions', {
        organization_id: SMOKE.otherOrgId,
        role_code: 'AUDITOR',
        module_code: module,
        action_code: action,
        is_allowed: action === 'read' ? 1 : 0,
        scope_to_affiliate: 0,
      });
    }
  }

  const users: [string, string, string, string, number][] = [
    [SMOKE.userId, SMOKE.email, 'Wilberforce Murikah', 'SUPER_ADMIN', 1],
    // The instance admin: the same role as the owner, but pinned to Hass. Its
    // home organisation is the owner's too, which is what makes it the right
    // control: only the is_platform_owner flag separates the two experiences.
    [SMOKE.instanceAdminId, SMOKE.instanceAdminEmail, 'Hass Administrator', 'SUPER_ADMIN', 0],
    [SMOKE.auditorId, 'auditor@hasspetroleum.com', 'Amina Auditor', 'AUDITOR', 0],
    [SMOKE.auditeeId, 'owner@hasspetroleum.com', 'Otieno Owner', 'UNIT_MANAGER', 0],
    // Exists only for the lockout check: the smoke test burns its failure
    // budget and proves the right password is then refused too.
    [SMOKE.lockoutUserId, 'lockout@hasspetroleum.com', 'Larry Lockout', 'AUDITOR', 0],
  ];
  for (const [id, email, name, role, isOwner] of users) {
    insert(db, 'users', {
      user_id: id,
      organization_id: SMOKE.orgId,
      email,
      full_name: name,
      password_hash: seedPasswordHash(SMOKE.password),
      role_code: role,
      affiliate_code: SMOKE.affiliateCode,
      status: 'ACTIVE',
      must_change_password: 0,
      is_platform_owner: isOwner,
      created_at: now,
    });
  }

  // The confined pair: one with an affiliate, one without.
  for (const [id, email, name, affiliate] of [
    [SMOKE.confinedUserId, SMOKE.confinedUserEmail, 'Kamau Lead', SMOKE.affiliateCode],
    [SMOKE.unassignedUserId, SMOKE.unassignedUserEmail, 'Njeri Unassigned', null],
    // Same role, same grants, same confinement: only the affiliate differs.
    [SMOKE.groupUserId, SMOKE.groupUserEmail, 'Wanjiru Group', SMOKE.groupAffiliateCode],
  ] as const) {
    insert(db, 'users', {
      user_id: id,
      organization_id: SMOKE.orgId,
      email,
      full_name: name,
      password_hash: seedPasswordHash(SMOKE.password),
      role_code: SMOKE.confinedRole,
      affiliate_code: affiliate,
      status: 'ACTIVE',
      must_change_password: 0,
      is_platform_owner: 0,
      created_at: now,
    });
  }

  // The Coast administrator. Email identifies a user across the platform at
  // sign-in, so an address taken here must not be reusable inside Hass.
  insert(db, 'users', {
    user_id: SMOKE.otherOrgUserId,
    organization_id: SMOKE.otherOrgId,
    email: SMOKE.otherOrgUserEmail,
    full_name: 'Coast Administrator',
    password_hash: seedPasswordHash(SMOKE.password),
    role_code: 'SUPER_ADMIN',
    status: 'ACTIVE',
    must_change_password: 0,
    is_platform_owner: 0,
    created_at: now,
  });

  // Two-step verification is universal (Build Prompt 37): every sign-in in
  // the smoke run completes the email-code step by planting a known
  // challenge through the database handle, so no per-organisation MFA rule
  // is seeded. MFA_AUTHENTICATOR_ROLES stays unset (its default allows the
  // seeded SUPER_ADMIN the authenticator app).

  // The live database spells the work-paper workflow in lower case, and the code
  // spelled it in upper case, so a case-sensitive lookup matched none of its
  // rows and every move a work paper could make was refused (Build Prompt 61).
  // The seed follows the live spelling, exactly as the dictionary rule requires:
  // the database is the ground truth and the code bends to it. Action plans keep
  // the upper-case spelling, so the run proves the lookup is tolerant of both
  // rather than of one.
  for (const [i, value] of WP_STATUSES.entries()) {
    insert(db, 'enum_values', {
      enum_type: LIVE_WP_ENUM,
      enum_value: value,
      display_label: value,
      display_order: i + 1,
      is_terminal: value === 'Response Reviewed' ? 1 : 0,
      is_active: 1,
    });
  }
  for (const [i, value] of AP_STATUSES.entries()) {
    insert(db, 'enum_values', {
      enum_type: 'ACTION_PLAN_STATUS',
      enum_value: value,
      display_label: value,
      display_order: i + 1,
      is_terminal: value === 'Closed' || value === 'Rejected' ? 1 : 0,
      is_active: 1,
    });
  }
  for (const [from, to] of WP_TRANSITIONS) {
    insert(db, 'status_transitions', {
      // One row is spelled differently from its neighbours, because these are
      // hand-maintained reference rows and in a live table they are: the
      // resubmit after a review is written `Work_Paper_Status` here. It is the
      // same workflow and must answer as one, which a case-sensitive lookup
      // would not do (Build Prompt 61).
      enum_type: from === 'Revision Required' ? MIXED_CASE_WP_ENUM : LIVE_WP_ENUM,
      from_status: from,
      to_status: to,
      required_role: null,
      requires_comment: to === 'Revision Required' ? 1 : 0,
    });
  }
  for (const [from, to] of AP_TRANSITIONS) {
    insert(db, 'status_transitions', {
      enum_type: 'ACTION_PLAN_STATUS',
      from_status: from,
      to_status: to,
      required_role: null,
      requires_comment: 0,
    });
  }
  insert(db, 'workflow_terminal_states', {
    workflow_name: LIVE_WP_ENUM,
    terminal_status: 'Response Reviewed',
    created_at: now,
  });
  // The decoy the live table actually holds: a second workflow, under its own
  // enum, defining a move of the very same name. A lookup that is not scoped to
  // the work paper's own workflow matches this and moves a finding by an auditee
  // response's rules, or misses its own and refuses a move that plainly exists.
  for (const [from, to] of [
    ['Draft', 'Submitted'],
    ['Submitted', 'Approved'],
  ] as const) {
    insert(db, 'status_transitions', {
      enum_type: RESPONSE_ENUM,
      from_status: from,
      to_status: to,
      // Reserved for a role nobody in the smoke run holds, so a work paper that
      // wrongly matched this row would be refused for the role rather than
      // passing silently: the decoy has to be able to fail loudly.
      required_role: 'NOBODY',
      requires_comment: 1,
    });
  }
  for (const status of ['Closed', 'Rejected']) {
    insert(db, 'workflow_terminal_states', {
      workflow_name: 'ACTION_PLAN_STATUS',
      terminal_status: status,
      created_at: now,
    });
  }

  insert(db, 'affiliates', {
    affiliate_code: SMOKE.affiliateCode,
    organization_id: SMOKE.orgId,
    affiliate_name: 'Hass Kenya Limited',
    country: 'Kenya',
    region: 'Nairobi',
    is_active: 1,
    is_group: 0,
    created_at: now,
  });
  insert(db, 'affiliates', {
    affiliate_code: SMOKE.otherAffiliateCode,
    organization_id: SMOKE.orgId,
    affiliate_name: 'Hass Pipeline Limited',
    country: 'Kenya',
    region: 'Mombasa',
    is_active: 1,
    is_group: 0,
    created_at: now,
  });
  // The Group unit. A user posted here is exempt from affiliate confinement.
  insert(db, 'affiliates', {
    affiliate_code: SMOKE.groupAffiliateCode,
    organization_id: SMOKE.orgId,
    affiliate_name: 'Hass Petroleum Group',
    country: 'Kenya',
    region: 'Nairobi',
    is_active: 1,
    is_group: 1,
    created_at: now,
  });
  insert(db, 'audit_areas', {
    audit_area_id: SMOKE.auditAreaId,
    organization_id: SMOKE.orgId,
    area_code: 'FIN',
    area_name: 'Finance and Treasury',
    description: 'Financial controls',
    is_active: 1,
    created_at: now,
  });
  insert(db, 'sub_areas', {
    sub_area_id: SMOKE.subAreaId,
    audit_area_id: SMOKE.auditAreaId,
    organization_id: SMOKE.orgId,
    sub_area_name: 'Treasury operations',
    is_active: 1,
    created_at: now,
  });
  insert(db, 'departments', {
    department_id: 'DEP-1',
    organization_id: SMOKE.orgId,
    affiliate_code: SMOKE.affiliateCode,
    department_code: 'TREAS',
    department_name: 'Treasury',
    is_active: 1,
    created_at: now,
  });

  const workPapers: [string, string, string][] = [
    [SMOKE.draftWorkPaperId, 'WP/2026/001', 'Draft'],
    [SMOKE.sentWorkPaperId, 'WP/2026/002', 'Sent to Auditee'],
  ];
  for (const [id, ref, status] of workPapers) {
    // A finding that has reached the auditee carries the date it was shared and
    // the round it is on, which the deadline and the reopen path both read.
    const sent = status === 'Sent to Auditee';
    insert(db, 'work_papers', {
      work_paper_id: id,
      organization_id: SMOKE.orgId,
      work_paper_ref: ref,
      created_by: SMOKE.userId,
      year: 2026,
      affiliate_code: SMOKE.affiliateCode,
      audit_area_id: SMOKE.auditAreaId,
      sub_area_id: SMOKE.subAreaId,
      work_paper_date: today,
      observation_title: `Reconciliations not performed (${ref})`,
      observation_description: 'Monthly bank reconciliations were not performed on time.',
      risk_rating: 'High',
      recommendation: 'Perform reconciliations monthly and review them.',
      // Deliberately the live shape (Build Prompt 50): the id is set and the
      // denormalised name column is NOT, so the detail has to resolve the name
      // through the join. Seeding the copy would have hidden the bug.
      assigned_auditor_id: SMOKE.auditorId,
      // A value from the seeded DROPDOWN_CONTROL_CLASSIFICATION vocabulary, so
      // the edit form's select can actually hold it selected.
      control_classification: 'KEY',
      control_standards: 'ISO 27001, IIA Standards',
      status,
      revision_count: 0,
      prepared_by_id: SMOKE.userId,
      prepared_by_name: 'Wilberforce Murikah',
      sent_to_auditee_date: sent ? now : null,
      response_round: sent ? 1 : null,
      response_status: sent ? 'SUBMITTED' : null,
      created_at: now,
      updated_at: now,
    });
  }
  // A finding in the second affiliate. Everything else the seed creates is in
  // HKL, so this is the row a confined HKL viewer must never see, and the row an
  // unconfined viewer must still see.
  insert(db, 'work_papers', {
    work_paper_id: SMOKE.otherAffiliateWorkPaperId,
    organization_id: SMOKE.orgId,
    work_paper_ref: 'WP/2026/HPL',
    created_by: SMOKE.userId,
    year: 2026,
    affiliate_code: SMOKE.otherAffiliateCode,
    audit_area_id: SMOKE.auditAreaId,
    sub_area_id: SMOKE.subAreaId,
    work_paper_date: today,
    observation_title: 'Pipeline stock counts not reconciled (WP/2026/HPL)',
    observation_description: 'Depot stock counts were not reconciled to the system.',
    risk_rating: 'High',
    recommendation: 'Reconcile depot counts monthly.',
    assigned_auditor_id: SMOKE.auditorId,
    assigned_auditor_name: 'Amina Auditor',
    status: 'Approved',
    revision_count: 0,
    prepared_by_id: SMOKE.userId,
    prepared_by_name: 'Wilberforce Murikah',
    created_at: now,
    updated_at: now,
  });
  insert(db, 'action_plans', {
    action_plan_id: 'AP-HPL-1',
    organization_id: SMOKE.orgId,
    work_paper_id: SMOKE.otherAffiliateWorkPaperId,
    affiliate_code: SMOKE.otherAffiliateCode,
    action_number: 'AP/2026/HPL',
    action_description: 'Introduce weekly depot reconciliations.',
    status: 'In Progress',
    due_date: today,
    owner_ids: `,${SMOKE.auditeeId},`,
    owner_names: 'Otieno Owner',
    created_by: SMOKE.userId,
    created_at: now,
    updated_at: now,
  });

  // The inheriting organisation (Build Prompt 57): one affiliate, one audit
  // area, one auditor and three drafts assigned to them. No `role_permissions`
  // row is written for it anywhere in this seed, deliberately: its auditor holds
  // WORK_PAPER.update only through the GLOBAL default, which is the state a live
  // organisation is in until somebody first saves its access control.
  insert(db, 'affiliates', {
    affiliate_code: SMOKE.inheritAffiliateCode,
    organization_id: SMOKE.inheritOrgId,
    affiliate_name: 'Tana Energy Limited',
    country: 'Kenya',
    region: 'Garissa',
    is_active: 1,
    is_group: 0,
    created_at: now,
  });
  insert(db, 'audit_areas', {
    audit_area_id: SMOKE.inheritAuditAreaId,
    organization_id: SMOKE.inheritOrgId,
    // Not a code any smoke step creates: the audit-universe case counts its own
    // area platform-wide, so a seeded duplicate would fail that step instead.
    area_code: 'DEP',
    area_name: 'Depot operations',
    description: 'Depot and distribution controls',
    is_active: 1,
    created_at: now,
  });
  insert(db, 'sub_areas', {
    sub_area_id: SMOKE.inheritSubAreaId,
    audit_area_id: SMOKE.inheritAuditAreaId,
    organization_id: SMOKE.inheritOrgId,
    sub_area_name: 'Depot stock control',
    is_active: 1,
    created_at: now,
  });
  insert(db, 'users', {
    user_id: SMOKE.inheritAuditorId,
    organization_id: SMOKE.inheritOrgId,
    email: SMOKE.inheritAuditorEmail,
    full_name: 'Tana Auditor',
    password_hash: seedPasswordHash(SMOKE.password),
    role_code: 'AUDITOR',
    affiliate_code: SMOKE.inheritAffiliateCode,
    status: 'ACTIVE',
    must_change_password: 0,
    is_platform_owner: 0,
    created_at: now,
  });
  for (const [i, id] of SMOKE.inheritDraftIds.entries()) {
    insert(db, 'work_papers', {
      work_paper_id: id,
      organization_id: SMOKE.inheritOrgId,
      work_paper_ref: `WP/2026/TNA-${i + 1}`,
      created_by: SMOKE.inheritAuditorId,
      year: 2026,
      affiliate_code: SMOKE.inheritAffiliateCode,
      audit_area_id: SMOKE.inheritAuditAreaId,
      sub_area_id: SMOKE.inheritSubAreaId,
      work_paper_date: today,
      // A complete finding: the inheriting-organisation case submits these, and
      // a submission needs every required field (Build Prompt 59).
      audit_period_from: '2026-01-01',
      audit_period_to: '2026-03-31',
      observation_title: `Depot control weakness ${i + 1}`,
      observation_description: 'Raised in an organisation that inherits its grants.',
      risk_rating: 'Medium',
      recommendation: 'Tighten the control.',
      assigned_auditor_id: SMOKE.inheritAuditorId,
      status: 'Draft',
      revision_count: 0,
      prepared_by_id: SMOKE.inheritAuditorId,
      prepared_by_name: 'Tana Auditor',
      created_at: now,
      updated_at: now,
    });
  }

  const ftsInsert = db.prepare(
    `INSERT INTO work_papers_fts (rowid, observation_title, observation_description, recommendation)
      SELECT rowid, observation_title, observation_description, recommendation
        FROM work_papers WHERE work_paper_id = ?`,
  );
  for (const [id] of workPapers) ftsInsert.run(id);
  ftsInsert.run(SMOKE.otherAffiliateWorkPaperId);
  for (const id of SMOKE.inheritDraftIds) ftsInsert.run(id);

  // Still outstanding: asked for, never received. Its status is the free text a
  // row written before Build Prompt 52 carries, so the screen has to label it
  // from received_date rather than from the column.
  insert(db, 'work_paper_requirements', {
    requirement_id: SMOKE.requirementId,
    work_paper_id: SMOKE.sentWorkPaperId,
    organization_id: SMOKE.orgId,
    description: 'Provide the December reconciliation file.',
    requirement_type: 'EVIDENCE',
    status: 'PENDING',
    due_date: today,
    requested_date: '2026-01-05',
    created_at: now,
  });
  insert(db, 'work_paper_requirements', {
    requirement_id: SMOKE.receivedRequirementId,
    work_paper_id: SMOKE.sentWorkPaperId,
    organization_id: SMOKE.orgId,
    description: 'Provide the approved bank mandate.',
    requirement_type: 'EVIDENCE',
    status: 'RECEIVED',
    due_date: today,
    requested_date: '2026-01-05',
    received_date: '2026-01-12',
    created_at: now,
  });
  insert(db, 'work_paper_responsibles', {
    work_paper_id: SMOKE.sentWorkPaperId,
    user_id: SMOKE.auditeeId,
    role_in_finding: 'RESPONSIBLE',
    added_at: now,
    added_by: SMOKE.userId,
  });
  insert(db, 'work_paper_cc_recipients', {
    work_paper_id: SMOKE.sentWorkPaperId,
    email: 'cc@hasspetroleum.com',
    user_id: SMOKE.auditorId,
    added_at: now,
  });
  insert(db, 'work_paper_revisions', {
    revision_id: 'REV-1',
    work_paper_id: SMOKE.sentWorkPaperId,
    revision_number: 1,
    action: 'CREATE',
    from_status: null,
    to_status: 'Draft',
    comments: 'Created',
    user_id: SMOKE.userId,
    user_name: 'Wilberforce Murikah',
    action_date: now,
  });

  const plans: [string, string, string][] = [
    [SMOKE.actionPlanId, 'AP/2026/001', 'In Progress'],
    [SMOKE.verifyActionPlanId, 'AP/2026/002', 'Pending Verification'],
  ];
  for (const [i, [id, ref, status]] of plans.entries()) {
    insert(db, 'action_plans', {
      action_plan_id: id,
      organization_id: SMOKE.orgId,
      work_paper_id: SMOKE.sentWorkPaperId,
      affiliate_code: SMOKE.affiliateCode,
      action_ref: ref,
      action_number: i + 1,
      action_description: 'Implement a monthly reconciliation review.',
      priority: 'High',
      status,
      target_date: today,
      due_date: today,
      created_by: SMOKE.userId,
      created_by_role: 'SUPER_ADMIN',
      owner_ids: SMOKE.auditeeId,
      owner_names: 'Otieno Owner',
      days_overdue: 0,
      created_at: now,
      updated_at: now,
    });
    insert(db, 'action_plan_owners', {
      action_plan_id: id,
      user_id: SMOKE.auditeeId,
      is_original: 1,
      is_current: 1,
      added_at: now,
      added_by: SMOKE.userId,
    });
    insert(db, 'action_plan_history', {
      history_id: `HIS-${i + 1}`,
      action_plan_id: id,
      action: 'CREATE',
      from_status: null,
      to_status: status,
      comments: 'Created',
      user_id: SMOKE.userId,
      user_name: 'Wilberforce Murikah',
      action_date: now,
    });
  }

  // A stray from before the parent rule: no work_paper_id and no owners, so
  // only the orphan panel and its relink path see it.
  insert(db, 'action_plans', {
    action_plan_id: SMOKE.orphanPlanId,
    organization_id: SMOKE.orgId,
    work_paper_id: null,
    affiliate_code: SMOKE.affiliateCode,
    action_ref: 'AP/2026/009',
    action_number: 9,
    action_description: 'Legacy stray plan with no parent finding.',
    priority: 'Low',
    status: 'Pending',
    target_date: today,
    due_date: today,
    created_by: SMOKE.userId,
    created_by_role: 'SUPER_ADMIN',
    days_overdue: 0,
    created_at: now,
    updated_at: now,
  });

  insert(db, 'auditee_responses', {
    response_id: SMOKE.responseId,
    organization_id: SMOKE.orgId,
    work_paper_id: SMOKE.sentWorkPaperId,
    response_round: 1,
    round_number: 1,
    response_type: 'MANAGEMENT_RESPONSE',
    response_text: 'We agree with the finding and will implement the recommendation.',
    management_response: 'Agreed.',
    status: 'SUBMITTED',
    submitted_by: SMOKE.auditeeId,
    submitted_by_id: SMOKE.auditeeId,
    submitted_by_name: 'Otieno Owner',
    submitted_date: now,
    action_plan_ids: SMOKE.actionPlanId,
    created_at: now,
    updated_at: now,
  });

  insert(db, 'email_templates', {
    template_code: 'finding_shared',
    organization_id: SMOKE.orgId,
    name: 'Finding shared',
    template_name: 'Finding shared',
    subject: 'Finding shared: {{reference}}',
    subject_template: 'Finding shared: {{reference}}',
    body: 'Finding {{reference}} has been shared with you.',
    body_template: 'Finding {{reference}} has been shared with you.',
    body_template_text: 'Finding {{reference}} has been shared with you.',
    is_active: 1,
    updated_at: now,
  });

  insert(db, 'notification_queue', {
    notification_id: SMOKE.notificationId,
    organization_id: SMOKE.orgId,
    template_code: 'finding_shared',
    recipient_user_id: SMOKE.auditeeId,
    recipient_email: 'owner@hasspetroleum.com',
    recipient_name: 'Otieno Owner',
    type: 'EMAIL',
    channel: 'email',
    related_entity_type: 'WORK_PAPER',
    related_entity_id: SMOKE.sentWorkPaperId,
    subject: 'Finding shared: WP/2026/002',
    body: 'Finding WP/2026/002 has been shared with you.',
    rendered_subject: 'Finding shared: WP/2026/002',
    rendered_body: 'Finding WP/2026/002 has been shared with you.',
    status: 'PENDING',
    attempts: 1,
    max_attempts: 5,
    error_message: 'Simulated delivery failure for the smoke test.',
    created_at: now,
  });
  insert(db, 'in_app_notifications', {
    in_app_id: 'IAN-1',
    user_id: SMOKE.userId,
    title: 'Finding shared',
    body: 'WP/2026/002 has been shared with the auditee.',
    severity: 'INFO',
    related_entity_type: 'WORK_PAPER',
    related_entity_id: SMOKE.sentWorkPaperId,
    deep_link: `/work-papers/${SMOKE.sentWorkPaperId}`,
    created_at: now,
  });

  // Evidence governance: a legal hold over the sent finding (its evidence must
  // be undeletable), a platform-wide retention policy, and three files: one held,
  // one deletable, and one still on Drive for the migration worklist.
  insert(db, 'legal_holds', {
    hold_id: 'HOLD-1',
    name: 'Regulator inquiry 2026',
    description: 'Hold everything on the treasury finding.',
    entity_filter: JSON.stringify({ entity_type: 'work_paper', entity_id: SMOKE.sentWorkPaperId }),
    placed_at: now,
    placed_by: SMOKE.userId,
  });
  insert(db, 'retention_policies', {
    policy_id: 'RET-1',
    entity_type: 'work_paper',
    retention_days: 90,
    is_active: 1,
    description: 'Work paper evidence is kept at least ninety days.',
  });
  const files: [string, string, string, string | null, string | null][] = [
    // file_id, attached entity, backend, storage_key, drive_file_id
    [
      SMOKE.heldFileId,
      SMOKE.sentWorkPaperId,
      'r2',
      `org/${SMOKE.orgId}/evidence/${SMOKE.heldFileId}`,
      null,
    ],
    [
      SMOKE.freeFileId,
      SMOKE.draftWorkPaperId,
      'r2',
      `org/${SMOKE.orgId}/evidence/${SMOKE.freeFileId}`,
      null,
    ],
    [SMOKE.driveFileId, SMOKE.draftWorkPaperId, 'drive', null, 'drive-abc-123'],
  ];
  for (const [fileId, entityId, backend, key, driveId] of files) {
    insert(db, 'files', {
      file_id: fileId,
      organization_id: SMOKE.orgId,
      file_name: `${fileId.toLowerCase()}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: 2048,
      uploaded_by: SMOKE.userId,
      storage_backend: backend,
      storage_key: key,
      drive_file_id: driveId,
      content_hash: 'a'.repeat(64),
      content_hash_algo: 'SHA-256',
      created_at: now,
    });
    insert(db, 'file_attachments', {
      attachment_id:
        fileId === SMOKE.heldFileId
          ? SMOKE.heldAttachmentId
          : fileId === SMOKE.freeFileId
            ? SMOKE.freeAttachmentId
            : `ATT-${fileId}`,
      file_id: fileId,
      entity_type: 'work_paper',
      entity_id: entityId,
      file_category: 'EVIDENCE',
      attached_by: SMOKE.userId,
      attached_at: now,
    });
  }

  // Hass's evidence storage connection: R2, tested and active, with its
  // credentials sealed exactly as the settings screen would have sealed them.
  // Coast is left with no row at all, which is the unconfigured state.
  insert(db, 'storage_connections', {
    connection_id: 'STC-HASS-R2',
    organization_id: SMOKE.orgId,
    provider: SMOKE.storageProvider,
    config_sealed: await seal(
      SMOKE_SESSION_SECRET,
      JSON.stringify({
        account_id: 'smoke-account',
        bucket: SMOKE.storageBucket,
        access_key_id: 'smoke-access-key',
        secret_access_key: 'smoke-secret-key',
        // The endpoint the settings screen has always offered, pointed at the
        // harness's own S3 stand-in so a connection test can really pass and
        // really activate the provider (Build Prompt 54).
        endpoint: s3Origin,
      }),
    ),
    folder_id: SMOKE.storageFolder,
    folder_name: SMOKE.storageFolder,
    status: 'connected',
    status_detail: 'Wrote and removed a probe object.',
    is_active: 1,
    connected_at: now,
    connected_by: SMOKE.userId,
    created_at: now,
    updated_at: now,
  });

  for (const [i, action] of ['LOGIN', 'WORK_PAPER.create', 'ACTION_PLAN.update'].entries()) {
    insert(db, 'audit_activity', {
      event_id: `EVT-${i + 1}`,
      organization_id: SMOKE.orgId,
      occurred_at: now,
      actor_user_id: SMOKE.userId,
      actor_email: SMOKE.email,
      actor_role: 'SUPER_ADMIN',
      action,
      module_code: 'WORK_PAPER',
      entity_type: 'WORK_PAPER',
      entity_id: SMOKE.sentWorkPaperId,
      details_json: '{}',
      success: 1,
    });
  }
}
