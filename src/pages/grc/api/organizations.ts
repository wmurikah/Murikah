export const prerender = false;

/**
 * Provision a new customer organisation, platform owner only. Seeds the org with
 * its Phase 1 config, the reference dropdowns, a first SUPER_ADMIN user and a
 * trial subscription in one transactional batch, so every tenant starts
 * configured. The admin password is hashed before storage; the plain text is
 * never stored.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { hashPassword } from '@grc/auth/password';
import { provisionOrganization } from '@grc/repos/provisioning';
import { writeAuditLog } from '@grc/repos/audit';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');
  if (!grc.isPlatformOwner) return new Response('Forbidden', { status: 403 });

  const form = await request.formData();
  const organizationName = String(form.get('organization_name') ?? '').trim();
  const adminEmail = String(form.get('admin_email') ?? '')
    .trim()
    .toLowerCase();
  const adminName = String(form.get('admin_name') ?? '').trim();
  const password = String(form.get('admin_password') ?? '');
  if (!organizationName || !adminEmail || !adminName || password.length < 8) {
    return redirect(
      `/settings/provision?error=${encodeURIComponent('All fields are required; the password must be at least 8 characters.')}`,
    );
  }

  const db = await getDb(getGrcEnv());
  try {
    const adminPasswordHash = await hashPassword(password);
    const { organizationId } = await provisionOrganization(db, {
      organizationName,
      adminEmail,
      adminName,
      adminPasswordHash,
      now: new Date(),
    });
    try {
      await writeAuditLog(db, {
        organizationId,
        userId: grc.userId,
        action: 'ORGANIZATION.provision',
        details: organizationName,
      });
    } catch {
      // best-effort audit
    }
    return redirect(
      `/settings/provision?done=${encodeURIComponent(`Provisioned ${organizationName}. The first SUPER_ADMIN can now sign in.`)}`,
    );
  } catch {
    return redirect(
      `/settings/provision?error=${encodeURIComponent('Could not provision the organisation. Check that the email is not already in use.')}`,
    );
  }
};
