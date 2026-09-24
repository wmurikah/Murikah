type P9Statement = {
  bind(...values: unknown[]): P9Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type P9Database = {
  prepare(query: string): P9Statement;
  batch(statements: P9Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
type P9R2Object = { body: ReadableStream<Uint8Array>; size: number; customMetadata?: Record<string,string> };
type P9Bucket = {
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer, options?: { customMetadata?: Record<string,string> }): Promise<unknown>;
  get(key: string): Promise<P9R2Object | null>;
  delete(key: string): Promise<void>;
};
type P9Env = {
  TUTOR_DB: P9Database;
  TUTOR_FILES: P9Bucket;
  MURIKAH_PUBLIC_BASE_URL?: string;
};

export const PERFORMANCE_REPORT_SOURCE_SCHEMA_VERSION = 1;
export const COMPLETION_LETTER_SOURCE_SCHEMA_VERSION = 1;
export const PERFORMANCE_REPORT_TEMPLATE_VERSION = 'phase9-performance-report-v1';
export const COMPLETION_LETTER_TEMPLATE_VERSION = 'phase9-completion-letter-v1';
export const SIMULATION_DISCLOSURE_VERSION = 'phase9-simulation-disclosure-v1';
export const SIMULATION_DISCLOSURE =
  'This document covers a Murikah Virtual Internship simulation. It does not represent employment by the simulated organization, a real-employer reference, statutory industrial attachment approval, or institution endorsement unless a separately verified endorsement is explicitly shown.';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{3,128}$/;
const REFERENCE_ID = /^vr_[0-9a-f]{48}$/;
const VERIFY_CODE = /^vc_[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DOCUMENT_TYPES = new Set(['performance_report','completion_letter']);

export type VerifiedInstitutionEndorsement = {
  institution_id: string;
  verified_institution_name: string;
  authorized_signer_id: string;
  signer_role: string;
  endorsement_type: string;
  endorsed_at: number;
  verification_status: 'verified';
  signature_reference: string;
};

type EvidenceReference = {
  label: string;
  reference_type: 'performance_review' | 'competency_evidence';
  canonical_id: string;
  task_id: string;
  task_title: string;
  artifact_id: string;
  artifact_title: string;
  artifact_type: string;
  artifact_version: number;
  submission_id: string;
  assessment_id: string;
  criterion_id: string;
  competency_id: string;
  competency_name: string;
  demonstrated_level: string;
  evidence_strength: string;
  assistance_context: string;
  limitation: string;
};

export type PerformanceReportSourceV1 = {
  schema_version: 1;
  completion_record_id: string;
  completion_snapshot_hash: string;
  learner_name_snapshot: string;
  identity_note: string;
  internship_title: string;
  simulated_organization: string;
  organization_is_simulated: true;
  internship_started_at: number;
  internship_completed_at: number;
  total_duration_days: number;
  expected_workload_band: string;
  role_title: string;
  role_summary: string;
  key_assignments: Array<{ task_id: string; title: string; category: string; capstone: boolean }>;
  work_products_completed: Array<{
    artifact_id: string; task_id: string; title: string; artifact_type: string;
    deliverable_type: string; artifact_version_id: string; artifact_version: number;
    submission_id: string; accepted_at: number;
  }>;
  performance_review: {
    final_review_id: string;
    finalized_at: number;
    strengths: string[];
    development_areas: string[];
    assistance_summary: Record<string, unknown>;
    narrative: string;
  };
  competency_summary: Array<{
    competency_id: string; name: string; level_demonstrated: string; evidence_strength: string;
    evidence_records: number; independent_demonstrations: number; distinct_contexts: number;
    evidence_reference_labels: string[];
  }>;
  strengths: string[];
  development_areas: string[];
  evidence_highlights: EvidenceReference[];
  assistance_independence_context: string[];
  midpoint_to_final_improvement: string[];
  supervisor_style_narrative: string;
  learner_reflection_summary: { reflection_id: string; period_key: string; summary: string } | null;
  limitations: string[];
  evidence_references: EvidenceReference[];
  simulation_disclosure: string;
  simulation_disclosure_version: string;
  endorsement: VerifiedInstitutionEndorsement | null;
};

export type CompletionLetterSourceV1 = {
  schema_version: 1;
  completion_record_id: string;
  completion_snapshot_hash: string;
  learner_name_snapshot: string;
  internship_title: string;
  simulated_organization: string;
  simulated_role: string;
  internship_started_at: number;
  internship_completed_at: number;
  work_categories: string[];
  deliverables_completed: Array<{ title: string; artifact_type: string }>;
  competencies: Array<{ name: string; level_demonstrated: string; evidence_strength: string }>;
  simulation_disclosure: string;
  simulation_disclosure_version: string;
  endorsement: VerifiedInstitutionEndorsement | null;
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
  } catch { return {}; }
}
function id(value: unknown): string {
  const text = String(value ?? '').trim();
  return ID.test(text) ? text : '';
}
function requestId(value: unknown): string {
  const text = String(value ?? '').trim();
  return REQUEST_ID.test(text) ? text : '';
}
function text(value: unknown, limit = 8000): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function parse(value: unknown, fallback: any): any {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
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
function canonicalJson(value: unknown): string { return JSON.stringify(stable(value)); }
async function sha256String(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2,'0')).join('');
}
async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2,'0')).join('');
}
function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (b) => b.toString(16).padStart(2,'0')).join('');
}
function generated(prefix: string): string { return prefix + '_' + crypto.randomUUID().replace(/-/g,''); }
function encodeUtf8(value: string): ArrayBuffer {
  const data = new TextEncoder().encode(value);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[char] || char));
}
function dateLabel(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0,10) : 'Not recorded';
}
function findingList(value: unknown): string[] {
  const rows = array(value);
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const cleaned = text(row, 1200);
      if (cleaned) out.push(cleaned);
      continue;
    }
    if (row && typeof row === 'object') {
      const object = row as Record<string, unknown>;
      const candidate = text(
        object.summary ?? object.title ?? object.label ?? object.finding ?? object.text ?? canonicalJson(object),
        1200,
      );
      if (candidate) out.push(candidate);
    }
  }
  return [...new Set(out)];
}
function extractReflection(value: unknown): string {
  const cleaned = text(value, 20000);
  if (!cleaned) return '';
  const matches = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  const picked = matches.slice(0,2).join(' ').trim();
  return (picked || cleaned).slice(0,800);
}
function assistanceLabel(level: number): string {
  if (level <= 1) return 'Independent demonstration';
  if (level <= 2) return 'Light coaching used';
  return 'Applied with support';
}
async function activeAccount(db: P9Database, actorId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT role, account_status FROM tutor_accounts WHERE actor_id=? LIMIT 1",
  ).bind(actorId).first<{role:string;account_status:string}>();
  return Boolean(row && ['member','admin'].includes(row.role) && row.account_status === 'active');
}
function documentMeta(row: Record<string, unknown>) {
  return {
    document_id: String(row.id || ''),
    internship_id: String(row.internship_id || ''),
    completion_record_id: String(row.completion_record_id || ''),
    document_type: String(row.document_type || ''),
    document_version: Number(row.document_version || 0),
    template_version: String(row.template_version || ''),
    issued_at: Number(row.issued_at || 0),
    issuance_status: String(row.issuance_status || ''),
    verification_reference_id: String(row.verification_reference_id || ''),
    sha256: String(row.document_sha256 || ''),
    size_bytes: Number(row.size_bytes || 0),
    content_type: String(row.content_type || ''),
    simulation_disclosure: SIMULATION_DISCLOSURE,
    simulation_disclosure_version: String(row.simulation_disclosure_version || ''),
    superseded_at: Number(row.superseded_at || 0) || null,
    superseded_by_document_id: String(row.superseded_by_document_id || '') || null,
  };
}

