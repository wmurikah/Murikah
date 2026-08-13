/**
 * ROUND ORDER. `round_number` is the ordinal, and every read here orders by it.
 * It falls back to `submitted_at` for a row that has not been numbered yet
 * (Build Prompt 61): the live table was created without the column by the
 * operator's own script, and migration 007 adds and backfills it, so between the
 * two a row can exist with a null ordinal. A trail that reorders itself is worse
 * than one that is briefly numbered from its timestamp.
 */

/**
 * The requirements module: the request for information, the people who owe it,
 * the rounds they provide it in, and audit's decision on each round (Build
 * Prompt 58).
 *
 * `repos/requirements.ts` beside this one stays what it always was: the small
 * add/edit/remove panel on a work paper's detail. This module is the module,
 * and the two agree on one thing deliberately, the `work_paper_requirements`
 * row, so a requirement raised from either place is the same requirement.
 *
 * Scope, in every query without exception:
 *  - the acting organisation, on `work_paper_requirements.organization_id`;
 *  - and, for an owner, the `requirement_owners` rows naming them. An owner is
 *    frequently an auditee with no audit permissions at all, so their list is
 *    not a filtered view of everything: it is a different query that cannot
 *    return a requirement they do not own.
 *
 * The status is derived (workflow/requirementFlow.ts) and written back into the
 * `status` column so SQL filters and reports keep working, exactly as receipt
 * and status are kept in step in the older module.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import {
  REQUIREMENT_STATUS,
  REVIEW_STATUS,
  nextRound,
  requirementStatus,
  reviewStatusFor,
  type RequirementStatus,
  type ReviewDecision,
} from '@grc/workflow/requirementFlow';
import { RECIPIENT_ROLE, recipientStatement } from '@grc/repos/requirementRecipients';

const R = cols(C.work_paper_requirements);
const RO = cols(C.requirement_owners);
const RC = cols(C.requirement_recipients);
const RS = cols(C.requirement_submissions);
const WP = cols(C.work_papers);
const U = cols(C.users);

const s = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v));

/**
 * The finding a requirement belongs to, read once and read tolerantly
 * (Build Prompt 69).
 *
 * `linked_work_paper_id` is the link. `work_paper_id` is the column the module
 * used before the link could be deferred, and migration 010 backfills the new
 * from the old, so in a migrated database the COALESCE never reaches its second
 * arm. It is there because a requirement raised through the older panel on a
 * finding's own detail still writes only the old column, and a row that screen
 * created should not read as unlinked on this one.
 */
const LINKED = `COALESCE(NULLIF(TRIM(r.${R.linked_work_paper_id}), ''), NULLIF(TRIM(r.${R.work_paper_id}), ''))`;

/** One requirement as the lists show it: the ask, whose it is, and where it stands. */
export interface RequirementRow {
  id: string;
  /**
   * The finding this requirement has been linked to, or '' when it has not
   * been (Build Prompt 69). Unlinked is a resting state, not a gap: a
   * requirement may be answered, reviewed and closed without ever belonging to
   * a finding, and audit links it only once the uploaded information turns out
   * to be evidence for one.
   */
  workPaperId: string;
  workPaperRef: string;
  workPaperTitle: string;
  linkedAt: string | null;
  description: string;
  status: RequirementStatus;
  requestedDate: string | null;
  dueDate: string | null;
  closedAt: string | null;
  lastReviewedDate: string | null;
  /** The owners named on it, in the order they were added. */
  ownerNames: string[];
  ownerIds: string[];
  /**
   * Whether the person this list was read for owns it, and may therefore upload
   * against it. False for a copy recipient, who reads the same row and is
   * offered no control (Build Prompt 69).
   */
  canProvide: boolean;
  /** How many rounds have been provided. */
  rounds: number;
}

export interface RequirementFilters {
  workPaperId?: string;
  ownerId?: string;
  status?: string;
  /** true for linked only, false for the ones still waiting to be linked. */
  linkedOnly?: boolean;
}

/**
 * The list an auditor sees: every requirement in the organisation, filtered.
 *
 * The status filter is applied to the derived status rather than to the stored
 * column, so a row written before this module (carrying 'OPEN' or 'RECEIVED')
 * is filtered by what it actually is instead of by the text somebody typed into
 * it years ago.
 */
