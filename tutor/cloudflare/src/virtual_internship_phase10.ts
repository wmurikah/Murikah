export type Phase10Database = {
  prepare(query: string): {
    bind(...values: unknown[]): any;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: any[]): Promise<unknown>;
};

export type Phase10Env = { TUTOR_DB: Phase10Database };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,127}$/;
const PHYSICAL = new Set(["knowledge_work", "mixed", "physical_skill_limited"]);
const INTERNSHIP_TYPES = new Set(["qualifying", "practice"]);

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}
function text(value: unknown, max = 2000): string {
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
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function parse(value: unknown, fallback: any): any {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}
function stringList(value: unknown, limit = 32): string[] {
  return list(value).map((item) => text(item, 240)).filter(Boolean).slice(0, limit);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort().map((key) => JSON.stringify(key) + ":" + canonical(row[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try { return object(await request.json()); } catch { return {}; }
}
async function account(db: Phase10Database, actorId: string) {
  return db.prepare("SELECT actor_id, role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1")
    .bind(actorId).first<{ actor_id: string; role: string; account_status: string }>();
}
async function requireAdmin(db: Phase10Database, actorId: string): Promise<boolean> {
  const row = await account(db, actorId);
  return Boolean(row && row.role === "admin" && row.account_status === "active");
}
function catalogCard(row: Record<string, unknown>) {
  return {
    slug: String(row.catalog_slug || ""),
    scenario_pack_id: String(row.scenario_pack_id || ""),
    scenario_version_id: String(row.scenario_version_id || ""),
    scenario_version: Number(row.scenario_version || 0),
    internship_type: String(row.internship_type || ""),
    qualifying: Number(row.qualifying || 0) === 1,
    mode: String(row.mode || ""),
    title: String(row.title || ""),
    role_title: String(row.role_title || ""),
    simulated_company: String(row.simulated_company_name || ""),
    sector: String(row.sector || ""),
    region: String(row.region || ""),
    career_family: {
      id: String(row.career_family_id || ""),
      slug: String(row.career_family_slug || ""),
      title: String(row.career_family_title || ""),
    },
    short_description: String(row.short_description || ""),
    minimum_duration_days: Number(row.minimum_duration_days || 0),
    weekly_workload: {
      min_hours: Number(row.weekly_hours_min || 0),
      max_hours: Number(row.weekly_hours_max || 0),
      label: String(row.weekly_hours_min || "") + "-" + String(row.weekly_hours_max || "") + " hours/week",
    },
    workload_band: String(row.workload_band || ""),
    experience_level: String(row.experience_level || ""),
    competency_preview: stringList(parse(row.competencies_json, []), 4),
    responsibility_preview: stringList(parse(row.responsibilities_json, []), 3),
    deliverable_preview: stringList(parse(row.deliverables_json, []), 3),
    qualification_label: Number(row.qualifying || 0) === 1 ? "Qualifying Virtual Internship" : "Demo",
    physical_competency_classification: String(row.physical_competency_classification || ""),
    physical_competency_limitation_text: String(row.physical_competency_limitation_text || ""),
  };
}
function catalogDetail(row: Record<string, unknown>, now: number) {
  return {
    ...catalogCard(row),
    server_current_time: now,
    long_description: String(row.long_description || ""),
    competencies: stringList(parse(row.competencies_json, []), 24),
    responsibilities: stringList(parse(row.responsibilities_json, []), 24),
    deliverables: stringList(parse(row.deliverables_json, []), 24),
    work_rhythm: String(row.work_rhythm || ""),
    prerequisites: String(row.prerequisites || ""),
    simulation_disclosure: String(row.simulation_disclosure || ""),
    completion_overview: String(row.completion_overview || ""),
    support_summary: String(row.support_summary || ""),
    exact_scenario_version: {
      id: String(row.scenario_version_id || ""),
      version: Number(row.scenario_version || 0),
      content_hash: String(row.scenario_content_hash || ""),
    },
    practice_disclosure: Number(row.qualifying || 0) === 1 ? "" :
      "This is a demo internship. It does not satisfy the 90-day qualifying internship requirement. It does not issue the qualifying Performance Report or Completion Letter. It does not count as a qualifying completion credential.",
  };
}
const SELECT_CATALOG =
  "SELECT ce.*, sv.version AS scenario_version, sv.content_hash AS scenario_content_hash, " +
  "cf.slug AS career_family_slug, cf.title AS career_family_title " +
  "FROM internship_catalog_entries ce " +
  "JOIN scenario_versions sv ON sv.id = ce.scenario_version_id " +
  "JOIN career_families cf ON cf.id = ce.career_family_id ";

async function catalogList(request: Request, env: Phase10Env): Promise<Response> {
  const url = new URL(request.url);
  const q = text(url.searchParams.get("q"), 120).toLowerCase();
  const career = text(url.searchParams.get("career"), 80).toLowerCase();
  const sector = text(url.searchParams.get("sector"), 120).toLowerCase();
  const internshipType = text(url.searchParams.get("type"), 32).toLowerCase();
  const workload = text(url.searchParams.get("workload"), 32).toLowerCase();
  const experience = text(url.searchParams.get("experience"), 32).toLowerCase();
  const clauses = ["ce.catalog_state = 'published'", "ce.visible = 1", "cf.active = 1"];
  const binds: unknown[] = [];
  if (q) { clauses.push("ce.searchable_text LIKE ?"); binds.push("%" + q + "%"); }
  if (career) { clauses.push("(cf.slug = ? OR ce.career_family_id = ?)"); binds.push(career, career); }
  if (sector) { clauses.push("lower(ce.sector) = ?"); binds.push(sector); }
  if (INTERNSHIP_TYPES.has(internshipType)) { clauses.push("ce.internship_type = ?"); binds.push(internshipType); }
  if (["light","standard","intensive"].includes(workload)) { clauses.push("ce.workload_band = ?"); binds.push(workload); }
  if (["entry","early_career","intermediate"].includes(experience)) { clauses.push("ce.experience_level = ?"); binds.push(experience); }
  const statement = env.TUTOR_DB.prepare(
    SELECT_CATALOG + "WHERE " + clauses.join(" AND ") +
    " ORDER BY CASE ce.internship_type WHEN 'qualifying' THEN 0 ELSE 1 END, ce.sort_order, ce.title, ce.catalog_slug LIMIT 100"
  ).bind(...binds);
  const rows = (await statement.all<Record<string, unknown>>()).results || [];
  return json({ ok: true, count: rows.length, results: rows.map(catalogCard) });
}
async function catalogFacets(env: Phase10Env): Promise<Response> {
  const [families, sectors] = await Promise.all([
    env.TUTOR_DB.prepare(
      "SELECT id, slug, title, short_title, sort_order FROM career_families WHERE active = 1 ORDER BY sort_order, title"
    ).all<Record<string, unknown>>(),
    env.TUTOR_DB.prepare(
      "SELECT DISTINCT sector FROM internship_catalog_entries WHERE catalog_state = 'published' AND visible = 1 ORDER BY sector"
    ).all<Record<string, unknown>>(),
  ]);
  return json({
    ok: true,
    career_families: families.results || [],
    sectors: (sectors.results || []).map((row) => String(row.sector || "")).filter(Boolean),
    internship_types: ["qualifying", "practice"],
    workload_bands: ["light", "standard", "intensive"],
    experience_levels: ["entry", "early_career", "intermediate"],
  });
}
async function catalogDetailRoute(request: Request, env: Phase10Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const catalogSlug = slug(url.searchParams.get("slug"));
  const versionId = id(url.searchParams.get("scenario_version_id"));
  if (!catalogSlug) return json({ error: "catalog_entry_not_found" }, 404);
  let query = SELECT_CATALOG + "WHERE ce.catalog_slug = ? AND ce.catalog_state = 'published' AND ce.visible = 1 ";
  const values: unknown[] = [catalogSlug];
  if (versionId) { query += "AND ce.scenario_version_id = ? "; values.push(versionId); }
  query += "ORDER BY ce.published_at DESC LIMIT 1";
  const row = await env.TUTOR_DB.prepare(query).bind(...values).first<Record<string, unknown>>();
  return row ? json({ ok: true, internship: catalogDetail(row, now) }) : json({ error: "catalog_entry_not_found" }, 404);
}
function validateCatalog(manifest: Record<string, unknown>, catalog: Record<string, unknown>): string {
  if (integer(catalog.schema_version) !== 1) return "catalog_schema_version_invalid";
  if (!slug(catalog.catalog_slug) || !id(catalog.career_family_id)) return "catalog_identity_invalid";
  const kind = text(catalog.internship_type, 32);
  if (!INTERNSHIP_TYPES.has(kind)) return "catalog_internship_type_invalid";
  const qualifying = manifest.qualifying === true;
  if ((kind === "qualifying") !== qualifying) return "catalog_qualification_mismatch";
  if (qualifying && text(manifest.classification, 32) !== "qualifying") return "catalog_qualification_mismatch";
  if (!qualifying && text(manifest.classification, 32) !== "demo") return "catalog_practice_mismatch";
  const mode = text(manifest.mode, 32) || (qualifying ? "standard" : "demo");
  if (mode !== (qualifying ? "standard" : "demo")) return "catalog_mode_mismatch";
  const minimum = integer(catalog.minimum_duration_days);
  if (minimum !== integer(manifest.minimum_duration_days) || minimum < 1 || (qualifying && minimum < 90)) return "catalog_duration_invalid";
  const minHours = integer(catalog.weekly_hours_min), maxHours = integer(catalog.weekly_hours_max);
  if (minHours < 1 || maxHours < minHours || maxHours > 80) return "catalog_workload_invalid";
  if (!PHYSICAL.has(text(catalog.physical_competency_classification, 64))) return "catalog_physical_classification_invalid";
  if (stringList(catalog.competencies_developed).length < 1 || stringList(catalog.sample_responsibilities).length < 1 || stringList(catalog.deliverables).length < 1) return "catalog_content_incomplete";
  if (catalog.published !== true || catalog.catalog_visible !== true) return "catalog_not_publishable";
  return "";
}
async function projectCatalog(request: Request, env: Phase10Env, now: number): Promise<Response> {
  const body = await bodyJson(request);
  const scenarioVersionId = id(body.scenario_version_id);
  if (!scenarioVersionId) return json({ error: "scenario_version_not_available" }, 404);
  const source = await env.TUTOR_DB.prepare(
    "SELECT sv.id, sv.scenario_pack_id, sv.version, sv.status, sv.content_hash, sv.manifest_ref, " +
    "sp.slug AS pack_slug, sp.title AS pack_title, sp.role_title, sp.status AS pack_status, c.canonical_json, c.content_hash AS installed_hash, c.manifest_ref AS installed_ref " +
    "FROM scenario_versions sv JOIN scenario_packs sp ON sp.id = sv.scenario_pack_id " +
    "JOIN scenario_version_content c ON c.scenario_version_id = sv.id WHERE sv.id = ? LIMIT 1"
  ).bind(scenarioVersionId).first<Record<string, unknown>>();
  if (!source || source.status !== "published" || source.pack_status !== "published") return json({ error: "scenario_version_not_available" }, 404);
  if (source.content_hash !== source.installed_hash || source.manifest_ref !== source.installed_ref) return json({ error: "scenario_content_integrity_failed" }, 409);
  const definition = object(parse(source.canonical_json, {}));
  const manifest = object(definition.manifest);
  const company = object(definition.company);
  const catalog = object(manifest.catalog);
  const error = validateCatalog(manifest, catalog);
  if (error) return json({ error }, 409);
  const familyId = id(catalog.career_family_id);
  const family = await env.TUTOR_DB.prepare("SELECT id, active FROM career_families WHERE id = ? LIMIT 1")
    .bind(familyId).first<{ id: string; active: number }>();
  if (!family || family.active !== 1) return json({ error: "career_family_not_available" }, 409);
  const qualifying = manifest.qualifying === true;
  if (qualifying) {
    const completion = await env.TUTOR_DB.prepare("SELECT scenario_version_id FROM scenario_completion_policies WHERE scenario_version_id = ? LIMIT 1")
      .bind(scenarioVersionId).first<{ scenario_version_id: string }>();
    if (!completion) return json({ error: "completion_policy_missing" }, 409);
  }
  const competencies = stringList(catalog.competencies_developed, 24);
  const responsibilities = stringList(catalog.sample_responsibilities, 24);
  const deliverables = stringList(catalog.deliverables, 24);
  const keywords = stringList(catalog.search_keywords, 64);
  const search = [
    source.pack_title, source.role_title, company.name, company.sector, catalog.short_description,
    catalog.long_description, ...competencies, ...responsibilities, ...deliverables, ...keywords,
  ].map((item) => text(item, 240).toLowerCase()).filter(Boolean).join(" ");
  const metadataHash = await sha256(canonical(catalog));
  const catalogSlug = slug(catalog.catalog_slug);
  const entryId = "catalog:" + scenarioVersionId;
  const values = [
    entryId, source.scenario_pack_id, scenarioVersionId, catalogSlug, familyId,
    text(source.pack_title, 200), text(source.role_title, 160), text(company.name, 200),
    text(company.sector, 160), text(company.region || manifest.region_context, 160),
    text(catalog.short_description, 320), text(catalog.long_description, 2400),
    text(catalog.internship_type, 32), qualifying ? 1 : 0,
    text(manifest.mode, 32) || (qualifying ? "standard" : "demo"),
    integer(catalog.minimum_duration_days), integer(catalog.weekly_hours_min), integer(catalog.weekly_hours_max),
    text(catalog.workload_band, 32), text(catalog.experience_level, 32),
    JSON.stringify(competencies), JSON.stringify(responsibilities), JSON.stringify(deliverables),
    text(catalog.work_rhythm, 1000), text(catalog.prerequisites, 800),
    text(catalog.physical_competency_classification, 64), text(catalog.physical_competency_limitation_text, 500),
    text(catalog.simulation_disclosure, 800), text(catalog.completion_overview, 1000), text(catalog.support_summary, 800),
    JSON.stringify(keywords), search, metadataHash, integer(catalog.sort_order), now, now,
  ];
  await env.TUTOR_DB.batch([
    env.TUTOR_DB.prepare(
      "UPDATE internship_catalog_entries SET catalog_state='retired', visible=0, retired_at=?, updated_at=? " +
      "WHERE catalog_slug=? AND scenario_version_id<>? AND catalog_state='published'"
    ).bind(now, now, catalogSlug, scenarioVersionId),
    env.TUTOR_DB.prepare(
      "INSERT INTO internship_catalog_entries(" +
      "id,scenario_pack_id,scenario_version_id,catalog_slug,career_family_id,title,role_title,simulated_company_name,sector,region," +
      "short_description,long_description,internship_type,qualifying,mode,minimum_duration_days,weekly_hours_min,weekly_hours_max,workload_band,experience_level," +
      "competencies_json,responsibilities_json,deliverables_json,work_rhythm,prerequisites,physical_competency_classification,physical_competency_limitation_text," +
      "simulation_disclosure,completion_overview,support_summary,search_keywords_json,searchable_text,metadata_hash,sort_order,published_at,updated_at,catalog_state,visible,retired_at" +
      ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published',1,NULL) " +
      "ON CONFLICT(scenario_version_id) DO UPDATE SET catalog_slug=excluded.catalog_slug,career_family_id=excluded.career_family_id,title=excluded.title,role_title=excluded.role_title," +
      "simulated_company_name=excluded.simulated_company_name,sector=excluded.sector,region=excluded.region,short_description=excluded.short_description,long_description=excluded.long_description," +
      "internship_type=excluded.internship_type,qualifying=excluded.qualifying,mode=excluded.mode,minimum_duration_days=excluded.minimum_duration_days,weekly_hours_min=excluded.weekly_hours_min," +
      "weekly_hours_max=excluded.weekly_hours_max,workload_band=excluded.workload_band,experience_level=excluded.experience_level,competencies_json=excluded.competencies_json," +
      "responsibilities_json=excluded.responsibilities_json,deliverables_json=excluded.deliverables_json,work_rhythm=excluded.work_rhythm,prerequisites=excluded.prerequisites," +
      "physical_competency_classification=excluded.physical_competency_classification,physical_competency_limitation_text=excluded.physical_competency_limitation_text," +
      "simulation_disclosure=excluded.simulation_disclosure,completion_overview=excluded.completion_overview,support_summary=excluded.support_summary,search_keywords_json=excluded.search_keywords_json," +
      "searchable_text=excluded.searchable_text,metadata_hash=excluded.metadata_hash,sort_order=excluded.sort_order,published_at=excluded.published_at,updated_at=excluded.updated_at,catalog_state='published',visible=1,retired_at=NULL"
    ).bind(...values),
  ]);
  return json({ ok: true, scenario_version_id: scenarioVersionId, catalog_slug: catalogSlug, metadata_hash: metadataHash });
}
function hasExecutablePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExecutablePayload);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (["pythoncode","javascriptcode","executablecode","scriptbody","shellcommand"].includes(normalized)) return true;
    if (hasExecutablePayload(child)) return true;
  }
  return false;
}
async function institutionRoute(request: Request, env: Phase10Env, route: string, now: number): Promise<Response> {
  const body = await bodyJson(request);
  const actorId = id(body.actor_id);
  if (!actorId || !(await requireAdmin(env.TUTOR_DB, actorId))) return json({ error: "admin_required" }, 403);
  const draftId = id(body.draft_id);
  if (route === "/institution-scenarios/draft" && request.method === "POST") {
    const draft = object(body.draft);
    if (!draftId || Object.keys(draft).length === 0 || hasExecutablePayload(draft)) return json({ error: "institution_draft_invalid" }, 400);
    const raw = JSON.stringify(draft);
    if (raw.length > 900000) return json({ error: "institution_draft_too_large" }, 413);
    await env.TUTOR_DB.prepare(
      "INSERT INTO institution_scenario_drafts(id,created_by_actor_id,status,draft_json,validation_json,resolved_content_hash,scenario_pack_id,scenario_version_id,catalog_slug,created_at,updated_at,published_at,retired_at) " +
      "VALUES (?,?,'draft',?,'{}','','','','',?,?,NULL,NULL) " +
      "ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,status='draft',validation_json='{}',resolved_content_hash='',updated_at=excluded.updated_at " +
      "WHERE institution_scenario_drafts.created_by_actor_id=excluded.created_by_actor_id AND institution_scenario_drafts.status NOT IN ('published','retired')"
    ).bind(draftId, actorId, raw, now, now).run();
    return json({ ok: true, draft_id: draftId, status: "draft" }, 201);
  }
  const existing = draftId ? await env.TUTOR_DB.prepare(
    "SELECT * FROM institution_scenario_drafts WHERE id=? LIMIT 1"
  ).bind(draftId).first<Record<string, unknown>>() : null;
  if (!existing) return json({ error: "institution_draft_not_found" }, 404);
  if (route === "/institution-scenarios/validation" && request.method === "POST") {
    if (existing.status === "published" || existing.status === "retired") return json({ error: "published_scenario_immutable" }, 409);
    const validation = object(body.validation);
    const valid = body.valid === true;
    const resolvedHash = valid ? text(body.resolved_content_hash, 64) : "";
    if (valid && !/^[0-9a-f]{64}$/.test(resolvedHash)) return json({ error: "institution_validation_invalid" }, 400);
    await env.TUTOR_DB.prepare(
      "UPDATE institution_scenario_drafts SET status=?,validation_json=?,resolved_content_hash=?,updated_at=? WHERE id=?"
    ).bind(valid ? "validated" : "validation_failed", JSON.stringify(validation), resolvedHash, now, draftId).run();
    return json({ ok: true, draft_id: draftId, status: valid ? "validated" : "validation_failed" });
  }
  if (route === "/institution-scenarios/publish-state" && request.method === "POST") {
    if (existing.status !== "validated") return json({ error: "institution_draft_not_validated" }, 409);
    const versionId = id(body.scenario_version_id);
    const packId = id(body.scenario_pack_id);
    const entry = await env.TUTOR_DB.prepare(
      "SELECT ce.catalog_slug,sv.content_hash FROM internship_catalog_entries ce JOIN scenario_versions sv ON sv.id=ce.scenario_version_id " +
      "WHERE ce.scenario_version_id=? AND ce.scenario_pack_id=? AND ce.catalog_state='published' AND ce.visible=1 LIMIT 1"
    ).bind(versionId, packId).first<{ catalog_slug: string; content_hash: string }>();
    if (!entry || entry.content_hash !== String(existing.resolved_content_hash || "")) return json({ error: "institution_publish_incomplete" }, 409);
    await env.TUTOR_DB.prepare(
      "UPDATE institution_scenario_drafts SET status='published',scenario_pack_id=?,scenario_version_id=?,catalog_slug=?,updated_at=?,published_at=? WHERE id=? AND status='validated'"
    ).bind(packId, versionId, entry.catalog_slug, now, now, draftId).run();
    return json({ ok: true, draft_id: draftId, status: "published", scenario_version_id: versionId, catalog_slug: entry.catalog_slug });
  }
  if (route === "/institution-scenarios/retire" && request.method === "POST") {
    if (existing.status !== "published") return json({ error: "institution_scenario_not_published" }, 409);
    const versionId = String(existing.scenario_version_id || "");
    await env.TUTOR_DB.batch([
      env.TUTOR_DB.prepare("UPDATE institution_scenario_drafts SET status='retired',updated_at=?,retired_at=? WHERE id=? AND status='published'").bind(now, now, draftId),
      env.TUTOR_DB.prepare("UPDATE internship_catalog_entries SET catalog_state='retired',visible=0,retired_at=?,updated_at=? WHERE scenario_version_id=?").bind(now, now, versionId),
    ]);
    return json({ ok: true, draft_id: draftId, status: "retired" });
  }
  return json({ error: "institution_route_not_found" }, 404);
}

export type CatalogStartAuthority = {
  ok: boolean;
  error?: string;
  scenario?: {
    id: string; scenario_pack_id: string; version: number; minimum_duration_days: number;
    expected_workload_band: string; content_hash: string; manifest_ref: string;
  };
  qualifying?: boolean;
  mode?: string;
  internship_type?: string;
};

export async function resolveCatalogStartAuthority(
  db: Phase10Database,
  selector: string,
  scenarioVersionId: string,
): Promise<CatalogStartAuthority> {
  const selectedVersion = id(scenarioVersionId);
  const selected = id(selector) || slug(selector);
  if (!selected) return { ok: false, error: "scenario_version_not_available" };
  if (!selectedVersion) {
    const catalogExists = await db.prepare(
      "SELECT 1 AS present FROM internship_catalog_entries ce JOIN scenario_packs sp ON sp.id=ce.scenario_pack_id WHERE sp.id=? OR sp.slug=? LIMIT 1"
    ).bind(selected, selected).first<{ present: number }>();
    if (catalogExists) return { ok: false, error: "scenario_version_required" };
    return { ok: false, error: "catalog_entry_not_found" };
  }
  const row = await db.prepare(
    "SELECT ce.internship_type,ce.qualifying,ce.mode,ce.catalog_state,ce.visible," +
    "sv.id,sv.scenario_pack_id,sv.version,sv.minimum_duration_days,sv.expected_workload_band,sv.status,sv.content_hash,sv.manifest_ref," +
    "sp.status AS pack_status,c.content_hash AS installed_hash,c.manifest_ref AS installed_ref,c.canonical_json " +
    "FROM internship_catalog_entries ce JOIN scenario_versions sv ON sv.id=ce.scenario_version_id " +
    "JOIN scenario_packs sp ON sp.id=sv.scenario_pack_id JOIN scenario_version_content c ON c.scenario_version_id=sv.id " +
    "WHERE ce.scenario_version_id=? AND (sp.id=? OR sp.slug=?) LIMIT 1"
  ).bind(selectedVersion, selected, selected).first<Record<string, unknown>>();
  if (!row) return { ok: false, error: "catalog_entry_not_found" };
  if (row.catalog_state !== "published" || Number(row.visible || 0) !== 1 || row.status !== "published" || row.pack_status !== "published") {
    return { ok: false, error: "scenario_version_retired" };
  }
  if (row.content_hash !== row.installed_hash || row.manifest_ref !== row.installed_ref) return { ok: false, error: "scenario_content_integrity_failed" };
  const manifest = object(object(parse(row.canonical_json, {})).manifest);
  const qualifying = manifest.qualifying === true;
  const mode = text(manifest.mode, 32) || (qualifying ? "standard" : "demo");
  const kind = text(row.internship_type, 32);
  if ((Number(row.qualifying || 0) === 1) !== qualifying || String(row.mode || "") !== mode) return { ok: false, error: "catalog_authority_mismatch" };
  if (qualifying) {
    if (kind !== "qualifying" || text(manifest.classification, 32) !== "qualifying" || mode !== "standard" || Number(row.minimum_duration_days || 0) < 90) {
      return { ok: false, error: "catalog_authority_mismatch" };
    }
    const policy = await db.prepare("SELECT scenario_version_id FROM scenario_completion_policies WHERE scenario_version_id=? LIMIT 1")
      .bind(selectedVersion).first<{ scenario_version_id: string }>();
    if (!policy) return { ok: false, error: "completion_policy_missing" };
  } else if (kind !== "practice" || text(manifest.classification, 32) !== "demo" || mode !== "demo") {
    return { ok: false, error: "catalog_authority_mismatch" };
  }
  return {
    ok: true,
    scenario: {
      id: String(row.id || ""), scenario_pack_id: String(row.scenario_pack_id || ""), version: Number(row.version || 0),
      minimum_duration_days: Number(row.minimum_duration_days || 0), expected_workload_band: String(row.expected_workload_band || ""),
      content_hash: String(row.content_hash || ""), manifest_ref: String(row.manifest_ref || ""),
    },
    qualifying, mode, internship_type: kind,
  };
}

export async function handlePhase10CatalogPersistenceRoute(
  request: Request, env: Phase10Env, route: string, now: number,
): Promise<Response | null> {
  if (route === "/catalog/list" && request.method === "GET") return catalogList(request, env);
  if (route === "/catalog/facets" && request.method === "GET") return catalogFacets(env);
  if (route === "/catalog/detail" && request.method === "GET") return catalogDetailRoute(request, env, now);
  if (route === "/catalog/project" && request.method === "POST") return projectCatalog(request, env, now);
  if (route.startsWith("/institution-scenarios/")) return institutionRoute(request, env, route, now);
  return null;
}