async function completionContext(db: P9Database, actorId: string, internshipId: string) {
  return db.prepare(
    'SELECT c.*, i.status AS internship_status, i.mode, i.qualifying, i.started_at, ' +
    'i.completed_at AS lifecycle_completed_at, sp.title AS pack_title, sp.role_title AS pack_role_title, ' +
    'sv.expected_workload_band, svc.canonical_json, scp.policy_json, scp.policy_hash AS installed_policy_hash, ' +
    'a.preferred_name, a.username ' +
    'FROM completion_records c ' +
    'JOIN internship_instances i ON i.id=c.internship_id AND i.learner_id=c.learner_id ' +
    'JOIN scenario_packs sp ON sp.id=c.scenario_pack_id ' +
    'JOIN scenario_versions sv ON sv.id=c.scenario_version_id ' +
    'JOIN scenario_version_content svc ON svc.scenario_version_id=c.scenario_version_id ' +
    'JOIN scenario_completion_policies scp ON scp.scenario_version_id=c.scenario_version_id ' +
    'JOIN tutor_accounts a ON a.actor_id=c.learner_id ' +
    'WHERE c.internship_id=? AND c.learner_id=? LIMIT 1',
  ).bind(internshipId,actorId).first<Record<string,unknown>>();
}

async function loadReviews(db: P9Database, internshipId: string, completedAt: number) {
  const rows = (await db.prepare(
    "SELECT * FROM internship_performance_reviews WHERE internship_id=? AND status='finalized' " +
    'AND finalized_at<=? ORDER BY finalized_at DESC, id DESC',
  ).bind(internshipId,completedAt).all<Record<string,unknown>>()).results || [];
  const byType = new Map<string,Record<string,unknown>>();
  for (const row of rows) {
    const kind = String(row.review_type || '');
    if (!byType.has(kind)) byType.set(kind,row);
  }
  return { midpoint: byType.get('midpoint') || null, final: byType.get('final') || null };
}

async function loadEvidence(
  db: P9Database,
  actorId: string,
  evidenceIds: string[],
  canonicalTasks: Map<string,Record<string,unknown>>,
): Promise<{ rows: Record<string,unknown>[]; references: EvidenceReference[] }> {
  if (!evidenceIds.length) return { rows: [], references: [] };
  const placeholders = evidenceIds.map(() => '?').join(',');
  const rows = (await db.prepare(
    'SELECT e.id, e.internship_id, e.task_id, e.artifact_id, e.artifact_version_id, e.submission_id, ' +
    'e.assessment_id, e.criterion_id, e.competency_id, e.definition_version, e.demonstrated_level, ' +
    'e.assistance_level, e.assistance_context_json, e.evidence_strength, e.limitations_json, ' +
    'd.name AS competency_name, a.title AS artifact_title, a.artifact_type, v.version_number, ' +
    'ac.feedback AS assessment_feedback ' +
    'FROM competency_evidence e ' +
    'JOIN competency_definitions d ON d.competency_id=e.competency_id AND d.definition_version=e.definition_version ' +
    'JOIN internship_artifacts a ON a.id=e.artifact_id ' +
    'JOIN internship_artifact_versions v ON v.id=e.artifact_version_id ' +
    'JOIN internship_assessment_criteria ac ON ac.assessment_id=e.assessment_id AND ac.criterion_id=e.criterion_id ' +
    'WHERE e.id IN (' + placeholders + ') AND e.learner_id=?',
  ).bind(...evidenceIds,actorId).all<Record<string,unknown>>()).results || [];
  const byId = new Map(rows.map((row) => [String(row.id || ''), row]));
  if (evidenceIds.some((evidenceId) => !byId.has(evidenceId))) throw new Error('document_evidence_lineage_invalid');
  const references: EvidenceReference[] = evidenceIds.map((evidenceId,index) => {
    const row = byId.get(evidenceId)!;
    const task = canonicalTasks.get(String(row.task_id || ''));
    const limitations = findingList(parse(row.limitations_json,[]));
    return {
      label: 'E' + (index + 1),
      reference_type: 'competency_evidence',
      canonical_id: evidenceId,
      task_id: String(row.task_id || ''),
      task_title: text(task?.title || row.task_id || 'Task',240),
      artifact_id: String(row.artifact_id || ''),
      artifact_title: text(row.artifact_title,240),
      artifact_type: text(row.artifact_type,80),
      artifact_version: Number(row.version_number || 0),
      submission_id: String(row.submission_id || ''),
      assessment_id: String(row.assessment_id || ''),
      criterion_id: String(row.criterion_id || ''),
      competency_id: String(row.competency_id || ''),
      competency_name: text(row.competency_name,200),
      demonstrated_level: text(row.demonstrated_level,80),
      evidence_strength: text(row.evidence_strength,80),
      assistance_context: assistanceLabel(Number(row.assistance_level || 0)),
      limitation: limitations.join(' ') || text(row.assessment_feedback,800),
    };
  });
  return { rows, references };
}

