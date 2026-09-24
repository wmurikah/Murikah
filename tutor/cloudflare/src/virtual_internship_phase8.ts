type P8Statement = {
  bind(...values: unknown[]): P8Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type P8Database = {
  prepare(query: string): P8Statement;
  batch(statements: P8Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
type P8Env = { TUTOR_DB: P8Database };

const COMPLETION_EVALUATOR_VERSION = 'phase8-completion-evaluator-v1';
const COMPLETION_POLICY_SCHEMA_VERSION = 1;
const INTERNSHIP_DAY_SECONDS = 24 * 60 * 60;
const LEVEL_ORDER: Record<string, number> = {
  emerging: 0,
  developing: 1,
  applied_with_support: 2,
  independent: 3,
  advanced: 4,
};
const STRENGTH_ORDER: Record<string, number> = { limited: 0, supporting: 1, strong: 2 };
const REQUIRED_REVIEW_TYPES = new Set(['midpoint']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{3,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

type RequiredCompetency = {
  competency_id: string;
  definition_version: number;
  minimum_level: string;
  minimum_evidence_strength: string;
  minimum_evidence_records: number;
  minimum_independent_demonstrations: number;
  minimum_distinct_contexts: number;
};

type CompletionPolicy = {
  schema_version: number;
  required_task_ids: string[];
  required_review_types: string[];
  required_competencies: RequiredCompetency[];
  capstone_task_ids: string[];
  require_final_review: boolean;
  final_review_after_capstone: boolean;
};

type Gate = Record<string, unknown> & { passed: boolean };

type Evaluation = {
  evaluated_at: number;
  qualifying: boolean;
  lifecycle_status: string;
  scenario_version_id: string;
  completion_policy_schema_version: number | null;
  completion_policy_hash: string;
  overall_eligible: boolean;
  blockers: string[];
  duration: Gate;
  required_tasks: Gate;
  required_reviews: Gate;
  evidence: Gate;
  capstone_final_review: Gate;
  evidence_refs: string[];
  passport_aggregation_ruleset_versions: string[];
  evidence_ruleset_versions: string[];
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
function cleanId(value: unknown): string {
  const out = String(value ?? '').trim();
  return ID.test(out) ? out : '';
}
function cleanRequestId(value: unknown): string {
  const out = String(value ?? '').trim();
  return REQUEST_ID.test(out) ? out : '';
}
function integer(value: unknown): number {
  const out = Number(value);
  return Number.isInteger(out) ? out : 0;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function parse(value: unknown, fallback: unknown): any {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}
function generated(prefix: string): string {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '');
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(cleanId);
  if (rows.some((item) => !item) || new Set(rows).size !== rows.length) return null;
  return rows;
}
function scenarioManifest(canonicalJsonValue: unknown): Record<string, unknown> | null {
  const pack = parse(canonicalJsonValue, null);
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return null;
  const manifest = (pack as Record<string, unknown>).manifest;
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest as Record<string, unknown>
    : null;
}

async function activeAccount(db: P8Database, actorId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1',
  ).bind(actorId).first<{ role: string; account_status: string }>();
  return Boolean(row && ['member', 'admin'].includes(row.role) && row.account_status === 'active');
}

async function ownedInternship(db: P8Database, actorId: string, internshipId: string) {
  return db.prepare(
    'SELECT i.id, i.learner_id, i.scenario_pack_id, i.scenario_version_id, i.mode, i.qualifying, i.status, ' +
    'i.lifecycle_stage, i.started_at, i.minimum_duration_days, i.target_end_at, i.stopped_at, i.completed_at, ' +
    'c.canonical_json, p.schema_version AS policy_schema_version, p.policy_json, p.policy_hash ' +
    'FROM internship_instances i ' +
    'LEFT JOIN scenario_version_content c ON c.scenario_version_id = i.scenario_version_id ' +
    'LEFT JOIN scenario_completion_policies p ON p.scenario_version_id = i.scenario_version_id ' +
    'WHERE i.id = ? AND i.learner_id = ? LIMIT 1',
  ).bind(internshipId, actorId).first<Record<string, unknown>>();
}

function parsePolicy(value: unknown): CompletionPolicy | null {
  const raw = parse(value, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    'schema_version', 'required_task_ids', 'required_review_types', 'required_competencies',
    'capstone_task_ids', 'require_final_review', 'final_review_after_capstone',
  ]);
  if (Object.keys(obj).some((key) => !allowed.has(key))) return null;
  if (integer(obj.schema_version) !== COMPLETION_POLICY_SCHEMA_VERSION) return null;
  const requiredTasks = uniqueStrings(obj.required_task_ids);
  const requiredReviews = uniqueStrings(obj.required_review_types);
  const capstones = uniqueStrings(obj.capstone_task_ids);
  if (!requiredTasks || !requiredReviews || !capstones) return null;
  if (requiredReviews.some((kind) => !REQUIRED_REVIEW_TYPES.has(kind))) return null;
  if (typeof obj.require_final_review !== 'boolean' || typeof obj.final_review_after_capstone !== 'boolean') return null;
  if (obj.final_review_after_capstone && (!obj.require_final_review || capstones.length === 0)) return null;
  const rawCompetencies = array(obj.required_competencies);
  const competencies: RequiredCompetency[] = [];
  const seen = new Set<string>();
  for (const value of rawCompetencies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const rowAllowed = new Set([
      'competency_id', 'definition_version', 'minimum_level', 'minimum_evidence_strength',
      'minimum_evidence_records', 'minimum_independent_demonstrations', 'minimum_distinct_contexts',
    ]);
    if (Object.keys(row).some((key) => !rowAllowed.has(key))) return null;
    const competencyId = cleanId(row.competency_id);
    const definitionVersion = integer(row.definition_version);
    const minimumLevel = String(row.minimum_level ?? '');
    const minimumStrength = String(row.minimum_evidence_strength ?? '');
    const minimumRecords = integer(row.minimum_evidence_records);
    const minimumIndependent = integer(row.minimum_independent_demonstrations);
    const minimumContexts = integer(row.minimum_distinct_contexts);
    const key = competencyId + ':' + definitionVersion;
    if (
      !competencyId || definitionVersion < 1 || !(minimumLevel in LEVEL_ORDER) ||
      !(minimumStrength in STRENGTH_ORDER) || minimumRecords < 1 ||
      minimumIndependent < 0 || minimumContexts < 0 || seen.has(key)
    ) return null;
    seen.add(key);
    competencies.push({
      competency_id: competencyId,
      definition_version: definitionVersion,
      minimum_level: minimumLevel,
      minimum_evidence_strength: minimumStrength,
      minimum_evidence_records: minimumRecords,
      minimum_independent_demonstrations: minimumIndependent,
      minimum_distinct_contexts: minimumContexts,
    });
  }
  return {
    schema_version: COMPLETION_POLICY_SCHEMA_VERSION,
    required_task_ids: requiredTasks,
    required_review_types: requiredReviews,
    required_competencies: competencies,
    capstone_task_ids: capstones,
    require_final_review: obj.require_final_review,
    final_review_after_capstone: obj.final_review_after_capstone,
  };
}

async function policyReferencesValid(db: P8Database, scenarioVersionId: string, policy: CompletionPolicy): Promise<boolean> {
  const taskRows = (await db.prepare(
    'SELECT task_id, definition_json FROM scenario_task_definitions WHERE scenario_version_id = ? ORDER BY task_id',
  ).bind(scenarioVersionId).all<Record<string, unknown>>()).results || [];
  const taskIds = new Set(taskRows.map((row) => String(row.task_id || '')));
  if ([...policy.required_task_ids, ...policy.capstone_task_ids].some((taskId) => !taskIds.has(taskId))) return false;

  const scenarioCompetencies = new Set<string>();
  for (const task of taskRows) {
    const definition = parse(task.definition_json, {});
    for (const ref of array(definition?.competency_refs)) {
      if (typeof ref === 'string') scenarioCompetencies.add(ref);
      else if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        const id = cleanId((ref as Record<string, unknown>).competency_id || (ref as Record<string, unknown>).id);
        if (id) scenarioCompetencies.add(id);
      }
    }
  }
  for (const requirement of policy.required_competencies) {
    if (!scenarioCompetencies.has(requirement.competency_id)) return false;
    const definition = await db.prepare(
      'SELECT competency_id FROM competency_definitions WHERE competency_id = ? AND definition_version = ? LIMIT 1',
    ).bind(requirement.competency_id, requirement.definition_version).first<{ competency_id: string }>();
    if (!definition) return false;
  }
  return true;
}

async function loadCompletionRecord(db: P8Database, internshipId: string, learnerId: string) {
  return db.prepare(
    'SELECT * FROM completion_records WHERE internship_id = ? AND learner_id = ? LIMIT 1',
  ).bind(internshipId, learnerId).first<Record<string, unknown>>();
}

async function recoverCompletionLifecycle(
  db: P8Database,
  actorId: string,
  internshipId: string,
  record: Record<string, unknown>,
  now: number,
): Promise<Record<string, unknown> | null> {
  const completedAt = Number(record.completed_at || 0);
  const requestId = cleanId(record.request_id);
  if (completedAt <= 0 || !requestId) return ownedInternship(db, actorId, internshipId);
  const activityId = generated('ia');
  const snapshotHash = String(record.gate_snapshot_hash || '');
  const recordId = String(record.id || '');
  try {
    await db.batch([
      db.prepare(
        "UPDATE internship_instances SET status='completed', lifecycle_stage='completed', completed_at=?, updated_at=? " +
        "WHERE id=? AND learner_id=? AND status='active' AND EXISTS (" +
        'SELECT 1 FROM completion_records c WHERE c.id=? AND c.internship_id=internship_instances.id AND c.learner_id=internship_instances.learner_id)',
      ).bind(completedAt, now, internshipId, actorId, recordId),
      db.prepare(
        "UPDATE internship_memberships SET status='completed', updated_at=? WHERE internship_id=? AND actor_id=? AND role='learner' " +
        "AND EXISTS (SELECT 1 FROM internship_instances i WHERE i.id=? AND i.learner_id=? AND i.status='completed')",
      ).bind(now, internshipId, actorId, internshipId, actorId),
      db.prepare(
        "INSERT OR IGNORE INTO internship_activity(id, internship_id, actor_id, event_type, event_time, request_id, detail) " +
        "SELECT ?, ?, ?, 'internship_completed', ?, ?, ? WHERE EXISTS (" +
        "SELECT 1 FROM internship_instances i WHERE i.id=? AND i.learner_id=? AND i.status='completed')",
      ).bind(activityId, internshipId, actorId, completedAt, requestId, snapshotHash, internshipId, actorId),
    ]);
  } catch {
    // Re-read authoritative state below. Never rewrite the immutable completion record.
  }
  return ownedInternship(db, actorId, internshipId);
}

function completedEvaluation(row: Record<string, unknown>, record: Record<string, unknown>, now: number): Evaluation {
  const snapshot = parse(record.gate_snapshot_json, {}) as Record<string, any>;
  return {
    evaluated_at: now,
    qualifying: true,
    lifecycle_status: 'completed',
    scenario_version_id: String(record.scenario_version_id || row.scenario_version_id || ''),
    completion_policy_schema_version: integer(record.completion_policy_schema_version) || null,
    completion_policy_hash: String(record.completion_policy_hash || ''),
    overall_eligible: true,
    blockers: [],
    duration: snapshot.duration || { passed: true },
    required_tasks: snapshot.required_tasks || { passed: true },
    required_reviews: snapshot.required_reviews || { passed: true },
    evidence: snapshot.evidence || { passed: true },
    capstone_final_review: snapshot.capstone_final_review || { passed: true },
    evidence_refs: array(parse(record.evidence_refs_json, [])).map(String),
    passport_aggregation_ruleset_versions: array(parse(record.passport_aggregation_ruleset_versions_json, [])).map(String),
    evidence_ruleset_versions: array(parse(record.evidence_ruleset_versions_json, [])).map(String),
  };
}

async function evaluateCompletionEligibility(
  db: P8Database,
  actorId: string,
  internshipId: string,
  now: number,
): Promise<{ evaluation: Evaluation; row: Record<string, unknown> | null; policy: CompletionPolicy | null }> {
  const row = await ownedInternship(db, actorId, internshipId);
  const emptyGate = { passed: false };
  if (!row) {
    return {
      row: null,
      policy: null,
      evaluation: {
        evaluated_at: now, qualifying: false, lifecycle_status: 'missing', scenario_version_id: '',
        completion_policy_schema_version: null, completion_policy_hash: '', overall_eligible: false,
        blockers: ['internship_not_found'], duration: emptyGate, required_tasks: emptyGate,
        required_reviews: emptyGate, evidence: emptyGate, capstone_final_review: emptyGate,
        evidence_refs: [], passport_aggregation_ruleset_versions: [], evidence_ruleset_versions: [],
      },
    };
  }

  const existing = await loadCompletionRecord(db, internshipId, actorId);
  if (String(row.status) === 'completed' && existing) {
    return { row, policy: null, evaluation: completedEvaluation(row, existing, now) };
  }

  const blockers: string[] = [];
  const manifest = scenarioManifest(row.canonical_json);
  const manifestQualifying = manifest?.qualifying === true && String(manifest.classification || '') === 'qualifying';
  const qualifying = Number(row.qualifying) === 1 && String(row.mode) === 'standard' && manifestQualifying;
  if (!qualifying) blockers.push('non_qualifying_internship');
  if (String(row.status) === 'stopped') blockers.push('internship_stopped');
  if (String(row.status) !== 'active' && String(row.status) !== 'stopped') blockers.push('internship_not_active');

  const elapsedSeconds = Math.max(0, now - Number(row.started_at || 0));
  const requiredDurationDays = Number(row.minimum_duration_days || 0);
  const durationPassed = elapsedSeconds >= requiredDurationDays * INTERNSHIP_DAY_SECONDS;
  const duration = {
    passed: durationPassed,
    elapsed_seconds: elapsedSeconds,
    elapsed_days: Math.floor(elapsedSeconds / INTERNSHIP_DAY_SECONDS),
    required_days: requiredDurationDays,
    target_end_at: Number(row.target_end_at || 0),
  };
  if (!durationPassed) blockers.push('duration_not_met');

  const policy = parsePolicy(row.policy_json);
  const policyHash = String(row.policy_hash || '');
  const calculatedPolicyHash = policy ? await sha256Hex(canonicalJson(policy)) : '';
  const policyValid = Boolean(
    policy &&
    integer(row.policy_schema_version) === COMPLETION_POLICY_SCHEMA_VERSION &&
    HEX64.test(policyHash) &&
    calculatedPolicyHash === policyHash &&
    await policyReferencesValid(db, String(row.scenario_version_id || ''), policy)
  );
  if (!policyValid) {
    blockers.push('completion_policy_unavailable');
    return {
      row,
      policy: null,
      evaluation: {
        evaluated_at: now,
        qualifying,
        lifecycle_status: String(row.status || ''),
        scenario_version_id: String(row.scenario_version_id || ''),
        completion_policy_schema_version: null,
        completion_policy_hash: policyHash,
        overall_eligible: false,
        blockers: [...new Set(blockers)],
        duration,
        required_tasks: { passed: false, required: 0, completed: 0 },
        required_reviews: { passed: false, required: 0, completed: 0 },
        evidence: { passed: false, required: 0, satisfied: 0, competencies: [] },
        capstone_final_review: { passed: false, capstones_required: 0, capstones_completed: 0, final_review_required: false, final_review_finalized: false },
        evidence_refs: [],
        passport_aggregation_ruleset_versions: [],
        evidence_ruleset_versions: [],
      },
    };
  }

  const taskState = new Map<string, string>();
  const allPolicyTasks = [...new Set([...policy!.required_task_ids, ...policy!.capstone_task_ids])];
  if (allPolicyTasks.length) {
    const placeholders = allPolicyTasks.map(() => '?').join(',');
    const rows = (await db.prepare(
      'SELECT task_id, status FROM internship_tasks WHERE internship_id = ? AND task_id IN (' + placeholders + ')',
    ).bind(internshipId, ...allPolicyTasks).all<Record<string, unknown>>()).results || [];
    for (const task of rows) taskState.set(String(task.task_id), String(task.status));
  }
  const requiredCompleted = policy!.required_task_ids.filter((taskId) => taskState.get(taskId) === 'completed').length;
  const requiredTasksPassed = requiredCompleted === policy!.required_task_ids.length;
  const requiredTasks = {
    passed: requiredTasksPassed,
    required: policy!.required_task_ids.length,
    completed: requiredCompleted,
  };
  if (!requiredTasksPassed) blockers.push('required_tasks_incomplete');

  const reviewRows = (await db.prepare(
    "SELECT id, review_type, finalized_at FROM internship_performance_reviews WHERE internship_id = ? AND status = 'finalized' ORDER BY finalized_at DESC, id DESC",
  ).bind(internshipId).all<Record<string, unknown>>()).results || [];
  const reviewByType = new Map<string, Record<string, unknown>>();
  for (const review of reviewRows) {
    const kind = String(review.review_type || '');
    if (!reviewByType.has(kind)) reviewByType.set(kind, review);
  }
  const reviewsCompleted = policy!.required_review_types.filter((kind) => reviewByType.has(kind)).length;
  const requiredReviewsPassed = reviewsCompleted === policy!.required_review_types.length;
  const requiredReviews = {
    passed: requiredReviewsPassed,
    required: policy!.required_review_types.length,
    completed: reviewsCompleted,
    required_types: policy!.required_review_types,
  };
  if (!requiredReviewsPassed) blockers.push('required_review_missing');

  const evidenceRefs = new Set<string>();
  const aggregationVersions = new Set<string>();
  const evidenceRulesetVersions = new Set<string>();
  const competencySummaries: Array<Record<string, unknown>> = [];
  let evidenceSatisfied = 0;
  for (const requirement of policy!.required_competencies) {
    const passport = await db.prepare(
      'SELECT p.current_level, p.evidence_strength_summary, p.evidence_count, p.independent_count, p.distinct_context_count, ' +
      'p.aggregation_ruleset_version, d.name ' +
      'FROM competency_passports p JOIN competency_definitions d ON d.competency_id=p.competency_id AND d.definition_version=p.definition_version ' +
      'WHERE p.learner_id = ? AND p.competency_id = ? AND p.definition_version = ? LIMIT 1',
    ).bind(actorId, requirement.competency_id, requirement.definition_version).first<Record<string, unknown>>();

    const levelOk = Boolean(passport && (LEVEL_ORDER[String(passport.current_level || '')] ?? -1) >= LEVEL_ORDER[requirement.minimum_level]);
    const strengthOk = Boolean(passport && (STRENGTH_ORDER[String(passport.evidence_strength_summary || '')] ?? -1) >= STRENGTH_ORDER[requirement.minimum_evidence_strength]);
    const recordsOk = Boolean(passport && Number(passport.evidence_count || 0) >= requirement.minimum_evidence_records);
    const independentOk = Boolean(passport && Number(passport.independent_count || 0) >= requirement.minimum_independent_demonstrations);
    const contextsOk = Boolean(passport && Number(passport.distinct_context_count || 0) >= requirement.minimum_distinct_contexts);
    const passed = levelOk && strengthOk && recordsOk && independentOk && contextsOk;
    if (passed) evidenceSatisfied += 1;
    if (passport?.aggregation_ruleset_version) aggregationVersions.add(String(passport.aggregation_ruleset_version));

    const refs = (await db.prepare(
      "SELECT e.id, e.evidence_ruleset_version FROM competency_evidence e " +
      "WHERE e.learner_id = ? AND e.competency_id = ? AND " +
      "(e.definition_version = ? OR EXISTS (" +
      "SELECT 1 FROM competency_definition_compatibility c WHERE c.competency_id=e.competency_id " +
      "AND c.from_version=e.definition_version AND c.to_version=? AND c.compatibility='compatible')) " +
      "AND e.demonstrated_level <> 'not_demonstrated' AND NOT EXISTS (" +
      "SELECT 1 FROM competency_evidence_adjustments a WHERE a.evidence_id=e.id AND a.action IN ('revoked','superseded')) " +
      "ORDER BY e.created_at ASC, e.id ASC",
    ).bind(actorId, requirement.competency_id, requirement.definition_version, requirement.definition_version)
      .all<Record<string, unknown>>()).results || [];
    for (const ref of refs) {
      if (ref.id) evidenceRefs.add(String(ref.id));
      if (ref.evidence_ruleset_version) evidenceRulesetVersions.add(String(ref.evidence_ruleset_version));
    }

    competencySummaries.push({
      competency_id: requirement.competency_id,
      name: String(passport?.name || requirement.competency_id),
      definition_version: requirement.definition_version,
      minimum_level: requirement.minimum_level,
      current_level: String(passport?.current_level || ''),
      minimum_evidence_strength: requirement.minimum_evidence_strength,
      current_evidence_strength: String(passport?.evidence_strength_summary || ''),
      minimum_evidence_records: requirement.minimum_evidence_records,
      evidence_records: Number(passport?.evidence_count || 0),
      minimum_independent_demonstrations: requirement.minimum_independent_demonstrations,
      independent_demonstrations: Number(passport?.independent_count || 0),
      minimum_distinct_contexts: requirement.minimum_distinct_contexts,
      distinct_contexts: Number(passport?.distinct_context_count || 0),
      passed,
    });
  }
  const evidencePassed = evidenceSatisfied === policy!.required_competencies.length;
  const evidence = {
    passed: evidencePassed,
    required: policy!.required_competencies.length,
    satisfied: evidenceSatisfied,
    competencies: competencySummaries,
  };
  if (!evidencePassed) blockers.push('competency_evidence_insufficient');

  const capstoneCompleted = policy!.capstone_task_ids.filter((taskId) => taskState.get(taskId) === 'completed').length;
  const capstonesPassed = capstoneCompleted === policy!.capstone_task_ids.length;
  if (!capstonesPassed) blockers.push('capstone_incomplete');

  const finalReview = reviewByType.get('final');
  const finalRequired = policy!.require_final_review;
  const finalExists = Boolean(finalReview);
  if (finalRequired && !finalExists) blockers.push('final_review_missing');

  let lastCapstoneCompletedAt = 0;
  if (policy!.capstone_task_ids.length && capstonesPassed) {
    const placeholders = policy!.capstone_task_ids.map(() => '?').join(',');
    const activity = await db.prepare(
      "SELECT MAX(event_time) AS completed_at FROM internship_artifact_activity WHERE internship_id = ? " +
      "AND event_type = 'task_completed' AND task_id IN (" + placeholders + ')',
    ).bind(internshipId, ...policy!.capstone_task_ids).first<{ completed_at: number | null }>();
    lastCapstoneCompletedAt = Number(activity?.completed_at || 0);
  }
  const finalAfterCapstone = !policy!.final_review_after_capstone || (
    finalExists && lastCapstoneCompletedAt > 0 && Number(finalReview?.finalized_at || 0) >= lastCapstoneCompletedAt
  );
  if (policy!.final_review_after_capstone && finalExists && !finalAfterCapstone) {
    blockers.push('final_review_precedes_capstone');
  }
  const capstoneFinalPassed = capstonesPassed && (!finalRequired || finalExists) && finalAfterCapstone;
  const capstoneFinalReview = {
    passed: capstoneFinalPassed,
    capstones_required: policy!.capstone_task_ids.length,
    capstones_completed: capstoneCompleted,
    final_review_required: finalRequired,
    final_review_finalized: finalExists,
    final_review_after_capstone: policy!.final_review_after_capstone,
    final_review_finalized_at: Number(finalReview?.finalized_at || 0),
    capstone_completed_at: lastCapstoneCompletedAt,
  };

  const uniqueBlockers = [...new Set(blockers)];
  const overallEligible =
    uniqueBlockers.length === 0 && qualifying && String(row.status) === 'active' &&
    durationPassed && requiredTasksPassed && requiredReviewsPassed && evidencePassed && capstoneFinalPassed;

  return {
    row,
    policy,
    evaluation: {
      evaluated_at: now,
      qualifying,
      lifecycle_status: String(row.status || ''),
      scenario_version_id: String(row.scenario_version_id || ''),
      completion_policy_schema_version: COMPLETION_POLICY_SCHEMA_VERSION,
      completion_policy_hash: policyHash,
      overall_eligible: overallEligible,
      blockers: uniqueBlockers,
      duration,
      required_tasks: requiredTasks,
      required_reviews: requiredReviews,
      evidence,
      capstone_final_review: capstoneFinalReview,
      evidence_refs: [...evidenceRefs].sort(),
      passport_aggregation_ruleset_versions: [...aggregationVersions].sort(),
      evidence_ruleset_versions: [...evidenceRulesetVersions].sort(),
    },
  };
}

function learnerSafeEvaluation(evaluation: Evaluation, completedAt = 0) {
  return {
    evaluated_at: evaluation.evaluated_at,
    lifecycle_status: evaluation.lifecycle_status,
    qualifying: evaluation.qualifying,
    overall_eligible: evaluation.overall_eligible,
    blockers: evaluation.blockers,
    duration: evaluation.duration,
    required_work: evaluation.required_tasks,
    reviews: evaluation.required_reviews,
    evidence: evaluation.evidence,
    capstone_final_review: evaluation.capstone_final_review,
    completed_at: completedAt || null,
  };
}

async function finalizeCompletion(
  db: P8Database,
  actorId: string,
  internshipId: string,
  requestId: string,
  now: number,
): Promise<Response> {
  const replay = await loadCompletionRecord(db, internshipId, actorId);
  if (replay) {
    let row = await ownedInternship(db, actorId, internshipId);
    if (!row) return json({ error: 'internship_not_found' }, 404);
    if (String(row.status) === 'active') {
      row = await recoverCompletionLifecycle(db, actorId, internshipId, replay, now);
    }
    if (!row || String(row.status) !== 'completed') {
      return json({ error: 'internship_completion_integrity_conflict' }, 409);
    }
    const evaluation = completedEvaluation(row, replay, now);
    return json({
      ok: true,
      idempotent_replay: true,
      completion_record_id: String(replay.id || ''),
      completion: learnerSafeEvaluation(evaluation, Number(replay.completed_at || 0)),
    });
  }

  // Never trust a browser eligibility response. Every gate is recomputed here.
  const checked = await evaluateCompletionEligibility(db, actorId, internshipId, now);
  if (!checked.row) return json({ error: 'internship_not_found' }, 404);
  if (!checked.evaluation.overall_eligible || !checked.policy) {
    return json({
      error: 'internship_completion_blocked',
      completion: learnerSafeEvaluation(checked.evaluation),
    }, 409);
  }

  const recordId = generated('vcr');
  const activityId = generated('ia');
  const gateSnapshot = {
    schema_version: 1,
    evaluated_at: now,
    scenario_version_id: checked.evaluation.scenario_version_id,
    completion_policy_schema_version: checked.evaluation.completion_policy_schema_version,
    completion_policy_hash: checked.evaluation.completion_policy_hash,
    evaluator_version: COMPLETION_EVALUATOR_VERSION,
    duration: checked.evaluation.duration,
    required_tasks: checked.evaluation.required_tasks,
    required_reviews: checked.evaluation.required_reviews,
    evidence: checked.evaluation.evidence,
    capstone_final_review: checked.evaluation.capstone_final_review,
    evidence_refs: checked.evaluation.evidence_refs,
    passport_aggregation_ruleset_versions: checked.evaluation.passport_aggregation_ruleset_versions,
    evidence_ruleset_versions: checked.evaluation.evidence_ruleset_versions,
  };
  const snapshotJson = canonicalJson(gateSnapshot);
  const snapshotHash = await sha256Hex(snapshotJson);
  const aggregationJson = canonicalJson(checked.evaluation.passport_aggregation_ruleset_versions);
  const evidenceRulesJson = canonicalJson(checked.evaluation.evidence_ruleset_versions);
  const evidenceRefsJson = canonicalJson(checked.evaluation.evidence_refs);

  try {
    await db.batch([
      db.prepare(
        'INSERT OR IGNORE INTO completion_records(' +
        'id, internship_id, learner_id, scenario_pack_id, scenario_version_id, completion_policy_schema_version, ' +
        'completion_policy_hash, completed_at, required_duration_days, gate_snapshot_json, gate_snapshot_hash, evaluator_version, ' +
        'request_id, passport_aggregation_ruleset_versions_json, evidence_ruleset_versions_json, evidence_refs_json, created_at) ' +
        'SELECT ?, i.id, i.learner_id, i.scenario_pack_id, i.scenario_version_id, ?, ?, ?, i.minimum_duration_days, ?, ?, ?, ?, ?, ?, ?, ? ' +
        "FROM internship_instances i WHERE i.id=? AND i.learner_id=? AND i.status='active' AND i.mode='standard' AND i.qualifying=1 " +
        'AND NOT EXISTS (SELECT 1 FROM completion_records c WHERE c.internship_id=i.id)',
      ).bind(
        recordId, COMPLETION_POLICY_SCHEMA_VERSION, checked.evaluation.completion_policy_hash, now,
        snapshotJson, snapshotHash, COMPLETION_EVALUATOR_VERSION, requestId, aggregationJson,
        evidenceRulesJson, evidenceRefsJson, now, internshipId, actorId,
      ),
      db.prepare(
        "UPDATE internship_instances SET status='completed', lifecycle_stage='completed', completed_at=?, updated_at=? " +
        "WHERE id=? AND learner_id=? AND status='active' AND EXISTS (" +
        'SELECT 1 FROM completion_records c WHERE c.id=? AND c.internship_id=internship_instances.id)',
      ).bind(now, now, internshipId, actorId, recordId),
      db.prepare(
        "UPDATE internship_memberships SET status='completed', updated_at=? WHERE internship_id=? AND actor_id=? AND role='learner' " +
        "AND EXISTS (SELECT 1 FROM completion_records c WHERE c.id=? AND c.internship_id=internship_memberships.internship_id)",
      ).bind(now, internshipId, actorId, recordId),
      db.prepare(
        "INSERT OR IGNORE INTO internship_activity(id, internship_id, actor_id, event_type, event_time, request_id, detail) " +
        "SELECT ?, ?, ?, 'internship_completed', ?, ?, ? WHERE EXISTS (" +
        'SELECT 1 FROM completion_records c WHERE c.id=? AND c.internship_id=?)',
      ).bind(activityId, internshipId, actorId, now, requestId, snapshotHash, recordId, internshipId),
    ]);
  } catch {
    // A concurrent terminal transition or retry is resolved by the authoritative rows below.
  }

  const record = await loadCompletionRecord(db, internshipId, actorId);
  const rowAfter = await ownedInternship(db, actorId, internshipId);
  if (record && rowAfter && String(rowAfter.status) === 'completed') {
    const evaluation = completedEvaluation(rowAfter, record, now);
    return json({
      ok: true,
      idempotent_replay: String(record.id || '') !== recordId,
      completion_record_id: String(record.id || ''),
      completion: learnerSafeEvaluation(evaluation, Number(record.completed_at || 0)),
    });
  }

  const rechecked = await evaluateCompletionEligibility(db, actorId, internshipId, now);
  return json({
    error: 'internship_completion_conflict',
    completion: learnerSafeEvaluation(rechecked.evaluation),
  }, 409);
}

async function integrityStatus(db: P8Database, actorId: string, internshipId: string) {
  const row = await ownedInternship(db, actorId, internshipId);
  if (!row) return null;
  const records = (await db.prepare(
    'SELECT id, gate_snapshot_json, gate_snapshot_hash FROM completion_records WHERE internship_id=? AND learner_id=? ORDER BY created_at',
  ).bind(internshipId, actorId).all<Record<string, unknown>>()).results || [];
  const issues: string[] = [];
  if (String(row.status) === 'completed' && records.length !== 1) issues.push('completed_record_count_invalid');
  if (String(row.status) !== 'completed' && records.length !== 0) issues.push('non_completed_has_completion_record');
  if (records.length === 1) {
    const actual = await sha256Hex(String(records[0].gate_snapshot_json || ''));
    if (actual !== String(records[0].gate_snapshot_hash || '')) issues.push('completion_snapshot_hash_mismatch');
  }
  const version = await db.prepare('SELECT id FROM scenario_versions WHERE id=? LIMIT 1')
    .bind(String(row.scenario_version_id || '')).first<{ id: string }>();
  if (!version) issues.push('scenario_version_missing');
  return { ok: issues.length === 0, issues, completion_record_count: records.length };
}

export async function handlePhase8CompletionPersistenceRoute(
  request: Request,
  env: P8Env,
  route: string,
  now: number,
): Promise<Response | null> {
  if (route === '/scenario-completion-policy/install' && request.method === 'POST') {
    const body = await bodyJson(request);
    const scenarioVersionId = cleanId(body.scenario_version_id);
    const suppliedHash = String(body.policy_hash ?? '').trim();
    const policyObject = body.policy;
    if (!scenarioVersionId || !HEX64.test(suppliedHash) || !policyObject || typeof policyObject !== 'object' || Array.isArray(policyObject)) {
      return json({ error: 'completion_policy_invalid' }, 400);
    }
    const policy = parsePolicy(canonicalJson(policyObject));
    if (!policy) return json({ error: 'completion_policy_invalid' }, 400);
    const actualHash = await sha256Hex(canonicalJson(policy));
    if (actualHash !== suppliedHash) return json({ error: 'completion_policy_hash_mismatch' }, 409);
    const scenario = await env.TUTOR_DB.prepare(
      "SELECT id FROM scenario_versions WHERE id=? AND status='published' LIMIT 1",
    ).bind(scenarioVersionId).first<{ id: string }>();
    if (!scenario || !await policyReferencesValid(env.TUTOR_DB, scenarioVersionId, policy)) {
      return json({ error: 'completion_policy_invalid' }, 400);
    }
    const existing = await env.TUTOR_DB.prepare(
      'SELECT policy_hash FROM scenario_completion_policies WHERE scenario_version_id=? LIMIT 1',
    ).bind(scenarioVersionId).first<{ policy_hash: string }>();
    if (existing) {
      return existing.policy_hash === suppliedHash
        ? json({ ok: true, idempotent_replay: true, scenario_version_id: scenarioVersionId, policy_hash: suppliedHash })
        : json({ error: 'completion_policy_immutable_conflict' }, 409);
    }
    try {
      await env.TUTOR_DB.prepare(
        'INSERT INTO scenario_completion_policies(scenario_version_id,schema_version,policy_json,policy_hash,created_at) VALUES (?,?,?,?,?)',
      ).bind(scenarioVersionId, COMPLETION_POLICY_SCHEMA_VERSION, canonicalJson(policy), suppliedHash, now).run();
      return json({ ok: true, scenario_version_id: scenarioVersionId, policy_hash: suppliedHash }, 201);
    } catch {
      const raced = await env.TUTOR_DB.prepare(
        'SELECT policy_hash FROM scenario_completion_policies WHERE scenario_version_id=? LIMIT 1',
      ).bind(scenarioVersionId).first<{ policy_hash: string }>();
      return raced?.policy_hash === suppliedHash
        ? json({ ok: true, idempotent_replay: true, scenario_version_id: scenarioVersionId, policy_hash: suppliedHash })
        : json({ error: 'completion_policy_install_failed' }, 503);
    }
  }

  if (!route.startsWith('/internships/completion')) return null;
  const url = new URL(request.url);
  const isGet = request.method === 'GET';
  const body = isGet ? {} : await bodyJson(request);
  if (!isGet && ['learner_id', 'owner_id', 'user_id', 'completed_at', 'duration_met', 'tasks_complete', 'evidence_complete'].some((key) => key in body)) {
    return json({ error: 'invalid_completion_request' }, 400);
  }
  const actorId = cleanId(isGet ? url.searchParams.get('actor_id') : body.actor_id);
  const internshipId = cleanId(isGet ? url.searchParams.get('internship_id') : body.internship_id);
  if (!actorId || !await activeAccount(env.TUTOR_DB, actorId)) return json({ error: 'authentication_required' }, 401);
  if (!internshipId) return json({ error: 'internship_not_found' }, 404);

  if (route === '/internships/completion/status' && request.method === 'GET') {
    const checked = await evaluateCompletionEligibility(env.TUTOR_DB, actorId, internshipId, now);
    if (!checked.row) return json({ error: 'internship_not_found' }, 404);
    const record = await loadCompletionRecord(env.TUTOR_DB, internshipId, actorId);
    return json({
      ok: true,
      completion: learnerSafeEvaluation(checked.evaluation, Number(record?.completed_at || 0)),
    });
  }

  if (route === '/internships/completion/finalize' && request.method === 'POST') {
    const requestId = cleanRequestId(body.request_id);
    if (!requestId) return json({ error: 'invalid_completion_request' }, 400);
    return finalizeCompletion(env.TUTOR_DB, actorId, internshipId, requestId, now);
  }

  if (route === '/internships/completion/integrity' && request.method === 'GET') {
    const result = await integrityStatus(env.TUTOR_DB, actorId, internshipId);
    if (!result) return json({ error: 'internship_not_found' }, 404);
    return json(result, result.ok ? 200 : 409);
  }

  return json({ error: 'completion_route_not_found' }, 404);
}

export {
  COMPLETION_EVALUATOR_VERSION,
  COMPLETION_POLICY_SCHEMA_VERSION,
  evaluateCompletionEligibility,
};
