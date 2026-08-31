/**
 * What a job title USUALLY comes with, and why that is not what it grants.
 *
 * A job title is an organisational position. An access role is a set of
 * application permissions. A workflow role is approval authority in a business
 * process. Those are three different things and this file does not merge them:
 * it holds a CATALOGUE OF DEFAULTS saying "somebody who is a Finance Manager
 * is usually given these roles", and nothing more.
 *
 * NOTHING IN THE PERMISSION PATH READS THESE TABLES. The resolver walks
 * user_roles -> access_roles -> role_permissions -> permissions, exactly as it
 * did before, and approval routing walks workflow_role_assignments. A mapping
 * is offered to an administrator on screen and is written to a user's access
 * only when that administrator confirms it with an explicit data scope. So
 * adding a mapping grants nobody anything, changing one revokes nothing, and a
 * title can never become a back door into access.
 *
 * WHICH IS WHY `applyDefaults` LIVES ELSEWHERE. This file reads and writes the
 * catalogue. Turning a suggestion into somebody's actual access goes through
 * the ordinary role assignment path in rbacAdmin.ts, with the ordinary
 * authorisation, the ordinary scope requirement and the ordinary audit rows —
 * so there is exactly one way a role is ever granted.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const flag = (v: unknown): boolean => Number(v ?? 0) === 1;
const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

function audit(
  ctx: WriteContext,
  eventType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType: 'JOB_TITLE_MAPPING',
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

/**
 * The two mapping kinds, as one type.
 *
 * They are separate TABLES on purpose — an access role and a workflow role
 * point at different catalogues and mean different things — but the read and
 * write shapes are identical, so one set of functions serves both and there is
 * no second implementation to drift.
 */
export type MappingKind = 'ACCESS' | 'WORKFLOW';

interface KindShape {
  table: string;
  column: string;
  catalogue: string;
  catalogueId: string;
  catalogueName: string;
  activeColumn: string;
  event: string;
}

const SHAPES: Record<MappingKind, KindShape> = {
  ACCESS: {
    table: 'job_title_access_role_mappings',
    column: 'role_id',
    catalogue: 'access_roles',
    catalogueId: 'role_id',
    catalogueName: 'role_name',
    activeColumn: 'active',
    event: 'JOB_TITLE_ROLE_MAPPING',
  },
  WORKFLOW: {
    table: 'job_title_workflow_role_mappings',
    column: 'workflow_role_id',
    catalogue: 'workflow_roles',
    catalogueId: 'workflow_role_id',
    catalogueName: 'role_name',
    activeColumn: 'active',
    event: 'JOB_TITLE_WORKFLOW_MAPPING',
  },
};

export interface MappingRow {
  mappingId: string;
  kind: MappingKind;
  jobTitleId: string;
  jobTitle: string;
  /** The access role id or the workflow role id, depending on `kind`. */
  targetId: string;
  targetName: string;
  /** Whether the mapped role is itself still active in its own catalogue. */
  targetActive: boolean;
  active: boolean;
  createdAt: string;
}

function toMapping(kind: MappingKind, row: Record<string, unknown>): MappingRow {
  return {
    mappingId: text(row.mapping_id),
    kind,
    jobTitleId: text(row.job_title_id),
    jobTitle: text(row.title_name),
    targetId: text(row.target_id),
    targetName: text(row.target_name),
    targetActive: flag(row.target_active),
    active: flag(row.active),
    createdAt: text(row.created_at),
  };
}

function selectFor(kind: MappingKind): string {
  const shape = SHAPES[kind];
  return `
    SELECT m.mapping_id, m.job_title_id, m.active, m.created_at,
           jt.title_name,
           m.${shape.column} AS target_id,
           t.${shape.catalogueName} AS target_name,
           t.${shape.activeColumn} AS target_active
      FROM ${shape.table} m
      JOIN job_titles jt ON jt.job_title_id = m.job_title_id
      JOIN ${shape.catalogue} t ON t.${shape.catalogueId} = m.${shape.column}`;
}

/**
 * Every mapping of one kind, newest catalogue order.
 *
 * Read whole rather than per title: the whole catalogue is a few dozen rows at
 * most, and the mapping screen shows every title at once. One statement for
 * the page beats one per row.
 */
export async function listMappings(db: Client, kind: MappingKind): Promise<MappingRow[]> {
  const result = await db.execute(`${selectFor(kind)} ORDER BY jt.title_name, target_name`);
  return result.rows.map((row) => toMapping(kind, row));
}

/** Both kinds for one title, which is what the user Edit screen asks for. */
export async function mappingsForTitle(
  db: Client,
  jobTitleId: string,
): Promise<{ access: MappingRow[]; workflow: MappingRow[] }> {
  if (jobTitleId === '') return { access: [], workflow: [] };
  const [access, workflow] = await Promise.all([
    db.execute({
      sql: `${selectFor('ACCESS')} WHERE m.job_title_id = ? AND m.active = 1 ORDER BY target_name`,
      args: [jobTitleId],
    }),
    db.execute({
      sql: `${selectFor('WORKFLOW')} WHERE m.job_title_id = ? AND m.active = 1 ORDER BY target_name`,
      args: [jobTitleId],
    }),
  ]);
  return {
    access: access.rows.map((row) => toMapping('ACCESS', row)),
    workflow: workflow.rows.map((row) => toMapping('WORKFLOW', row)),
  };
}

