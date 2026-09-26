export type InstitutionDatabase = {
  prepare(query: string): {
    bind(...values: unknown[]): any;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: any[]): Promise<unknown>;
};

export type InstitutionEnv = { TUTOR_DB: InstitutionDatabase };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "cache-control": "private, no-store" } });
}
function text(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function id(value: unknown): string {
  const out = text(value, 128);
  return ID.test(out) ? out : "";
}
function slug(value: unknown): string {
  const out = text(value, 128).toLowerCase();
  return SLUG.test(out) ? out : "";
}
function integer(value: unknown): number {
  const out = Number(value);
  return Number.isSafeInteger(out) ? out : 0;
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
async function isAdmin(db: InstitutionDatabase, actorId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT role, account_status FROM tutor_accounts WHERE actor_id=? LIMIT 1",
  ).bind(actorId).first<{ role: string; account_status: string }>();
  return Boolean(row && row.role === "admin" && row.account_status === "active");
}
async function draftRow(db: InstitutionDatabase, draftId: string) {
  return db.prepare(
    "SELECT id,created_by_actor_id,status,draft_json,validation_json,resolved_content_hash," +
    "scenario_pack_id,scenario_version_id,catalog_slug,created_at,updated_at,published_at,retired_at " +
    "FROM institution_scenario_drafts WHERE id=? LIMIT 1",
  ).bind(draftId).first<Record<string, unknown>>();
}
function parsedJson(value: unknown): unknown {
  try { return JSON.parse(String(value ?? "{}")); } catch { return {}; }
}

async function getDraft(request: Request, env: InstitutionEnv): Promise<Response> {
  const url = new URL(request.url);
  const actorId = id(url.searchParams.get("actor_id"));
  const draftId = id(url.searchParams.get("draft_id"));
  if (!actorId || !(await isAdmin(env.TUTOR_DB, actorId))) return json({ error: "admin_required" }, 403);
  if (!draftId) return json({ error: "institution_draft_not_found" }, 404);
  const row = await draftRow(env.TUTOR_DB, draftId);
  if (!row) return json({ error: "institution_draft_not_found" }, 404);
  return json({
    ok: true,
    draft: {
      id: row.id,
      status: row.status,
      draft: parsedJson(row.draft_json),
      validation: parsedJson(row.validation_json),
      resolved_content_hash: row.resolved_content_hash,
      scenario_pack_id: row.scenario_pack_id,
      scenario_version_id: row.scenario_version_id,
      catalog_slug: row.catalog_slug,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
      retired_at: row.retired_at,
    },
  });
}

async function stageScenario(request: Request, env: InstitutionEnv, now: number): Promise<Response> {
  const body = await bodyJson(request);
  const actorId = id(body.actor_id);
  if (!actorId || !(await isAdmin(env.TUTOR_DB, actorId))) return json({ error: "admin_required" }, 403);
  const draftId = id(body.draft_id);
  const packId = id(body.scenario_pack_id);
  const packSlug = slug(body.scenario_slug);
  const versionId = id(body.scenario_version_id);
  const version = integer(body.scenario_version);
  const minimumDays = integer(body.minimum_duration_days);
  const contentHash = text(body.content_hash, 64);
  const title = text(body.title, 200);
  const careerFamily = text(body.career_family, 128);
  const roleTitle = text(body.role_title, 160);
  const workload = text(body.expected_workload_band, 32);
  if (!draftId || !packId || !packSlug || !versionId || version < 1 || minimumDays < 1 || !HEX64.test(contentHash) || !title || !careerFamily || !roleTitle) {
    return json({ error: "institution_stage_invalid" }, 400);
  }
  const draft = await draftRow(env.TUTOR_DB, draftId);
  if (!draft || draft.status !== "validated" || String(draft.resolved_content_hash || "") !== contentHash) {
    return json({ error: "institution_draft_not_validated" }, 409);
  }
  const existingPack = await env.TUTOR_DB.prepare(
    "SELECT id,slug,title,career_family,role_title,status FROM scenario_packs WHERE id=? OR slug=? LIMIT 1",
  ).bind(packId, packSlug).first<Record<string, unknown>>();
  if (existingPack && (existingPack.id !== packId || existingPack.slug !== packSlug)) {
    return json({ error: "institution_pack_identity_conflict" }, 409);
  }
  if (existingPack && existingPack.status === "published" && (
    existingPack.title !== title || existingPack.career_family !== careerFamily || existingPack.role_title !== roleTitle
  )) return json({ error: "published_scenario_immutable" }, 409);

  const existingVersion = await env.TUTOR_DB.prepare(
    "SELECT id,scenario_pack_id,version,status,content_hash FROM scenario_versions WHERE id=? OR (scenario_pack_id=? AND version=?) LIMIT 1",
  ).bind(versionId, packId, version).first<Record<string, unknown>>();
  if (existingVersion && (existingVersion.id !== versionId || existingVersion.scenario_pack_id !== packId || Number(existingVersion.version) !== version)) {
    return json({ error: "institution_version_identity_conflict" }, 409);
  }
  if (existingVersion && existingVersion.status === "published") {
    return String(existingVersion.content_hash || "") === contentHash
      ? json({ ok: true, idempotent_replay: true, scenario_pack_id: packId, scenario_version_id: versionId })
      : json({ error: "published_scenario_immutable" }, 409);
  }

  const statements: any[] = [];
  if (!existingPack) {
    statements.push(env.TUTOR_DB.prepare(
      "INSERT INTO scenario_packs(id,slug,title,career_family,role_title,status,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?)",
    ).bind(packId, packSlug, title, careerFamily, roleTitle, now, now));
  } else if (existingPack.status === "draft") {
    statements.push(env.TUTOR_DB.prepare(
      "UPDATE scenario_packs SET title=?,career_family=?,role_title=?,updated_at=? WHERE id=? AND status='draft'",
    ).bind(title, careerFamily, roleTitle, now, packId));
  }
  if (!existingVersion) {
    statements.push(env.TUTOR_DB.prepare(
      "INSERT INTO scenario_versions(id,scenario_pack_id,version,schema_version,status,manifest_ref,minimum_duration_days,expected_workload_band,content_hash,created_at,published_at) " +
      "VALUES (?,?,?,1,'draft','',?,?,?, ?,NULL)",
    ).bind(versionId, packId, version, minimumDays, workload, contentHash, now));
  } else {
    statements.push(env.TUTOR_DB.prepare(
      "UPDATE scenario_versions SET minimum_duration_days=?,expected_workload_band=?,content_hash=? WHERE id=? AND status='draft'",
    ).bind(minimumDays, workload, contentHash, versionId));
  }
  if (statements.length) await env.TUTOR_DB.batch(statements);
  return json({ ok: true, scenario_pack_id: packId, scenario_version_id: versionId, status: "draft" }, 201);
}

async function activateScenario(request: Request, env: InstitutionEnv, now: number): Promise<Response> {
  const body = await bodyJson(request);
  const actorId = id(body.actor_id);
  if (!actorId || !(await isAdmin(env.TUTOR_DB, actorId))) return json({ error: "admin_required" }, 403);
  const draftId = id(body.draft_id);
  const versionId = id(body.scenario_version_id);
  if (!draftId || !versionId) return json({ error: "institution_activation_invalid" }, 400);
  const draft = await draftRow(env.TUTOR_DB, draftId);
  if (!draft || draft.status !== "validated") return json({ error: "institution_draft_not_validated" }, 409);
  const row = await env.TUTOR_DB.prepare(
    "SELECT sv.id,sv.scenario_pack_id,sv.status,sv.content_hash,sv.manifest_ref,c.content_hash AS installed_hash,c.manifest_ref AS installed_ref,c.canonical_json " +
    "FROM scenario_versions sv JOIN scenario_version_content c ON c.scenario_version_id=sv.id WHERE sv.id=? LIMIT 1",
  ).bind(versionId).first<Record<string, unknown>>();
  if (!row || !["draft","published"].includes(String(row.status || ""))) return json({ error: "scenario_version_not_available" }, 404);
  if (row.content_hash !== draft.resolved_content_hash || row.installed_hash !== row.content_hash || row.installed_ref !== row.manifest_ref) {
    return json({ error: "scenario_content_integrity_failed" }, 409);
  }
  const definition = parsedJson(row.canonical_json) as Record<string, unknown>;
  const manifest = definition && typeof definition === "object" && !Array.isArray(definition)
    ? (definition.manifest as Record<string, unknown> | undefined) : undefined;
  const qualifying = manifest?.qualifying === true;
  if (qualifying) {
    const completion = await env.TUTOR_DB.prepare(
      "SELECT scenario_version_id FROM scenario_completion_policies WHERE scenario_version_id=? LIMIT 1",
    ).bind(versionId).first<{ scenario_version_id: string }>();
    if (!completion) return json({ error: "completion_policy_missing" }, 409);
    if (integer(manifest?.minimum_duration_days) < 90 || String(manifest?.classification || "") !== "qualifying" || String(manifest?.mode || "standard") !== "standard") {
      return json({ error: "institution_qualification_invariant_failed" }, 409);
    }
  }
  await env.TUTOR_DB.batch([
    env.TUTOR_DB.prepare(
      "UPDATE scenario_packs SET status='published',updated_at=? WHERE id=? AND status IN ('draft','published')",
    ).bind(now, row.scenario_pack_id),
    env.TUTOR_DB.prepare(
      "UPDATE scenario_versions SET status='published',published_at=COALESCE(published_at,?) WHERE id=? AND status IN ('draft','published')",
    ).bind(now, versionId),
  ]);
  return json({ ok: true, scenario_pack_id: row.scenario_pack_id, scenario_version_id: versionId, status: "published" });
}

export async function handlePhase10InstitutionPersistenceRoute(
  request: Request,
  env: InstitutionEnv,
  route: string,
  now: number,
): Promise<Response | null> {
  if (route === "/institution-scenarios/get" && request.method === "GET") return getDraft(request, env);
  if (route === "/institution-scenarios/stage" && request.method === "POST") return stageScenario(request, env, now);
  if (route === "/institution-scenarios/activate" && request.method === "POST") return activateScenario(request, env, now);
  return null;
}
