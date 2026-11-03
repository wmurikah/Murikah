/**
 * Create an invited internal user and bind an unresolved source name to them.
 *
 * A spreadsheet username is never enough to create an account automatically.
 * This operation is called only after a user administrator supplies the
 * person's name and email. User creation and source-name mapping share one
 * write transaction, so a failed mapping cannot leave behind an orphaned user.
 */
import type { Client } from '@libsql/client/web';
import type { WriteContext } from '../admin/guard.ts';
import type { CreateUserInput } from '../admin/userInput.ts';
import type { AssignmentInput } from '../admin/userInput.ts';
import type { IssuedInvitation } from '../admin/invitation.ts';
import {
  createAssignment,
  createUser,
  type AssignmentRow,
  type CreatedUser,
  type WriteResult,
} from '../repos/userAdmin.ts';
import {
  mapUnresolvedActor,
  revalidateBatch,
  type MapActorResult,
  type RevalidateOutcome,
} from './uploadCentre.ts';

type CreateFailure = Extract<WriteResult<CreatedUser>, { ok: false }>;
type AssignmentFailure = Extract<WriteResult<AssignmentRow>, { ok: false }>;

export type CreateAndMapActorResult =
  | {
      ok: true;
      user: CreatedUser['user'];
      assignment: AssignmentRow;
      invitationToken: string;
      sourceIdentityId: string;
      revalidated: RevalidateOutcome | null;
    }
  | { ok: false; kind: 'user'; result: CreateFailure }
  | { ok: false; kind: 'assignment'; result: AssignmentFailure }
  | { ok: false; kind: 'mapping'; reason: string };

export async function createAndMapUnresolvedActor(
  db: Client,
  input: {
    unresolvedActorId: string;
    user: CreateUserInput;
    assignment: AssignmentInput;
    invitation: IssuedInvitation;
    revalidate: boolean;
  },
  ctx: WriteContext,
): Promise<CreateAndMapActorResult> {
  const tx = await db.transaction('write');
  let batchId = '';
  let created: CreatedUser | null = null;
  let assignment: AssignmentRow | null = null;
  let mapped: Extract<MapActorResult, { ok: true }> | null = null;

  try {
    const actor = await tx.execute({
      sql: `SELECT import_batch_id FROM unresolved_actors
            WHERE unresolved_actor_id = ? AND status = 'OPEN'`,
      args: [input.unresolvedActorId],
    });
    if (actor.rows[0] === undefined) {
      await tx.rollback();
      return { ok: false, kind: 'mapping', reason: 'not_found_or_resolved' };
    }
    batchId = String(actor.rows[0].import_batch_id);

    // Both repositories use only execute and batch, which Transaction
    // implements. The cast avoids widening their public API to transaction
    // methods that ordinary repository callers do not need.
    const transactionalDb = tx as unknown as Client;
    const createResult = await createUser(transactionalDb, input.user, input.invitation, ctx);
    if (!createResult.ok) {
      await tx.rollback();
      return { ok: false, kind: 'user', result: createResult };
    }
    created = createResult.value;

    const assignmentResult = await createAssignment(
      transactionalDb,
      created.user.userId,
      input.assignment,
      ctx,
    );
    if (!assignmentResult.ok) {
      await tx.rollback();
      return { ok: false, kind: 'assignment', result: assignmentResult };
    }
    assignment = assignmentResult.value;

    const mapResult = await mapUnresolvedActor(
      transactionalDb,
      {
        unresolvedActorId: input.unresolvedActorId,
        userId: created.user.userId,
        revalidate: false,
      },
      ctx,
    );
    if (!mapResult.ok) {
      await tx.rollback();
      return { ok: false, kind: 'mapping', reason: mapResult.reason };
    }
    mapped = mapResult;
    await tx.commit();
  } finally {
    tx.close();
  }

  // Revalidation can be comparatively expensive and does not belong inside
  // the account transaction. The durable mapping is already available to it.
  const revalidated = input.revalidate ? await revalidateBatch(db, batchId, ctx) : null;
  if (created === null || assignment === null || mapped === null)
    throw new Error('Create-and-map transaction lost state.');
  return {
    ok: true,
    user: created.user,
    assignment,
    invitationToken: created.invitationToken,
    sourceIdentityId: mapped.sourceIdentityId,
    revalidated,
  };
}
