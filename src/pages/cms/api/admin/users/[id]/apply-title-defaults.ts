/**
 * POST /api/admin/users/{id}/apply-title-defaults on cms.murikah.com.
 *
 * "Apply mapped access": the administrator saw what a job title normally
 * carries, chose a data scope for each one, and confirmed. This writes them.
 *
 * FOUR THINGS MAKE THIS SAFE, AND ALL FOUR ARE HERE RATHER THAN ON THE SCREEN.
 *
 * 1. NOTHING IS APPLIED BY CHANGING A TITLE. Setting a job title is a
 *    different endpoint that writes an assignment and no access at all. This
 *    one exists precisely so that granting is a separate, deliberate act with
 *    its own request, and a title change can never escalate anybody by itself.
 *
 * 2. THE CLAIM IS RE-DERIVED, NEVER TRUSTED. Every role id in the payload is
 *    checked against the title's actual mapping, read here from the database.
 *    A rewritten browser cannot turn "apply the Finance Manager defaults" into
 *    "give me the administrator role": a role that is not mapped to that title
 *    is refused by name.
 *
 * 3. EVERY GRANT CARRIES AN EXPLICIT SCOPE THE ADMINISTRATOR CHOSE. No scope
 *    is inferred from the job title, the assignment or anything else, and none
 *    is defaulted to GROUP. A payload with a missing or unrecognised scope is
 *    invalid; see ../../../../../lib/cms/admin/jobTitleMappingInput.ts.
 *
 * 4. TWO PERMISSIONS, NOT ONE. Access roles need ADMIN.ROLES.MANAGE and
 *    workflow authority needs ADMIN.WORKFLOW_ROLES.MANAGE, checked separately
 *    against what the payload actually asks for. A person who may grant access
 *    roles does not thereby gain the ability to grant approval authority, and
 *    a request that asks for both without holding both is refused whole.
 *
 * The writes go through the ordinary `assignUserRole` and `createAssignment`
 * paths, so the self-grant refusal, the scope CHECKs and the ordinary audit
 * rows all apply exactly as they do to a role granted one at a time. There is
 * no second way into `user_roles`.
 */
import type { APIRoute } from 'astro';
import { writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { canManageRoles, canManageWorkflowRoles } from '../../../../../../lib/cms/permissions.ts';
import { forbidden, unauthorised } from '../../../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../../../lib/cms/admin/userInput.ts';
import { validateApplyDefaults } from '../../../../../../lib/cms/admin/jobTitleMappingInput.ts';
import { mappedRoleIds } from '../../../../../../lib/cms/repos/jobTitleMappings.ts';
import {
  assignUserRole,
  listUserRoleAssignments,
} from '../../../../../../lib/cms/repos/rbacAdmin.ts';
import { createAssignment } from '../../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const principal = context.locals.cms;
  if (!principal) return unauthorised();

  const parsed = validateApplyDefaults(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const { jobTitleId, roles, authorities } = parsed.value;

  // The check is against what this request actually asks for. Asking for
  // nothing of a kind needs no permission for that kind; asking for any of it
  // needs all of it.
  const permissions = principal.user.permissions;
  if (roles.length > 0 && !canManageRoles(permissions)) return forbidden();
  if (authorities.length > 0 && !canManageWorkflowRoles(permissions)) return forbidden();

  const ctx = writeContext(context.request, {
    sessionId: principal.sessionId,
    user: principal.user,
  });
  const userId = context.params.id ?? '';
  // The self-grant refusal lives in the repository and would catch this on the
  // first write, but catching it here means an "apply five roles" request that
  // is going to be refused is refused before any of the five is written.
  if (userId === ctx.actorUserId) {
    return invalid([
      { field: 'roles', message: 'You cannot change your own access. Ask another administrator.' },
    ]);
  }

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const [allowedRoles, allowedAuthorities] = await Promise.all([
      mappedRoleIds(connection.db, 'ACCESS', jobTitleId),
      mappedRoleIds(connection.db, 'WORKFLOW', jobTitleId),
    ]);
    const unmapped = [
      ...roles.filter((role) => !allowedRoles.has(role.roleId)).map(() => 'roles'),
      ...authorities
        .filter((one) => !allowedAuthorities.has(one.workflowRoleId))
        .map(() => 'authorities'),
    ];
    if (unmapped.length > 0) {
      return invalid([
        {
          field: unmapped[0] ?? 'roles',
          message: 'That is not a default for this job title. Reload and try again.',
        },
      ]);
    }

    // ALREADY HELD IS RETAINED, NOT RE-GRANTED. A person may already carry one
    // of the title's defaults, assigned by hand with a scope somebody chose
    // deliberately. Re-inserting it would collide with the uniqueness rule and
    // abandon the run halfway; overwriting it would silently replace that
    // chosen scope. Skipping it leaves the existing grant exactly as it is,
    // which is what "retained" means on the screen.
    const held = await listUserRoleAssignments(connection.db, userId);
    const current = new Set(held.filter((row) => row.current).map((row) => row.roleId));

    const today = isoDay(ctx.now);
    const applied: { roles: string[]; authorities: string[]; retained: string[] } = {
      roles: [],
      authorities: [],
      retained: [],
    };
    for (const role of roles) {
      if (current.has(role.roleId)) {
        applied.retained.push(role.roleId);
        continue;
      }
      const result = await assignUserRole(
        connection.db,
        userId,
        {
          roleId: role.roleId,
          effectiveFrom: today,
          effectiveTo: null,
          active: true,
          scopes: [
            {
              scopeType: role.scopeType,
              countryId: role.countryId,
              affiliateId: role.affiliateId,
              businessUnitId: role.businessUnitId,
              teamId: role.teamId,
            },
          ],
        },
        ctx,
      );
      // A refusal is reported rather than swallowed: the self-grant guard and
      // the duplicate guard both land here, and an administrator who is told
      // "applied" when nothing was is worse off than one who is told why.
      if (!result.ok) return failure(result);
      applied.roles.push(result.value.userRoleId);
    }
    for (const one of authorities) {
      const result = await createAssignment(
        connection.db,
        {
          workflowRoleId: one.workflowRoleId,
          userId,
          scopeType: one.scopeType,
          countryId: one.countryId,
          affiliateId: one.affiliateId,
          businessUnitId: one.businessUnitId,
          priority: 100,
          effectiveFrom: today,
          effectiveTo: null,
          active: true,
        },
        ctx,
      );
      if (!result.ok) return failure(result);
      applied.authorities.push(result.value.assignmentId);
    }
    return ok(applied, 201);
  } catch (error) {
    return serverError('admin.users.applyTitleDefaults', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