export async function listOrgRequirements(
  db: Client,
  organizationId: string,
  filters: RequirementFilters = {},
): Promise<RequirementRow[]> {
  const where = [`r.${R.organization_id} = ?`, `r.${R.deleted_at} IS NULL`];
  const args: (string | number)[] = [organizationId];
  if (filters.workPaperId) {
    where.push(`${LINKED} = ?`);
    args.push(filters.workPaperId);
  }
  if (filters.linkedOnly === false) where.push(`${LINKED} IS NULL`);
  if (filters.linkedOnly === true) where.push(`${LINKED} IS NOT NULL`);
  if (filters.ownerId) {
    where.push(
      `EXISTS (SELECT 1 FROM requirement_owners o
                WHERE o.${RO.requirement_id} = r.${R.requirement_id} AND o.${RO.user_id} = ?)`,
    );
    args.push(filters.ownerId);
  }
  const rows = await readRequirements(db, where, args);
  return filters.status ? rows.filter((row) => row.status === filters.status) : rows;
}

/**
 * The list an auditee sees: the requirements naming them, as an owner or as a
 * copy recipient, and nothing else.
 *
 * Written as its own query rather than as `listOrgRequirements` with a filter,
 * because the two answer different questions. This one cannot be made to return
 * somebody else's requirement by dropping a parameter.
 *
 * A copy recipient's rows come back marked `canProvide: false` (Build Prompt
 * 69), so the screen shows them the same table and no upload control. Being
 * copied is being told, not being asked, and the difference has to survive into
 * the row rather than being decided again by the page.
 */
export async function listOwnedRequirements(
  db: Client,
  organizationId: string,
  userId: string,
  filters: RequirementFilters = {},
): Promise<RequirementRow[]> {
  const where = [
    `r.${R.organization_id} = ?`,
    `r.${R.deleted_at} IS NULL`,
    `(EXISTS (SELECT 1 FROM requirement_owners o
               WHERE o.${RO.requirement_id} = r.${R.requirement_id} AND o.${RO.user_id} = ?)
      OR EXISTS (SELECT 1 FROM requirement_recipients rr
                  WHERE rr.${RC.requirement_id} = r.${R.requirement_id}
                    AND rr.${RC.user_id} = ?))`,
  ];
  const args: (string | number)[] = [organizationId, userId, userId];
  if (filters.workPaperId) {
    where.push(`${LINKED} = ?`);
    args.push(filters.workPaperId);
  }
  const rows = await readRequirements(db, where, args, userId);
  return filters.status ? rows.filter((row) => row.status === filters.status) : rows;
}

/**
 * The shared read behind both lists. The owners and the round count come back
 * with the row rather than in a query per requirement: a list of forty
 * requirements is one query, not eighty-one.
 */
