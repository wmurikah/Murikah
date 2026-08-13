/**
 * The three notifications the requirements loop sends (Build Prompt 58).
 *
 * They queue through the universal queue every other module uses, so they render
 * with the same branded layout, mirror in-app, retry the same way and, being
 * normal priority, collapse into the same per-recipient digest: an auditor who
 * raises fifteen requirements on a Monday sends each owner one email listing
 * what they owe, not fifteen.
 *
 * Recipients are explicit here rather than resolved through
 * `repos/notify.ts::enqueueNotification`, which routes by work paper or action
 * plan party. The parties to a requirement are its named owners and the auditor
 * who asked, and neither is derivable from the finding it hangs off: an owner is
 * routinely somebody with no involvement in the work paper at all.
 *
 * Every call is best-effort. A requirement must still be raised, answered and
 * closed when mail is unconfigured, so nothing here is allowed to throw.
 */
import type { Client } from '@libsql/client/web';
import { queueNotification } from './queue';
import { resolveActiveRecipients } from './recipients';
import { entityLink } from './links';
import type { Payload } from './render';
import type { NotificationType } from './types';

export interface RequirementNotice {
  requirementId: string;
  /**
   * The linked finding's reference, when there is one. Audit-facing only: an
   * owner never sees it, and a requirement is routinely linked to nothing
   * (Build Prompt 69).
   */
  reference: string;
  /** What was asked for, trimmed to a line an email can carry. */
  description: string;
  dueDate?: string | null;
  /** Where the ask stands, which is the third column of the owner's table. */
  status?: string | null;
  /** The further question, on a more-information round. */
  additionalInfoRequest?: string | null;
  /** The person who caused the event, never notified about their own action. */
  actorUserId: string;
}

const MAX_LINE = 300;

function payloadFor(notice: RequirementNotice): Payload {
  const data: Payload = {
    reference: notice.reference,
    title: notice.description.slice(0, MAX_LINE),
    link: entityLink('requirement', notice.requirementId),
  };
  if (notice.dueDate) data.dueDate = notice.dueDate;
  if (notice.status) data.status = notice.status;
  if (notice.additionalInfoRequest) {
    data.additionalInfoRequest = notice.additionalInfoRequest.slice(0, MAX_LINE);
  }
  return data;
}

async function notify(
  db: Client,
  organizationId: string,
  type: NotificationType,
  userIds: string[],
  notice: RequirementNotice,
): Promise<void> {
  try {
    const recipients = (await resolveActiveRecipients(db, organizationId, userIds)).filter(
      (r) => r.userId !== notice.actorUserId,
    );
    const data = payloadFor(notice);
    for (const recipient of recipients) {
      await queueNotification(db, organizationId, {
        type,
        recipient,
        data,
        relatedEntityType: 'requirement',
        relatedEntityId: notice.requirementId,
        actorUserId: notice.actorUserId,
      });
    }
  } catch (err) {
    console.error('[grc.notify.requirements] enqueue failed', err);
  }
}

/**
 * Tell the recipients they have been asked for something: the owners who owe it
 * and the people copied on the request alike (Build Prompt 69). One email, one
 * table, one button, and nothing in it about a work paper.
 */
export async function notifyRequirementAssigned(
  db: Client,
  organizationId: string,
  ownerIds: string[],
  notice: RequirementNotice,
): Promise<void> {
  await notify(db, organizationId, 'REQUIREMENT_ASSIGNED', ownerIds, notice);
}

/** Tell audit that an owner has provided something to review. */
export async function notifyRequirementSubmitted(
  db: Client,
  organizationId: string,
  auditorIds: string[],
  notice: RequirementNotice,
): Promise<void> {
  await notify(db, organizationId, 'REQUIREMENT_SUBMITTED', auditorIds, notice);
}

/** Tell the owners that audit has read it and wants more. */
export async function notifyRequirementMoreInfo(
  db: Client,
  organizationId: string,
  ownerIds: string[],
  notice: RequirementNotice,
): Promise<void> {
  await notify(db, organizationId, 'REQUIREMENT_MORE_INFO', ownerIds, notice);
}