/**
 * The role ids a title maps to, for the server to check a claimed default
 * against.
 *
 * The apply endpoint refuses any role the client sends that is not in this
 * set. A payload cannot therefore turn "apply the defaults for Finance
 * Manager" into "give me the administrator role", however it is rewritten in
 * the browser.
 */
export async function mappedRoleIds(
  db: Client,
  kind: MappingKind,
  jobTitleId: string,
): Promise<Set<string>> {
  const shape = SHAPES[kind];
  const result = await db.execute({
    sql: `SELECT m.${shape.column} AS target_id
            FROM ${shape.table} m
            JOIN ${shape.catalogue} t ON t.${shape.catalogueId} = m.${shape.column}
           WHERE m.job_title_id = ? AND m.active = 1 AND t.${shape.activeColumn} = 1`,
    args: [jobTitleId],
  });
  return new Set(result.rows.map((row) => text(row.target_id)));
}

export interface MappingInput {
  jobTitleId: string;
  targetId: string;
  active: boolean;
}

async function exists(db: Client, table: string, column: string, id: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
    args: [id],
  });
  return result.rows.length > 0;
}

/**
 * Add a default.
 *
 * A duplicate is a conflict rather than a silent no-op: an administrator who
 * adds a mapping that is already there has misread the screen, and saying so
 * is more useful than pretending the click did something.
 */
export async function createMapping(
  db: Client,
  kind: MappingKind,
  input: MappingInput,
  ctx: WriteContext,
): Promise<WriteResult<MappingRow>> {
  const shape = SHAPES[kind];
  const fields: FieldError[] = [];
  if (!(await exists(db, 'job_titles', 'job_title_id', input.jobTitleId))) {
    fields.push({ field: 'jobTitleId', message: 'That job title does not exist.' });
  }
  if (!(await exists(db, shape.catalogue, shape.catalogueId, input.targetId))) {
    fields.push({ field: 'targetId', message: 'That role does not exist.' });
  }
  if (fields.length > 0) return { ok: false, kind: 'invalid_reference', fields };

  const mappingId = newId('JTM');
  const now = toDbTimestamp(ctx.now);
  const after = { jobTitleId: input.jobTitleId, targetId: input.targetId, active: input.active };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO ${shape.table}
                  (mapping_id, job_title_id, ${shape.column}, active, created_at, updated_at, created_by_user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            mappingId,
            input.jobTitleId,
            input.targetId,
            input.active ? 1 : 0,
            now,
            now,
            ctx.actorUserId,
          ],
        },
        audit(ctx, `${shape.event}_CREATED`, mappingId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'targetId', message: 'That role is already a default for this title.' }],
      };
    }
    throw error;
  }
  const created = await getMapping(db, kind, mappingId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function getMapping(
  db: Client,
  kind: MappingKind,
  mappingId: string,
): Promise<MappingRow | null> {
  const result = await db.execute({
    sql: `${selectFor(kind)} WHERE m.mapping_id = ? LIMIT 1`,
    args: [mappingId],
  });
  const row = result.rows[0];
  return row ? toMapping(kind, row) : null;
}

/** Turn a default on or off without losing the record that it was configured. */
export async function updateMapping(
  db: Client,
  kind: MappingKind,
  mappingId: string,
  active: boolean,
  ctx: WriteContext,
): Promise<WriteResult<MappingRow>> {
  const before = await getMapping(db, kind, mappingId);
  if (!before) return { ok: false, kind: 'not_found' };
  const shape = SHAPES[kind];
  await db.batch(
    [
      {
        sql: `UPDATE ${shape.table} SET active = ?, updated_at = ? WHERE mapping_id = ?`,
        args: [active ? 1 : 0, toDbTimestamp(ctx.now), mappingId],
      },
      audit(
        ctx,
        `${shape.event}_UPDATED`,
        mappingId,
        'UPDATE',
        { active: before.active },
        { active },
      ),
    ],
    'write',
  );
  const updated = await getMapping(db, kind, mappingId);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

/**
 * Remove a default outright.
 *
 * Deleting a mapping row is safe in a way that deleting a role assignment is
 * not: nobody's access changes, because nobody's access ever came from here.
 * The audit row records what the default was, so the catalogue's history is
 * still answerable.
 */
export async function deleteMapping(
  db: Client,
  kind: MappingKind,
  mappingId: string,
  ctx: WriteContext,
): Promise<WriteResult<MappingRow>> {
  const before = await getMapping(db, kind, mappingId);
  if (!before) return { ok: false, kind: 'not_found' };
  const shape = SHAPES[kind];
  await db.batch(
    [
      { sql: `DELETE FROM ${shape.table} WHERE mapping_id = ?`, args: [mappingId] },
      audit(
        ctx,
        `${shape.event}_REMOVED`,
        mappingId,
        'DELETE',
        {
          jobTitleId: before.jobTitleId,
          targetId: before.targetId,
          targetName: before.targetName,
          active: before.active,
        },
        null,
      ),
    ],
    'write',
  );
  return { ok: true, value: before };
}