async function readRequirements(
  db: Client,
  where: string[],
  args: (string | number)[],
  /** Set on the auditee's own list, to mark which rows they may upload against. */
  forUserId?: string,
): Promise<RequirementRow[]> {
  const res = await db.execute({
    sql: `SELECT r.${R.requirement_id} AS id, r.${R.work_paper_id} AS work_paper_id,
                 r.${R.description} AS description, r.${R.requested_date} AS requested_date,
                 r.${R.due_date} AS due_date, r.${R.received_date} AS received_date,
                 r.${R.closed_at} AS closed_at, r.${R.last_reviewed_date} AS last_reviewed_date,
                 ${LINKED} AS linked_work_paper_id, r.${R.linked_at} AS linked_at,
                 wp.${WP.work_paper_ref} AS work_paper_ref,
                 wp.${WP.observation_title} AS work_paper_title,
                 (SELECT COUNT(*) FROM requirement_submissions sub
                   WHERE sub.${RS.requirement_id} = r.${R.requirement_id}) AS rounds,
                 (SELECT sub.${RS.review_status} FROM requirement_submissions sub
                   WHERE sub.${RS.requirement_id} = r.${R.requirement_id}
                   ORDER BY COALESCE(sub.${RS.round_number}, 0) DESC,
                            sub.${RS.submitted_at} DESC LIMIT 1) AS latest_review,
                 (SELECT GROUP_CONCAT(u.${U.full_name}, ', ') FROM requirement_owners o
                    JOIN users u ON u.${U.user_id} = o.${RO.user_id}
                   WHERE o.${RO.requirement_id} = r.${R.requirement_id}) AS owner_names,
                 (SELECT GROUP_CONCAT(o.${RO.user_id}, ',') FROM requirement_owners o
                   WHERE o.${RO.requirement_id} = r.${R.requirement_id}) AS owner_ids,
                 (SELECT COUNT(*) FROM requirement_owners o
                   WHERE o.${RO.requirement_id} = r.${R.requirement_id}
                     AND o.${RO.user_id} = ?) AS mine
            FROM work_paper_requirements r
            LEFT JOIN work_papers wp ON wp.${WP.work_paper_id} = ${LINKED}
           WHERE ${where.join(' AND ')}
        ORDER BY r.${R.requested_date} DESC, r.${R.created_at} DESC`,
    // The marker parameter leads, because it sits in the SELECT list.
    args: [forUserId ?? '', ...args],
  });
  return res.rows.map((row) => {
    const rounds = Number(row.rounds ?? 0);
    return {
      id: String(row.id),
      workPaperId: String(row.linked_work_paper_id ?? ''),
      linkedAt: s(row.linked_at),
      workPaperRef: String(row.work_paper_ref ?? ''),
      workPaperTitle: String(row.work_paper_title ?? ''),
      description: String(row.description ?? ''),
      status: requirementStatus({
        closedAt: s(row.closed_at),
        receivedDate: s(row.received_date),
        latestReviewStatus: s(row.latest_review),
        hasSubmission: rounds > 0,
      }),
      requestedDate: s(row.requested_date),
      dueDate: s(row.due_date),
      closedAt: s(row.closed_at),
      lastReviewedDate: s(row.last_reviewed_date),
      ownerNames: splitList(s(row.owner_names), ', '),
      ownerIds: splitList(s(row.owner_ids), ','),
      canProvide: Number(row.mine ?? 0) > 0,
      rounds,
    };
  });
}

function splitList(value: string | null, separator: string): string[] {
  if (!value) return [];
  return value
    .split(separator)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** One requirement with everything its detail screen needs, or null. */
export async function getRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<RequirementRow | null> {
  const rows = await readRequirements(
    db,
    [`r.${R.organization_id} = ?`, `r.${R.requirement_id} = ?`, `r.${R.deleted_at} IS NULL`],
    [organizationId, requirementId],
  );
  return rows[0] ?? null;
}

/** Whether this user is named on the requirement. The owner portal's whole gate. */
export async function isRequirementOwner(
  db: Client,
  requirementId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM requirement_owners
           WHERE ${RO.requirement_id} = ? AND ${RO.user_id} = ? LIMIT 1`,
    args: [requirementId, userId],
  });
  return res.rows.length > 0;
}

/** The user ids named on a requirement, for notifying them. */
export async function requirementOwnerIds(db: Client, requirementId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT ${RO.user_id} AS user_id FROM requirement_owners
           WHERE ${RO.requirement_id} = ? ORDER BY ${RO.added_at}`,
    args: [requirementId],
  });
  return res.rows.map((r) => String(r.user_id));
}

export interface NewRequirement {
  /**
   * The finding, when audit already knows it. Null is the ordinary case
   * (Build Prompt 69): the request goes out, the information arrives, and only
   * then is it clear whether it is evidence for a finding and which one.
   */
  workPaperId: string | null;
  description: string;
  requestedDate: string | null;
  dueDate: string | null;
  ownerIds: string[];
  /** Copied in: they read it and are told about it, and upload nothing. */
  ccIds?: string[];
  requestedBy: string;
}