function canonicalScenario(value: unknown) {
  const root = parse(value,{}) as Record<string,any>;
  const manifest = root.manifest && typeof root.manifest === 'object' ? root.manifest as Record<string,any> : {};
  const company = root.company && typeof root.company === 'object' ? root.company as Record<string,any> : {};
  const taskRows = Array.isArray(root.tasks) ? root.tasks : [];
  const tasks = new Map<string,Record<string,unknown>>();
  for (const row of taskRows) {
    if (row && typeof row === 'object' && id((row as any).task_id)) tasks.set(String((row as any).task_id),row as Record<string,unknown>);
  }
  return { root, manifest, company, tasks };
}

function improvement(midpoint: Record<string,unknown> | null, final: Record<string,unknown> | null): string[] {
  if (!midpoint || !final) return ['Insufficient comparable midpoint and final review evidence.'];
  const midDev = findingList(parse(midpoint.development_areas_json,[]));
  const finalDev = new Set(findingList(parse(final.development_areas_json,[])));
  const midStrength = new Set(findingList(parse(midpoint.strengths_json,[])));
  const finalStrength = findingList(parse(final.strengths_json,[]));
  const resolved = midDev.filter((item) => !finalDev.has(item)).map((item) => 'No longer listed as a final development area: ' + item);
  const emerged = finalStrength.filter((item) => !midStrength.has(item)).map((item) => 'New final-review strength: ' + item);
  const out = [...resolved,...emerged];
  return out.length ? out : ['Structured midpoint and final review records do not support a more specific change statement.'];
}

