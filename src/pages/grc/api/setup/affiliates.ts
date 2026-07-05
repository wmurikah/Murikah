export const prerender = false;

/**
 * Affiliates CRUD, SUPER_ADMIN (or platform owner) only, gated on the CONFIG
 * module. Every write is scoped to the acting organisation, validated
 * server-side and audited. The code is immutable once created; a delete is
 * refused while any work paper or action plan references the affiliate
 * (deactivate instead). Returns to the affiliates page with a saved or error
 * banner.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { writeAuditLog } from '@grc/repos/audit';
import { normaliseCode, isValidCode, requireText, optionalText } from '@grc/repos/setupValidation';
import {
  createAffiliate,
  updateAffiliate,
  setAffiliateActive,
  affiliateExists,
  affiliateInUse,
  deleteAffiliate,
} from '@grc/repos/affiliatesAdmin';

const PAGE = '/settings/affiliates';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const ok = (msg: string): Response => back(`saved=${encodeURIComponent(msg)}`);
const bad = (msg: string): Response => back(`error=${encodeURIComponent(msg)}`);

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const action = op === 'create' ? 'create' : op === 'delete' ? 'delete' : 'update';
  if (!can(locals, action, 'CONFIG')) return bad('You cannot manage affiliates.');

  const db = await getDb(getGrcEnv());
  const org = grc.organizationId;
  const audit = (a: string, id: string, details?: string): Promise<void> =>
    writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: a,
      entityType: 'affiliate',
      entityId: id,
      details: details ?? null,
    }).catch(() => undefined);

  try {
    if (op === 'create') {
      const name = requireText(String(form.get('name') ?? ''), 120);
      const code = normaliseCode(String(form.get('code') ?? name ?? ''));
      if (!name) return bad('An affiliate name is required.');
      if (!isValidCode(code)) return bad('The affiliate code is not valid.');
      if (await affiliateExists(db, org, code)) return bad(`The code ${code} is already in use.`);
      await createAffiliate(db, org, code, {
        name,
        country: optionalText(String(form.get('country') ?? ''), 80),
        region: optionalText(String(form.get('region') ?? ''), 80),
      });
      await audit('AFFILIATE.create', code);
      return ok(`Affiliate ${code} created.`);
    }

    const code = String(form.get('code') ?? '');
    if (!code) return bad('No affiliate was specified.');

    if (op === 'update') {
      const name = requireText(String(form.get('name') ?? ''), 120);
      if (!name) return bad('An affiliate name is required.');
      await updateAffiliate(db, org, code, {
        name,
        country: optionalText(String(form.get('country') ?? ''), 80),
        region: optionalText(String(form.get('region') ?? ''), 80),
      });
      await audit('AFFILIATE.update', code);
      return ok(`Affiliate ${code} saved.`);
    }
    if (op === 'activate' || op === 'deactivate') {
      await setAffiliateActive(db, org, code, op === 'activate');
      await audit(`AFFILIATE.${op}`, code);
      return ok(`Affiliate ${code} ${op === 'activate' ? 'activated' : 'deactivated'}.`);
    }
    if (op === 'delete') {
      if (await affiliateInUse(db, org, code)) {
        return bad(`${code} is referenced by work papers or action plans; deactivate it instead.`);
      }
      await deleteAffiliate(db, org, code);
      await audit('AFFILIATE.delete', code);
      return ok(`Affiliate ${code} deleted.`);
    }
    return bad('Unknown action.');
  } catch (err) {
    console.error('[grc.setup.affiliates]', err);
    return bad('The change could not be saved. Please try again.');
  }
};