/**
 * Raise a requirement, with its owners and its copy list, and optionally
 * against a finding.
 *
 * The row, its owners and its recipients are written in one batch: a
 * requirement nobody owns is a request sent to nobody, and it must not be
 * possible to create one by failing halfway.
 *
 * A finding is verified to belong to the organisation before it is stamped, so
 * a posted id cannot attach a requirement to another tenant's work; a finding
 * that does not resolve is refused rather than quietly dropped, because
 * silently unlinking what the auditor asked to link would be worse than saying
 * no. No finding at all is not a failure and never was one to the business: it
 * is the normal way a request starts.
 */
export async function createRequirement(
  db: Client,
  organizationId: string,
  input: NewRequirement,
): Promise<string | null> {
  const workPaperId = (input.workPaperId ?? '').trim() || null;
  if (workPaperId !== null) {
    const owns = await db.execute({
      sql: `SELECT 1 FROM work_papers
             WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ? LIMIT 1`,
      args: [workPaperId, organizationId],
    });
    if (owns.rows.length === 0) return null;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // An ask with no date given was made today: that is what happened, and it is
  // more useful than a blank that makes the row look ageless.
  const requested = input.requestedDate ?? now.slice(0, 10);
  const owners = [...new Set(input.ownerIds.map((v) => v.trim()).filter(Boolean))];
  // Somebody named as both is an owner: the stronger standing wins, and being
  // told twice about your own request is not a feature.
  const copies = [...new Set((input.ccIds ?? []).map((v) => v.trim()).filter(Boolean))].filter(
    (u) => !owners.includes(u),
  );

  const statements: InStatement[] = [
    {
      // `work_paper_id` is written in step with the link rather than left
      // behind: two columns that can disagree about whether a requirement
      // belongs to a finding is a question with two answers.
      sql: `INSERT INTO work_paper_requirements
              (${R.requirement_id}, ${R.organization_id}, ${R.work_paper_id},
               ${R.linked_work_paper_id}, ${R.linked_at}, ${R.linked_by}, ${R.description},
               ${R.status}, ${R.requested_date}, ${R.due_date}, ${R.created_at}, ${R.updated_at})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        organizationId,
        workPaperId,
        workPaperId,
        workPaperId ? now : null,
        workPaperId ? input.requestedBy : null,
        input.description,
        REQUIREMENT_STATUS.OUTSTANDING,
        requested,
        input.dueDate,
        now,
        now,
      ],
    },
    ...owners.map((userId) => ownerStatement(id, userId, input.requestedBy, now)),
    ...owners.map((userId) =>
      recipientStatement(id, userId, RECIPIENT_ROLE.OWNER, input.requestedBy, now),
    ),
    ...copies.map((userId) =>
      recipientStatement(id, userId, RECIPIENT_ROLE.CC, input.requestedBy, now),
    ),
  ];
  await db.batch(statements, 'write');
  return id;
}

/**
 * Link a requirement to the finding its information turned out to support, or
 * unlink it by passing null (Build Prompt 69).
 *
 * This is audit's act and audit's alone, and it is a different decision from
 * whether the requirement is complete: information can be everything that was
 * asked for and still belong to no finding, and it can be linked to one while
 * audit is still waiting for more of it. Keeping them separate is what lets an
 * auditor defer the link until the evidence exists, which is the whole point.
 *
 * Returns false when the finding does not belong to the acting organisation or
 * the requirement does not, so a posted id cannot reach across tenants.
 */
export async function linkRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
  workPaperId: string | null,
  linkedBy: string,
): Promise<boolean> {
  const target = (workPaperId ?? '').trim() || null;
  if (target !== null) {
    const owns = await db.execute({
      sql: `SELECT 1 FROM work_papers
             WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ? LIMIT 1`,
      args: [target, organizationId],
    });
    if (owns.rows.length === 0) return false;
  }
  const now = new Date().toISOString();
  const res = await db.execute({
    sql: `UPDATE work_paper_requirements
             SET ${R.linked_work_paper_id} = ?, ${R.work_paper_id} = ?,
                 ${R.linked_at} = ?, ${R.linked_by} = ?, ${R.updated_at} = ?
           WHERE ${R.requirement_id} = ? AND ${R.organization_id} = ?
             AND ${R.deleted_at} IS NULL`,
    args: [
      target,
      target,
      target ? now : null,
      target ? linkedBy : null,
      now,
      requirementId,
      organizationId,
    ],
  });
  return (res.rowsAffected ?? 0) > 0;
}

function ownerStatement(
  requirementId: string,
  userId: string,
  addedBy: string,
  now: string,
): InStatement {
  return {
    sql: `INSERT INTO requirement_owners
            (${RO.requirement_id}, ${RO.user_id}, ${RO.added_at}, ${RO.added_by})
          VALUES (?, ?, ?, ?)`,
    args: [requirementId, userId, now, addedBy],
  };
}

/** One round: what the owner provided, and what audit said to it. */
export interface RequirementRound {
  submissionId: string;
  roundNumber: number;
  submittedById: string | null;
  submittedByName: string;
  note: string;
  fileId: string | null;
  fileName: string | null;
  attachmentId: string | null;
  submittedAt: string | null;
  reviewStatus: string | null;
  reviewComment: string | null;
  additionalInfoRequest: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

/**
 * The ordered trail for a requirement, oldest round first.
 *
 * The file is joined in by name rather than left as an id: a trail that says
 * "file 9f2c-..." is not a trail anybody can read, and the attachment id is what
 * the download route needs.
 */
export async function listRounds(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<RequirementRound[]> {
  const F = cols(C.files);
  const FA = cols(C.file_attachments);
  const res = await db.execute({
    sql: `SELECT sub.${RS.submission_id} AS submission_id, sub.${RS.round_number} AS round_number,
                 sub.${RS.submitted_by} AS submitted_by, sub.${RS.submitted_by_name} AS submitted_by_name,
                 sub.${RS.submission_note} AS note, sub.${RS.file_id} AS file_id,
                 sub.${RS.submitted_at} AS submitted_at, sub.${RS.review_status} AS review_status,
                 sub.${RS.review_comment} AS review_comment,
                 sub.${RS.additional_info_request} AS additional_info_request,
                 sub.${RS.reviewed_by_name} AS reviewed_by_name, sub.${RS.reviewed_at} AS reviewed_at,
                 f.${F.file_name} AS file_name, fa.${FA.attachment_id} AS attachment_id
            FROM requirement_submissions sub
            LEFT JOIN files f
              ON f.${F.file_id} = sub.${RS.file_id} AND f.${F.deleted_at} IS NULL
            LEFT JOIN file_attachments fa ON fa.${FA.file_id} = f.${F.file_id}
           WHERE sub.${RS.requirement_id} = ? AND sub.${RS.organization_id} = ?
        ORDER BY COALESCE(sub.${RS.round_number}, 0), sub.${RS.submitted_at}`,
    args: [requirementId, organizationId],
  });
  return res.rows.map((r) => ({
    submissionId: String(r.submission_id),
    roundNumber: Number(r.round_number ?? 0),
    submittedById: s(r.submitted_by),
    submittedByName: String(r.submitted_by_name ?? ''),
    note: String(r.note ?? ''),
    fileId: s(r.file_id),
    fileName: s(r.file_name),
    attachmentId: s(r.attachment_id),
    submittedAt: s(r.submitted_at),
    reviewStatus: s(r.review_status),
    reviewComment: s(r.review_comment),
    additionalInfoRequest: s(r.additional_info_request),
    reviewedByName: s(r.reviewed_by_name),
    reviewedAt: s(r.reviewed_at),
  }));
}

export interface SubmissionInput {
  note: string;
  /** The evidence file already stored through the organisation's connector. */
  fileId: string | null;
  submittedBy: string;
  submittedByName: string;
}

/**
 * Record a round from an owner, and move the requirement to awaiting review.
 *
 * The round number is the count so far plus one rather than a client-supplied
 * value: rounds are the audit trail's spine, and a caller cannot be allowed to
 * renumber them. The status moves in the same batch as the round is written, so
 * a requirement can never sit "outstanding" with an answer already in it. The
 * receipt date is stamped on the first round, which is when the information
 * actually arrived, keeping the older panel's Received label honest.
 */
export async function addSubmission(
  db: Client,
  organizationId: string,
  requirementId: string,
  input: SubmissionInput,
): Promise<number> {
  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM requirement_submissions
           WHERE ${RS.requirement_id} = ? AND ${RS.organization_id} = ?`,
    args: [requirementId, organizationId],
  });
  const round = nextRound(Number(counted.rows[0]?.n ?? 0));
  const now = new Date().toISOString();

  await db.batch(
    [
      {
        sql: `INSERT INTO requirement_submissions
                (${RS.submission_id}, ${RS.requirement_id}, ${RS.organization_id},
                 ${RS.round_number}, ${RS.submitted_by}, ${RS.submitted_by_name},
                 ${RS.submission_note}, ${RS.file_id}, ${RS.submitted_at}, ${RS.review_status})
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          requirementId,
          organizationId,
          round,
          input.submittedBy,
          input.submittedByName,
          input.note,
          input.fileId,
          now,
          REVIEW_STATUS.PENDING,
        ],
      },
      {
        sql: `UPDATE work_paper_requirements
                 SET ${R.status} = ?, ${R.received_date} = COALESCE(${R.received_date}, ?),
                     ${R.updated_at} = ?
               WHERE ${R.requirement_id} = ? AND ${R.organization_id} = ?`,
        args: [
          REQUIREMENT_STATUS.AWAITING_REVIEW,
          now.slice(0, 10),
          now,
          requirementId,
          organizationId,
        ],
      },
    ],
    'write',
  );
  return round;
}

export interface ReviewInput {
  decision: ReviewDecision;
  comment: string | null;
  /** What else is wanted, when the decision sends it back. */
  additionalInfoRequest: string | null;
  reviewedBy: string;
  reviewedByName: string;
}

/**
 * Record audit's decision on the latest round.
 *
 * Accepting closes the requirement: `closed_at` and `closed_by` say who ended
 * the ask and when, and `last_reviewed_date` is stamped either way, because a
 * requirement that has been looked at and sent back has still been looked at,
 * and "when did audit last read this?" is the question an owner waiting three
 * weeks is entitled to an answer to.
 *
 * Returns false when there is no round to decide on, so a review posted against
 * a requirement nobody has answered refuses rather than closing an empty ask.
 */
export async function reviewLatestRound(
  db: Client,
  organizationId: string,
  requirementId: string,
  input: ReviewInput,
): Promise<boolean> {
  const latest = await db.execute({
    sql: `SELECT ${RS.submission_id} AS id FROM requirement_submissions
           WHERE ${RS.requirement_id} = ? AND ${RS.organization_id} = ?
        ORDER BY COALESCE(${RS.round_number}, 0) DESC, ${RS.submitted_at} DESC LIMIT 1`,
    args: [requirementId, organizationId],
  });
  const submissionId = s(latest.rows[0]?.id);
  if (!submissionId) return false;

  const now = new Date().toISOString();
  const accepted = input.decision === 'accept';
  const statements: InStatement[] = [
    {
      sql: `UPDATE requirement_submissions
               SET ${RS.review_status} = ?, ${RS.review_comment} = ?,
                   ${RS.additional_info_request} = ?, ${RS.reviewed_by} = ?,
                   ${RS.reviewed_by_name} = ?, ${RS.reviewed_at} = ?
             WHERE ${RS.submission_id} = ? AND ${RS.organization_id} = ?`,
      args: [
        reviewStatusFor(input.decision),
        input.comment,
        accepted ? null : input.additionalInfoRequest,
        input.reviewedBy,
        input.reviewedByName,
        now,
        submissionId,
        organizationId,
      ],
    },
    {
      sql: `UPDATE work_paper_requirements
               SET ${R.status} = ?, ${R.last_reviewed_date} = ?, ${R.closed_at} = ?,
                   ${R.closed_by} = ?, ${R.updated_at} = ?
             WHERE ${R.requirement_id} = ? AND ${R.organization_id} = ?`,
      args: [
        accepted ? REQUIREMENT_STATUS.CLOSED : REQUIREMENT_STATUS.MORE_INFO,
        now.slice(0, 10),
        accepted ? now : null,
        accepted ? input.reviewedBy : null,
        now,
        requirementId,
        organizationId,
      ],
    },
  ];
  await db.batch(statements, 'write');
  return true;
}