async function buildReportSource(
  db: P9Database,
  actorId: string,
  internshipId: string,
  learnerNameFromServer: string,
): Promise<PerformanceReportSourceV1> {
  const context = await completionContext(db,actorId,internshipId);
  if (!context) throw new Error('completion_record_not_found');
  if (
    String(context.internship_status) !== 'completed' ||
    String(context.mode) !== 'standard' ||
    Number(context.qualifying) !== 1 ||
    Number(context.lifecycle_completed_at || 0) !== Number(context.completed_at || 0)
  ) throw new Error('completion_record_not_qualifying');

  const snapshotJson = String(context.gate_snapshot_json || '');
  const snapshotHash = await sha256String(snapshotJson);
  if (!HEX64.test(String(context.gate_snapshot_hash || '')) || snapshotHash !== String(context.gate_snapshot_hash || '')) {
    throw new Error('completion_snapshot_integrity_failed');
  }
  if (String(context.installed_policy_hash || '') !== String(context.completion_policy_hash || '')) {
    throw new Error('completion_policy_integrity_failed');
  }

  const snapshot = parse(snapshotJson,{}) as Record<string,any>;
  const scenario = canonicalScenario(context.canonical_json);
  const manifest = scenario.manifest;
  const company = scenario.company;
  const policy = parse(context.policy_json,{}) as Record<string,any>;
  const requiredTaskIds = [...new Set([
    ...array(policy.required_task_ids).map(String),
    ...array(policy.capstone_task_ids).map(String),
  ])].filter((taskId) => scenario.tasks.has(taskId));
  const capstones = new Set(array(policy.capstone_task_ids).map(String));

  const taskRows = requiredTaskIds.length
    ? (await db.prepare(
        'SELECT task_id, status FROM internship_tasks WHERE internship_id=? AND task_id IN (' +
        requiredTaskIds.map(() => '?').join(',') + ')',
      ).bind(internshipId,...requiredTaskIds).all<Record<string,unknown>>()).results || []
    : [];
  const completedTasks = new Set(taskRows.filter((row) => String(row.status) === 'completed').map((row) => String(row.task_id)));
  const keyAssignments = requiredTaskIds.filter((taskId) => completedTasks.has(taskId)).map((taskId) => {
    const task = scenario.tasks.get(taskId) || {};
    return {
      task_id: taskId,
      title: text(task.title || taskId,240),
      category: text(task.category || 'work',80),
      capstone: capstones.has(taskId),
    };
  });

  const completedAt = Number(context.completed_at || 0);
  const artifacts = (await db.prepare(
    "SELECT a.id, a.task_id, a.title, a.artifact_type, a.deliverable_type, a.accepted_at, " +
    's.id AS submission_id, v.id AS artifact_version_id, v.version_number ' +
    'FROM internship_artifacts a ' +
    'JOIN internship_artifact_submissions s ON s.id=a.accepted_submission_id AND s.status=? ' +
    'JOIN internship_artifact_versions v ON v.id=s.artifact_version_id ' +
    "WHERE a.internship_id=? AND a.status='accepted' AND a.accepted_at<=? " +
    'ORDER BY a.accepted_at ASC, a.id ASC',
  ).bind('accepted',internshipId,completedAt).all<Record<string,unknown>>()).results || [];

  const reviews = await loadReviews(db,internshipId,completedAt);
  const finalReview = reviews.final;
  const finalStrengths = finalReview ? findingList(parse(finalReview.strengths_json,[])) : [];
  const finalDevelopment = finalReview ? findingList(parse(finalReview.development_areas_json,[])) : [];
  const finalAssistance = finalReview ? parse(finalReview.assistance_summary_json,{}) as Record<string,unknown> : {};

  const evidenceIds = array(parse(context.evidence_refs_json,[])).map(String).filter((item) => ID.test(item));
  const evidence = await loadEvidence(db,actorId,evidenceIds,scenario.tasks);
  const evidenceByCompetency = new Map<string,string[]>();
  const assistance = new Set<string>();
  const evidenceLimitations = new Set<string>();
  for (const ref of evidence.references) {
    const labels = evidenceByCompetency.get(ref.competency_id) || [];
    labels.push(ref.label);
    evidenceByCompetency.set(ref.competency_id,labels);
    assistance.add(ref.assistance_context);
    if (ref.limitation) evidenceLimitations.add(ref.limitation);
  }
  const reviewReferences: EvidenceReference[] = [];
  for (const [kind, review] of [['midpoint',reviews.midpoint],['final',reviews.final]] as const) {
    if (!review) continue;
    reviewReferences.push({
      label: 'E' + (evidence.references.length + reviewReferences.length + 1),
      reference_type: 'performance_review',
      canonical_id: String(review.id || ''),
      task_id: '',
      task_title: kind === 'midpoint' ? 'Midpoint performance review' : 'Final performance review',
      artifact_id: '',
      artifact_title: 'Finalized Phase 6 performance review',
      artifact_type: 'performance_review',
      artifact_version: Number(review.review_version || 1),
      submission_id: '',
      assessment_id: '',
      criterion_id: '',
      competency_id: '',
      competency_name: '',
      demonstrated_level: '',
      evidence_strength: '',
      assistance_context: text(canonicalJson(parse(review.assistance_summary_json,{})),500),
      limitation: 'Review conclusions are limited to the durable evidence snapshot recorded by Phase 6 at finalization.',
    });
  }
  const allEvidenceReferences = [...evidence.references,...reviewReferences];

  const competencyRows = array(snapshot?.evidence?.competencies).map((row) => row && typeof row === 'object' ? row as Record<string,unknown> : {});
  const competencies = competencyRows.map((row) => ({
    competency_id: String(row.competency_id || ''),
    name: text(row.name || row.competency_id || 'Competency',200),
    level_demonstrated: text(row.current_level || 'Not recorded',80),
    evidence_strength: text(row.current_evidence_strength || 'Not recorded',80),
    evidence_records: Number(row.evidence_records || 0),
    independent_demonstrations: Number(row.independent_demonstrations || 0),
    distinct_contexts: Number(row.distinct_contexts || 0),
    evidence_reference_labels: evidenceByCompetency.get(String(row.competency_id || '')) || [],
  }));

  const reflection = await db.prepare(
    'SELECT id, period_key, content FROM internship_reflections WHERE internship_id=? AND updated_at<=? ' +
    'ORDER BY updated_at DESC, id DESC LIMIT 1',
  ).bind(internshipId,completedAt).first<Record<string,unknown>>();

  const preferred = text(context.preferred_name,64);
  const username = text(context.username,128);
  const trustedName = text(learnerNameFromServer,100);
  const learnerName = trustedName || preferred || (!username.includes('@') ? username : '') || 'Learner';

  const startedAt = Number(context.started_at || 0);
  const durationDays = Math.max(0,Math.floor((completedAt - startedAt) / 86400));
  const companyName = text(company.name || 'Simulated organization',200);
  const roleTitle = text(manifest.role_title || context.pack_role_title || 'Virtual Intern',160);
  const description = text(company.description,900);
  const roleSummary = ['Simulated role: ' + roleTitle + ' at ' + companyName + '.', description].filter(Boolean).join(' ');

  const limitations = [
    'This experience was a Murikah Virtual Internship simulation and was not employment by the simulated organization.',
    'Competency statements are limited to the evidence references and completion-time evidence snapshot described in this report.',
    'The simulation does not verify physical or manual competence that was not directly observable in the virtual environment.',
    'This report does not claim statutory industrial attachment recognition.',
    'No institution endorsement is present unless a separately verified endorsement record is explicitly rendered.',
    ...[...evidenceLimitations],
  ];

  return {
    schema_version: PERFORMANCE_REPORT_SOURCE_SCHEMA_VERSION,
    completion_record_id: String(context.id || ''),
    completion_snapshot_hash: String(context.gate_snapshot_hash || ''),
    learner_name_snapshot: learnerName,
    identity_note: 'Learner name is a Murikah account display-name snapshot at issuance and is not a legal-identity verification.',
    internship_title: text(manifest.title || context.pack_title || 'Murikah Virtual Internship',240),
    simulated_organization: companyName,
    organization_is_simulated: true,
    internship_started_at: startedAt,
    internship_completed_at: completedAt,
    total_duration_days: durationDays,
    expected_workload_band: text(manifest.expected_workload_band || context.expected_workload_band || 'Not recorded',120),
    role_title: roleTitle,
    role_summary: roleSummary,
    key_assignments: keyAssignments,
    work_products_completed: artifacts.map((row) => ({
      artifact_id: String(row.id || ''),
      task_id: String(row.task_id || ''),
      title: text(row.title,240),
      artifact_type: text(row.artifact_type,80),
      deliverable_type: text(row.deliverable_type,80),
      artifact_version_id: String(row.artifact_version_id || ''),
      artifact_version: Number(row.version_number || 0),
      submission_id: String(row.submission_id || ''),
      accepted_at: Number(row.accepted_at || 0),
    })),
    performance_review: {
      final_review_id: String(finalReview?.id || ''),
      finalized_at: Number(finalReview?.finalized_at || 0),
      strengths: finalStrengths,
      development_areas: finalDevelopment,
      assistance_summary: finalAssistance,
      narrative: text(finalReview?.narrative || 'A finalized supervisor-style narrative was not recorded.',8000),
    },
    competency_summary: competencies,
    strengths: finalStrengths,
    development_areas: finalDevelopment,
    evidence_highlights: allEvidenceReferences.slice(0,8),
    assistance_independence_context: [...assistance],
    midpoint_to_final_improvement: improvement(reviews.midpoint,reviews.final),
    supervisor_style_narrative: text(finalReview?.narrative || 'A finalized supervisor-style narrative was not recorded.',8000),
    learner_reflection_summary: reflection ? {
      reflection_id: String(reflection.id || ''),
      period_key: text(reflection.period_key,80),
      summary: extractReflection(reflection.content),
    } : null,
    limitations: [...new Set(limitations.map((item) => text(item,1800)).filter(Boolean))],
    evidence_references: allEvidenceReferences,
    simulation_disclosure: SIMULATION_DISCLOSURE,
    simulation_disclosure_version: SIMULATION_DISCLOSURE_VERSION,
    endorsement: null,
  };
}

