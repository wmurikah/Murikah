export const prerender = false;

/**
 * Audit universe CRUD: audit areas and their sub-areas. SUPER_ADMIN (or platform
 * owner) only, gated on the CONFIG module, scoped to the acting organisation,
 * validated and audited. An area cannot be deleted while it has sub-areas or a
 * referencing work paper; a sub-area cannot be deleted while a work paper
 * references it (deactivate instead). Returns with a saved or error banner.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { writeAuditLog } from '@grc/repos/audit';
import { normaliseCode, requireText, optionalText } from '@grc/repos/setupValidation';
import {
  createAuditArea,
  updateAuditArea,
  setAuditAreaActive,
  auditAreaBlockers,
  deleteAuditArea,
  createSubArea,
  updateSubArea,
  setSubAreaActive,
  subAreaInUse,
  deleteSubArea,
  type SubAreaInput,
} from '@grc/repos/auditUniverse';

const PAGE = '/settings/audit-universe';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const ok = (msg: string): Response => back(`saved=${encodeURIComponent(msg)}`);
const bad = (msg: string): Response => back(`error=${encodeURIComponent(msg)}`);

function subInput(form: FormData): SubAreaInput | null {
  const name = requireText(String(form.get('name') ?? ''), 160);
  if (!name) return null;
  return {
    name,
    controlObjectives: optionalText(String(form.get('control_objectives') ?? ''), 4000),
    riskDescription: optionalText(String(form.get('risk_description') ?? ''), 4000),
    testObjective: optionalText(String(form.get('test_objective') ?? ''), 4000),
    testingSteps: optionalText(String(form.get('testing_steps') ?? ''), 8000),
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const action = op.endsWith('create') ? 'create' : op.endsWith('delete') ? 'delete' : 'update';
  if (!can(locals, action, 'CONFIG')) return bad('You cannot manage the audit universe.');

  const db = await getDb(getGrcEnv());
  const org = grc.organizationId;
  const audit = (a: string, type: string, id: string): Promise<void> =>
    writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: a,
      entityType: type,
      entityId: id,
    }).catch(() => undefined);

  try {
    // ---- Areas ----
    if (op === 'area_create') {
      const name = requireText(String(form.get('name') ?? ''), 160);
      if (!name) return bad('An area name is required.');
      const id = await createAuditArea(db, org, {
        code: normaliseCode(String(form.get('code') ?? name)) || null,
        name,
        description: optionalText(String(form.get('description') ?? ''), 2000),
      });
      await audit('AUDIT_AREA.create', 'audit_area', id);
      return ok(`Audit area ${name} created.`);
    }
    if (op.startsWith('area_')) {
      const areaId = String(form.get('area_id') ?? '');
      if (!areaId) return bad('No audit area was specified.');
      if (op === 'area_update') {
        const name = requireText(String(form.get('name') ?? ''), 160);
        if (!name) return bad('An area name is required.');
        await updateAuditArea(db, org, areaId, {
          code: normaliseCode(String(form.get('code') ?? name)) || null,
          name,
          description: optionalText(String(form.get('description') ?? ''), 2000),
        });
        await audit('AUDIT_AREA.update', 'audit_area', areaId);
        return ok('Audit area saved.');
      }
      if (op === 'area_activate' || op === 'area_deactivate') {
        await setAuditAreaActive(db, org, areaId, op === 'area_activate');
        await audit(
          `AUDIT_AREA.${op === 'area_activate' ? 'activate' : 'deactivate'}`,
          'audit_area',
          areaId,
        );
        return ok(`Audit area ${op === 'area_activate' ? 'activated' : 'deactivated'}.`);
      }
      if (op === 'area_delete') {
        const { hasSubAreas, inUse } = await auditAreaBlockers(db, org, areaId);
        if (hasSubAreas) return bad('Remove or move its sub-areas before deleting this area.');
        if (inUse) return bad('This area is referenced by work papers; deactivate it instead.');
        await deleteAuditArea(db, org, areaId);
        await audit('AUDIT_AREA.delete', 'audit_area', areaId);
        return ok('Audit area deleted.');
      }
    }

    // ---- Sub-areas ----
    if (op === 'sub_create') {
      const areaId = String(form.get('area_id') ?? '');
      if (!areaId) return bad('No parent audit area was specified.');
      const input = subInput(form);
      if (!input) return bad('A sub-area name is required.');
      const id = await createSubArea(db, org, areaId, input);
      await audit('SUB_AREA.create', 'sub_area', id);
      return ok(`Sub-area ${input.name} created.`);
    }
    if (op.startsWith('sub_')) {
      const subId = String(form.get('sub_id') ?? '');
      if (!subId) return bad('No sub-area was specified.');
      if (op === 'sub_update') {
        const input = subInput(form);
        if (!input) return bad('A sub-area name is required.');
        await updateSubArea(db, org, subId, input);
        await audit('SUB_AREA.update', 'sub_area', subId);
        return ok('Sub-area saved.');
      }
      if (op === 'sub_activate' || op === 'sub_deactivate') {
        await setSubAreaActive(db, org, subId, op === 'sub_activate');
        await audit(
          `SUB_AREA.${op === 'sub_activate' ? 'activate' : 'deactivate'}`,
          'sub_area',
          subId,
        );
        return ok(`Sub-area ${op === 'sub_activate' ? 'activated' : 'deactivated'}.`);
      }
      if (op === 'sub_delete') {
        if (await subAreaInUse(db, org, subId)) {
          return bad('This sub-area is referenced by work papers; deactivate it instead.');
        }
        await deleteSubArea(db, org, subId);
        await audit('SUB_AREA.delete', 'sub_area', subId);
        return ok('Sub-area deleted.');
      }
    }
    return bad('Unknown action.');
  } catch (err) {
    console.error('[grc.setup.audit-universe]', err);
    return bad('The change could not be saved. Please try again.');
  }
};
