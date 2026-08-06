/**
 * Demo seed for the smoke database: one active organisation on a full-feature
 * plan, the seeded sign-in user (a platform-owner SUPER_ADMIN, so every screen
 * and workflow action is reachable), a second organisation for the switcher, the
 * data-driven workflow reference rows (enum_values, status_transitions,
 * workflow_terminal_states), and one of everything the pages drill into: a
 * draft work paper, one sent to the auditee, action plans in mid-lifecycle
 * states, a response, notifications and activity. IDs are fixed and exported so
 * the smoke test can address detail routes and mutations deterministically.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SMOKE = {
  orgId: 'ORG-HASS',
  orgName: 'Hass Petroleum Group',
  otherOrgId: 'ORG-COAST',
  email: 'wilberforce.murikah@hasspetroleum.com',
  password: 'Grc-Smoke-Harness-2026',
  userId: 'USR-WM',
  auditorId: 'USR-AUD',
  auditeeId: 'USR-OWN',
  lockoutUserId: 'USR-LOCK',
  affiliateCode: 'HKL',
  auditAreaId: 'AA-FIN',
  subAreaId: 'SA-TREAS',
  draftWorkPaperId: 'WP-DRAFT-1',
  sentWorkPaperId: 'WP-SENT-1',
  requirementId: 'REQ-1',
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
} as const;

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
];

const MODULES = [
  'WORK_PAPER',
  'ACTION_PLAN',
  'AUDITEE_RESPONSE',
  'AUDIT_WORKBENCH',
  'REPORT',
  'AI_ASSIST',
  'NOTIFICATION',
  'SETUP',
  'USER',
];

const ACTIONS = ['read', 'create', 'update', 'delete', 'approve', 'export'];

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

export function seedDatabase(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  for (const [orgId, code, name] of [
    [SMOKE.orgId, 'HASS', SMOKE.orgName],
    [SMOKE.otherOrgId, 'COAST', 'Coast Energy Limited'],
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
  for (const orgId of [SMOKE.orgId, SMOKE.otherOrgId]) {
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
  for (const module of MODULES) {
    insert(db, 'permission_modules', { module_code: module, module_name: module });
  }
  for (const action of ACTIONS) {
    insert(db, 'permission_actions', { action_code: action, action_name: action });
  }
  // A full grant for the admin role and a read-heavy grant for auditors, so the
  // access-control screen has a real matrix to render and save.
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      insert(db, 'role_permissions', {
        role_code: 'SUPER_ADMIN',
        module_code: module,
        action_code: action,
        is_allowed: 1,
      });
      insert(db, 'role_permissions', {
        role_code: 'AUDITOR',
        module_code: module,
        action_code: action,
        is_allowed: action === 'read' || action === 'create' || action === 'update' ? 1 : 0,
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
      role_code: 'UNIT_MANAGER',
      module_code: module,
      action_code: action,
      is_allowed: 1,
    });
  }

  const users: [string, string, string, string, number][] = [
    [SMOKE.userId, SMOKE.email, 'Wilberforce Murikah', 'SUPER_ADMIN', 1],
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

  // MFA is not required by role in the smoke organisation (the default rule
  // would lock the seeded SUPER_ADMIN to enrolment and break every page
  // check); the voluntary enrolment round trip covers the flow instead.
  for (const orgId of [SMOKE.orgId, SMOKE.otherOrgId]) {
    insert(db, 'config', {
      organization_id: orgId,
      config_key: 'MFA_REQUIRED_ROLES',
      config_value: 'NONE',
      updated_at: now,
    });
  }

  for (const [i, value] of WP_STATUSES.entries()) {
    insert(db, 'enum_values', {
      enum_type: 'WORK_PAPER_STATUS',
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
      enum_type: 'WORK_PAPER_STATUS',
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
    workflow_name: 'WORK_PAPER_STATUS',
    terminal_status: 'Response Reviewed',
    created_at: now,
  });
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
      assigned_auditor_id: SMOKE.auditorId,
      assigned_auditor_name: 'Amina Auditor',
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
  const ftsInsert = db.prepare(
    `INSERT INTO work_papers_fts (rowid, observation_title, observation_description, recommendation)
      SELECT rowid, observation_title, observation_description, recommendation
        FROM work_papers WHERE work_paper_id = ?`,
  );
  for (const [id] of workPapers) ftsInsert.run(id);

  insert(db, 'work_paper_requirements', {
    requirement_id: SMOKE.requirementId,
    work_paper_id: SMOKE.sentWorkPaperId,
    organization_id: SMOKE.orgId,
    description: 'Provide the December reconciliation file.',
    requirement_type: 'EVIDENCE',
    status: 'PENDING',
    due_date: today,
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