function buildLetterSource(report: PerformanceReportSourceV1): CompletionLetterSourceV1 {
  return {
    schema_version: COMPLETION_LETTER_SOURCE_SCHEMA_VERSION,
    completion_record_id: report.completion_record_id,
    completion_snapshot_hash: report.completion_snapshot_hash,
    learner_name_snapshot: report.learner_name_snapshot,
    internship_title: report.internship_title,
    simulated_organization: report.simulated_organization,
    simulated_role: report.role_title,
    internship_started_at: report.internship_started_at,
    internship_completed_at: report.internship_completed_at,
    work_categories: [...new Set(report.key_assignments.map((row) => row.category).filter(Boolean))],
    deliverables_completed: report.work_products_completed.map((row) => ({ title: row.title, artifact_type: row.artifact_type })),
    competencies: report.competency_summary.map((row) => ({
      name: row.name,
      level_demonstrated: row.level_demonstrated,
      evidence_strength: row.evidence_strength,
    })),
    simulation_disclosure: SIMULATION_DISCLOSURE,
    simulation_disclosure_version: SIMULATION_DISCLOSURE_VERSION,
    endorsement: null,
  };
}

function list(items: string[]): string {
  return items.length ? '<ul>' + items.map((item) => '<li>' + html(item) + '</li>').join('') + '</ul>' : '<p>Not recorded.</p>';
}
function reportHtml(source: PerformanceReportSourceV1, issuance: {reference:string;code:string;issuedAt:number;version:number;baseUrl:string}): string {
  const verificationUrl = issuance.baseUrl
    ? issuance.baseUrl.replace(/\/$/,'') + '/api/murikah/virtual-internship/verify?reference_id=' + encodeURIComponent(issuance.reference)
    : '';
  const assignments = source.key_assignments.map((row) => '<li><strong>' + html(row.title) + '</strong> — ' + html(row.category) + (row.capstone ? ' (capstone)' : '') + '</li>').join('');
  const products = source.work_products_completed.map((row) => '<tr><td>' + html(row.title) + '</td><td>' + html(row.artifact_type) + '</td><td>v' + row.artifact_version + '</td></tr>').join('');
  const competencies = source.competency_summary.map((row) => '<tr><td>' + html(row.name) + '</td><td>' + html(row.level_demonstrated) + '</td><td>' + html(row.evidence_strength) + '</td><td>' + html(row.evidence_reference_labels.join(', ')) + '</td></tr>').join('');
  const evidence = source.evidence_references.map((row) => '<tr><td>' + html(row.label) + '</td><td>' + html(row.task_title) + '</td><td>' + html(row.artifact_title || row.reference_type) + '</td><td>' + html(row.competency_name) + '</td><td>' + html(row.canonical_id) + '</td></tr>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Murikah Internship Performance Report</title><style>' +
    '@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#172333;line-height:1.45;margin:0;background:#fff;font-size:10.5pt}' +
    'main{max-width:190mm;margin:auto}.brand{font-weight:800;letter-spacing:.08em;color:#071D35}.eyebrow{font-size:9pt;text-transform:uppercase;color:#7b6224}h1{font-size:24pt;margin:8px 0 2px;color:#071D35}h2{font-size:13pt;margin:20px 0 7px;border-bottom:1px solid #d9d4c8;padding-bottom:4px;color:#071D35}' +
    'p{margin:5px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;background:#f6f3ec;padding:12px;margin:14px 0}.meta b{display:block;font-size:8pt;text-transform:uppercase;color:#66717d}' +
    'table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #d8dde2;padding:6px;vertical-align:top;text-align:left}th{background:#f2f4f5}.disclosure{margin-top:20px;padding:10px;border-left:4px solid #A9822E;background:#fbf8f0}.verify{margin-top:16px;padding:10px;background:#071D35;color:#fff;word-break:break-word}.small{font-size:8.5pt;color:#5a6570}.verify .small{color:#dce2e8}@media print{a{color:inherit;text-decoration:none}.no-print{display:none}}' +
    '</style></head><body><main><div class="brand">MURIKAH</div><div class="eyebrow">Virtual Internship · Performance Report</div>' +
    '<h1>' + html(source.internship_title) + '</h1><p>' + html(source.learner_name_snapshot) + '</p>' +
    '<div class="meta"><div><b>Simulated organization</b>' + html(source.simulated_organization) + '</div><div><b>Simulated role</b>' + html(source.role_title) + '</div>' +
    '<div><b>Internship dates</b>' + html(dateLabel(source.internship_started_at)) + ' – ' + html(dateLabel(source.internship_completed_at)) + '</div><div><b>Recorded duration</b>' + source.total_duration_days + ' days</div>' +
    '<div><b>Expected workload band</b>' + html(source.expected_workload_band) + '</div><div><b>Document version</b>' + issuance.version + '</div></div>' +
    '<p class="small">' + html(source.identity_note) + '</p><h2>Role summary</h2><p>' + html(source.role_summary) + '</p>' +
    '<h2>Key assignments</h2><ul>' + assignments + '</ul><h2>Work products completed</h2><table><thead><tr><th>Work product</th><th>Type</th><th>Accepted version</th></tr></thead><tbody>' + products + '</tbody></table>' +
    '<h2>Final performance review</h2><p>' + html(source.performance_review.narrative) + '</p><h2>Strengths</h2>' + list(source.strengths) +
    '<h2>Development areas</h2>' + list(source.development_areas) + '<h2>Midpoint-to-final improvement</h2>' + list(source.midpoint_to_final_improvement) +
    '<h2>Competency summary</h2><table><thead><tr><th>Competency</th><th>Level demonstrated</th><th>Evidence strength</th><th>References</th></tr></thead><tbody>' + competencies + '</tbody></table>' +
    '<h2>Assistance and independence context</h2>' + list(source.assistance_independence_context) +
    '<h2>Evidence highlights and appendix</h2><table><thead><tr><th>Ref</th><th>Task</th><th>Work product</th><th>Competency</th><th>Canonical ID</th></tr></thead><tbody>' + evidence + '</tbody></table>' +
    '<h2>Learner reflection</h2><p>' + html(source.learner_reflection_summary?.summary || 'Not recorded.') + '</p>' +
    '<h2>Limitations</h2>' + list(source.limitations) +
    '<div class="disclosure"><strong>Simulation disclosure</strong><p>' + html(source.simulation_disclosure) + '</p></div>' +
    '<div class="verify"><strong>Verification/reference ID</strong><br>' + html(issuance.reference) + '<br><strong>Verification code</strong><br>' + html(issuance.code) +
    (verificationUrl ? '<br><span class="small">Verify at ' + html(verificationUrl) + '</span>' : '') +
    '<br><span class="small">Issued by Murikah on ' + html(dateLabel(issuance.issuedAt)) + '.</span></div>' +
    '</main></body></html>';
}
function letterHtml(source: CompletionLetterSourceV1, issuance: {reference:string;code:string;issuedAt:number;version:number;baseUrl:string}): string {
  const verificationUrl = issuance.baseUrl
    ? issuance.baseUrl.replace(/\/$/,'') + '/api/murikah/virtual-internship/verify?reference_id=' + encodeURIComponent(issuance.reference)
    : '';
  const deliverables = source.deliverables_completed.map((row) => row.title + ' (' + row.artifact_type + ')');
  const competencies = source.competencies.map((row) => row.name + ': ' + row.level_demonstrated + ' · ' + row.evidence_strength + ' evidence');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Virtual Internship Completion Letter</title>' +
    '<style>@page{size:A4;margin:20mm}body{font-family:Arial,Helvetica,sans-serif;color:#172333;line-height:1.55;margin:0;font-size:11pt}main{max-width:175mm;margin:auto}.brand{font-weight:800;letter-spacing:.08em;color:#071D35}h1{font-size:22pt;color:#071D35;margin:18px 0}.block{margin:18px 0}.disclosure{padding:10px;border-left:4px solid #A9822E;background:#fbf8f0}.verify{margin-top:22px;padding:11px;background:#071D35;color:white;word-break:break-word}.small{font-size:9pt;color:#5a6570}.verify .small{color:#dce2e8}</style></head><body><main>' +
    '<div class="brand">MURIKAH</div><h1>Virtual Internship Completion Letter</h1><p>Issued ' + html(dateLabel(issuance.issuedAt)) + '</p>' +
    '<div class="block"><p>This letter confirms that <strong>' + html(source.learner_name_snapshot) + '</strong> completed the <strong>' + html(source.internship_title) +
    '</strong> Murikah Virtual Internship simulation from ' + html(dateLabel(source.internship_started_at)) + ' to ' + html(dateLabel(source.internship_completed_at)) + '.</p>' +
    '<p>The learner performed simulated work in the role of <strong>' + html(source.simulated_role) + '</strong> within the fictional/simulated organization <strong>' + html(source.simulated_organization) + '</strong>.</p></div>' +
    '<div class="block"><strong>Categories of simulated work</strong>' + list(source.work_categories) + '<strong>Recorded deliverables</strong>' + list(deliverables) +
    '<strong>Evidence-backed competencies</strong>' + list(competencies) + '</div>' +
    '<div class="disclosure"><strong>Simulation disclosure</strong><p>' + html(source.simulation_disclosure) + '</p></div>' +
    '<div class="block"><strong>Issued by Murikah</strong><p class="small">This is an organizational/system issuance. No fictional employer or human executive signature is represented.</p></div>' +
    '<div class="verify"><strong>Verification/reference ID</strong><br>' + html(issuance.reference) + '<br><strong>Verification code</strong><br>' + html(issuance.code) +
    (verificationUrl ? '<br><span class="small">Verify at ' + html(verificationUrl) + '</span>' : '') + '</div>' +
    '</main></body></html>';
}

async function storedIntegrity(env: P9Env, row: Record<string,unknown>): Promise<boolean> {
  const object = await env.TUTOR_DB.prepare(
    "SELECT object_key, owner_kind, owner_id, sha256 FROM tutor_objects WHERE object_id=? AND deleted_at IS NULL LIMIT 1",
  ).bind(String(row.object_id || '')).first<Record<string,unknown>>();
  if (!object || String(object.owner_kind) !== 'user' || String(object.owner_id) !== String(row.learner_id || '')) return false;
  const stored = await env.TUTOR_FILES.get(String(object.object_key || ''));
  if (!stored) return false;
  const bytes = await new Response(stored.body).arrayBuffer();
  const sha = await sha256Bytes(bytes);
  return sha === String(row.document_sha256 || '') && sha === String(object.sha256 || '') && bytes.byteLength === Number(row.size_bytes || 0);
}

async function issue(
  env: P9Env,
  actorId: string,
  internshipId: string,
  documentType: string,
  req: string,
  learnerName: string,
  now: number,
): Promise<Response> {
  const replay = await env.TUTOR_DB.prepare(
    'SELECT * FROM internship_completion_documents WHERE learner_id=? AND request_id=? LIMIT 1',
  ).bind(actorId,req).first<Record<string,unknown>>();
  if (replay) {
    if (String(replay.internship_id) !== internshipId || String(replay.document_type) !== documentType) {
      return json({error:'document_request_id_conflict'},409);
    }
    if (!await storedIntegrity(env,replay)) return json({error:'document_integrity_failed'},503);
    return json({ok:true,idempotent_replay:true,document:documentMeta(replay)});
  }

  let report: PerformanceReportSourceV1;
  try { report = await buildReportSource(env.TUTOR_DB,actorId,internshipId,learnerName); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'document_source_invalid';
    const status = code.includes('not_found') ? 404 : code.includes('qualifying') ? 409 : 422;
    return json({error:code},status);
  }
  const source: PerformanceReportSourceV1 | CompletionLetterSourceV1 =
    documentType === 'performance_report' ? report : buildLetterSource(report);
  const templateVersion = documentType === 'performance_report'
    ? PERFORMANCE_REPORT_TEMPLATE_VERSION : COMPLETION_LETTER_TEMPLATE_VERSION;
  const sourceSchemaVersion = documentType === 'performance_report'
    ? PERFORMANCE_REPORT_SOURCE_SCHEMA_VERSION : COMPLETION_LETTER_SOURCE_SCHEMA_VERSION;
  const sourcePayloadJson = canonicalJson(source);
  const sourcePayloadHash = await sha256String(sourcePayloadJson);

  const current = await env.TUTOR_DB.prepare(
    "SELECT * FROM internship_completion_documents WHERE completion_record_id=? AND document_type=? AND issuance_status='current' LIMIT 1",
  ).bind(source.completion_record_id,documentType).first<Record<string,unknown>>();
  if (
    current &&
    String(current.source_payload_hash) === sourcePayloadHash &&
    String(current.template_version) === templateVersion &&
    String(current.simulation_disclosure_version) === SIMULATION_DISCLOSURE_VERSION
  ) {
    if (!await storedIntegrity(env,current)) return json({error:'document_integrity_failed'},503);
    return json({ok:true,idempotent_replay:true,document:documentMeta(current)});
  }

  const version = current ? Number(current.document_version || 0) + 1 : 1;
  const documentId = generated('vdoc');
  const objectId = generated('obj');
  const reference = 'vr_' + randomHex(24);
  const code = 'vc_' + randomHex(16);
  const codeHash = await sha256String(code);
  const baseUrl = text(env.MURIKAH_PUBLIC_BASE_URL,500);
  const rendered = documentType === 'performance_report'
    ? reportHtml(source as PerformanceReportSourceV1,{reference,code,issuedAt:now,version,baseUrl})
    : letterHtml(source as CompletionLetterSourceV1,{reference,code,issuedAt:now,version,baseUrl});
  const bytes = encodeUtf8(rendered);
  const outputHash = await sha256Bytes(bytes);
  const objectType = documentType === 'performance_report' ? 'completion-report' : 'completion-letter';
  const key = ['users',actorId,'virtual-internships',internshipId,objectType,documentId,'v' + version + '.html'].join('/');
  const runtimePath = ['virtual-internships',internshipId,objectType,documentId,'v' + version + '.html'].join('/');

  await env.TUTOR_FILES.put(key,bytes,{
    customMetadata:{
      object_id:objectId, owner_kind:'user', owner_id:actorId, object_type:objectType,
      internship_id:internshipId, document_id:documentId, sha256:outputHash,
    },
  });
  try {
    const statements: P9Statement[] = [];
    if (current) {
      // D1 batch is the atomic boundary: release the one-current uniqueness slot
      // before inserting the new immutable version. The forward document ID is
      // intentionally not a foreign key so the whole batch can commit atomically.
      statements.push(env.TUTOR_DB.prepare(
        "UPDATE internship_completion_documents SET issuance_status='superseded',superseded_at=?,superseded_by_document_id=? " +
        "WHERE id=? AND issuance_status='current'",
      ).bind(now,documentId,String(current.id || '')));
    }
    statements.push(
      env.TUTOR_DB.prepare(
        'INSERT INTO tutor_objects(object_id,owner_kind,owner_id,object_type,runtime_path,object_key,sha256,size_bytes,content_type,created_at,updated_at,deleted_at) ' +
        "VALUES (?,'user',?,?,?,?,?,?,?, ?,?,NULL)",
      ).bind(objectId,actorId,objectType,runtimePath,key,outputHash,bytes.byteLength,'text/html; charset=utf-8',now,now),
      env.TUTOR_DB.prepare(
        'INSERT INTO internship_completion_documents(' +
        'id,internship_id,learner_id,completion_record_id,document_type,document_version,template_version,source_schema_version,' +
        'source_snapshot_hash,source_payload_json,source_payload_hash,object_id,document_sha256,size_bytes,content_type,' +
        'verification_reference_id,verification_code_hash,issuance_status,issued_at,superseded_at,superseded_by_document_id,' +
        'simulation_disclosure_version,endorsement_json,request_id,created_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'current',?,NULL,NULL,?,'{}',?,?)",
      ).bind(
        documentId,internshipId,actorId,source.completion_record_id,documentType,version,templateVersion,sourceSchemaVersion,
        source.completion_snapshot_hash,sourcePayloadJson,sourcePayloadHash,objectId,outputHash,bytes.byteLength,'text/html; charset=utf-8',
        reference,codeHash,now,SIMULATION_DISCLOSURE_VERSION,req,now,
      ),
    );
    await env.TUTOR_DB.batch(statements);
  } catch {
    await env.TUTOR_FILES.delete(key);
    const raced = await env.TUTOR_DB.prepare(
      "SELECT * FROM internship_completion_documents WHERE completion_record_id=? AND document_type=? AND issuance_status='current' LIMIT 1",
    ).bind(source.completion_record_id,documentType).first<Record<string,unknown>>();
    if (raced && String(raced.source_payload_hash) === sourcePayloadHash && await storedIntegrity(env,raced)) {
      return json({ok:true,idempotent_replay:true,document:documentMeta(raced)});
    }
    return json({error:'document_issue_conflict'},409);
  }
  const saved = await env.TUTOR_DB.prepare(
    'SELECT * FROM internship_completion_documents WHERE id=? LIMIT 1',
  ).bind(documentId).first<Record<string,unknown>>();
  if (!saved) return json({error:'document_issue_failed'},503);
  return json({ok:true,document:documentMeta(saved)},201);
}

async function download(env:P9Env, actorId:string, internshipId:string, documentId:string, format:string):Promise<Response> {
  const row = await env.TUTOR_DB.prepare(
    'SELECT d.*, o.object_key, o.owner_kind, o.owner_id, o.sha256 AS object_sha256 ' +
    'FROM internship_completion_documents d JOIN tutor_objects o ON o.object_id=d.object_id AND o.deleted_at IS NULL ' +
    'WHERE d.id=? AND d.internship_id=? AND d.learner_id=? LIMIT 1',
  ).bind(documentId,internshipId,actorId).first<Record<string,unknown>>();
  if (!row || String(row.owner_kind) !== 'user' || String(row.owner_id) !== actorId) return json({error:'document_not_found'},404);
  if (format === 'json') {
    return new Response(String(row.source_payload_json || '{}'),{
      headers:{
        'content-type':'application/json; charset=utf-8',
        'content-disposition':'attachment; filename="murikah-virtual-internship-' + String(row.document_type || 'document').replace(/_/g,'-') + '-source-v' + Number(row.document_version || 1) + '.json"',
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
      },
    });
  }
  const object = await env.TUTOR_FILES.get(String(row.object_key || ''));
  if (!object) return json({error:'document_object_missing'},503);
  const bytes = await new Response(object.body).arrayBuffer();
  const actual = await sha256Bytes(bytes);
  if (
    actual !== String(row.document_sha256 || '') ||
    actual !== String(row.object_sha256 || '') ||
    bytes.byteLength !== Number(row.size_bytes || 0)
  ) return json({error:'document_integrity_failed'},409);
  const filename = 'murikah-virtual-internship-' + String(row.document_type || 'document').replace(/_/g,'-') + '-v' + Number(row.document_version || 1) + '.html';
  return new Response(bytes,{
    headers:{
      'content-type':'text/html; charset=utf-8',
      'content-length':String(bytes.byteLength),
      'content-disposition':'attachment; filename="' + filename + '"',
      'cache-control':'private, no-store','x-content-type-options':'nosniff',
    },
  });
}

async function verify(env:P9Env, reference:string, code:string):Promise<Response> {
  if (!REFERENCE_ID.test(reference)) return json({error:'document_verification_not_found'},404);
  const row = await env.TUTOR_DB.prepare(
    'SELECT d.*, sp.title AS internship_title, c.completed_at, o.object_key, o.sha256 AS object_sha256 ' +
    'FROM internship_completion_documents d ' +
    'JOIN completion_records c ON c.id=d.completion_record_id ' +
    'JOIN scenario_packs sp ON sp.id=c.scenario_pack_id ' +
    'JOIN tutor_objects o ON o.object_id=d.object_id AND o.deleted_at IS NULL ' +
    'WHERE d.verification_reference_id=? LIMIT 1',
  ).bind(reference).first<Record<string,unknown>>();
  if (!row) return json({error:'document_verification_not_found'},404);
  const object = await env.TUTOR_FILES.get(String(row.object_key || ''));
  if (!object) return json({error:'document_integrity_unavailable'},503);
  const bytes = await new Response(object.body).arrayBuffer();
  const actual = await sha256Bytes(bytes);
  const integrityOk =
    actual === String(row.document_sha256 || '') &&
    actual === String(row.object_sha256 || '') &&
    bytes.byteLength === Number(row.size_bytes || 0);
  if (!integrityOk) {
    return json({
      ok:false, verification_status:'integrity_failed', valid:false,
      document_type:String(row.document_type || ''), reference_id:reference,
      simulation_disclosure:SIMULATION_DISCLOSURE,
    },409);
  }
  let identityVerified = false;
  let learnerName: string | undefined;
  if (code) {
    if (VERIFY_CODE.test(code) && await sha256String(code) === String(row.verification_code_hash || '')) {
      identityVerified = true;
      const source = parse(row.source_payload_json,{}) as Record<string,unknown>;
      learnerName = text(source.learner_name_snapshot,100);
    }
  }
  const status = String(row.issuance_status || '') === 'superseded' ? 'superseded' : 'current';
  return json({
    ok:true,
    valid:status === 'current',
    verification_status:status,
    reference_id:reference,
    document_type:String(row.document_type || ''),
    issued_at:Number(row.issued_at || 0),
    internship_title:text(row.internship_title,240),
    completion_date:Number(row.completed_at || 0),
    sha256:String(row.document_sha256 || ''),
    integrity_fingerprint:String(row.document_sha256 || '').slice(0,16),
    template_version:String(row.template_version || ''),
    document_version:Number(row.document_version || 0),
    simulation_disclosure:SIMULATION_DISCLOSURE,
    simulation_disclosure_version:String(row.simulation_disclosure_version || ''),
    identity_verified:identityVerified,
    ...(identityVerified && learnerName ? {learner_name:learnerName} : {}),
  });
}

export async function handlePhase9DocumentPersistenceRoute(
  request: Request,
  env: P9Env,
  route: string,
  now: number,
): Promise<Response | null> {
  if (!route.startsWith('/internships/completion-documents/')) return null;
  const url = new URL(request.url);
  const isGet = request.method === 'GET';
  const body = isGet ? {} : await bodyJson(request);

  if (route === '/internships/completion-documents/verify' && request.method === 'POST') {
    const reference = String(body.reference_id || '').trim();
    const code = String(body.verification_code || '').trim();
    return verify(env,reference,code);
  }

  const actorId = id(isGet ? url.searchParams.get('actor_id') : body.actor_id);
  if (!actorId || !await activeAccount(env.TUTOR_DB,actorId)) return json({error:'authentication_required'},401);
  const internshipId = id(isGet ? url.searchParams.get('internship_id') : body.internship_id);
  if (!internshipId) return json({error:'internship_not_found'},404);

  if (route === '/internships/completion-documents/generate' && request.method === 'POST') {
    const forbidden = [
      'completion','completed','completion_record_id','completed_at','evidence_ids','competencies',
      'strengths','development_areas','institution_name','signer_name','endorsed','endorsement',
    ];
    if (forbidden.some((key) => key in body)) return json({error:'invalid_document_generation_request'},400);
    const documentType = String(body.document_type || '');
    const req = requestId(body.request_id);
    if (!DOCUMENT_TYPES.has(documentType) || !req) return json({error:'invalid_document_generation_request'},400);
    const learnerName = text(body.learner_name_snapshot,100);
    return issue(env,actorId,internshipId,documentType,req,learnerName,now);
  }

  if (route === '/internships/completion-documents/list' && request.method === 'GET') {
    const owned = await env.TUTOR_DB.prepare(
      'SELECT id FROM internship_instances WHERE id=? AND learner_id=? LIMIT 1',
    ).bind(internshipId,actorId).first<{id:string}>();
    if (!owned) return json({error:'internship_not_found'},404);
    const rows = (await env.TUTOR_DB.prepare(
      'SELECT id,internship_id,completion_record_id,document_type,document_version,template_version,document_sha256,size_bytes,content_type,' +
      'verification_reference_id,issuance_status,issued_at,superseded_at,superseded_by_document_id,simulation_disclosure_version ' +
      'FROM internship_completion_documents WHERE learner_id=? AND internship_id=? ' +
      'ORDER BY document_type, document_version DESC',
    ).bind(actorId,internshipId).all<Record<string,unknown>>()).results || [];
    return json({ok:true,documents:rows.map(documentMeta),simulation_disclosure:SIMULATION_DISCLOSURE});
  }

  if (route === '/internships/completion-documents/download' && request.method === 'GET') {
    const documentId = id(url.searchParams.get('document_id'));
    const format = String(url.searchParams.get('format') || 'html');
    if (!documentId || !['html','json'].includes(format)) return json({error:'document_not_found'},404);
    return download(env,actorId,internshipId,documentId,format);
  }

  return json({error:'completion_document_route_not_found'},404);
}
