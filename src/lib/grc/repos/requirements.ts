/**
 * Work-paper requirements: the information an auditor has asked the auditee for
 * on a finding (work_paper_requirements). Add, edit, mark received and remove,
 * all scoped to the acting organisation and gated by the caller on
 * REQUIREMENTS.manage.
 *
 * A requirement carries three facts (Build Prompt 52): what was asked for, when
 * it was asked for, and when it arrived. `received_date` is the record of
 * receipt and `status` is the label on it, so the two can never disagree: the
 * status is derived here from the date rather than being typed in beside it.
 * That is what makes "what is still outstanding?" answerable from the data
 * instead of from whoever last edited a free-text field.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const R = cols(C.work_paper_requirements);

/** The stored status codes. Derived from receipt, never typed in beside it. */
export const REQUIREMENT_RECEIVED = 'RECEIVED';
export const REQUIREMENT_OUTSTANDING = 'OUTSTANDING';

export interface Requirement {
  id: string;
  workPaperId: string;
  description: string;
  status: string;
  /** When the information was asked for, as YYYY-MM-DD, or null if unrecorded. */
  requestedDate: string | null;
  /** When it arrived. Null is the whole definition of outstanding. */
  receivedDate: string | null;
  createdAt: string | null;
}

/**
 * The status a row should carry, given whether it has been received. Older rows
 * were saved with free text ('OPEN', 'PENDING') and are left readable: the
 * screen labels them from the date, so nothing has to be back-filled for the
 * list to read correctly.
 */
export function statusForReceipt(receivedDate: string | null): string {
  return receivedDate ? REQUIREMENT_RECEIVED : REQUIREMENT_OUTSTANDING;
}

/** Whether a stored row counts as received, by the date and not by the label. */
export function isReceived(requirement: Requirement): boolean {
  return requirement.receivedDate !== null;
}

/** The label the screens show: one word, and always true of the stored dates. */
export function receiptLabel(requirement: Requirement): string {
  return isReceived(requirement) ? 'Received' : 'Outstanding';
}

/** A date input's value, normalised to YYYY-MM-DD or null when left blank. */
export function readDate(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

const s = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v));

export async function listRequirements(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Requirement[]> {
  const res = await db.execute({
    sql: `SELECT ${R.requirement_id} AS id, ${R.work_paper_id} AS work_paper_id,
                 ${R.description} AS description, ${R.status} AS status,
                 ${R.requested_date} AS requested_date, ${R.received_date} AS received_date,
                 ${R.created_at} AS created_at
            FROM work_paper_requirements
           WHERE ${R.organization_id} = ? AND ${R.work_paper_id} = ?
        ORDER BY ${R.created_at}`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    workPaperId: String(r.work_paper_id),
    description: String(r.description ?? ''),
    status: String(r.status ?? ''),
    requestedDate: s(r.requested_date),
    receivedDate: s(r.received_date),
    createdAt: s(r.created_at),
  }));
}

export interface RequirementInput {
  description: string;
  requestedDate: string | null;
  receivedDate: string | null;
}

export async function addRequirement(
  db: Client,
  organizationId: string,
  workPaperId: string,
  input: RequirementInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // A request with no date given was made today: that is what happened, and it
  // is more useful than a blank that makes the row look ageless.
  const requested = input.requestedDate ?? now.slice(0, 10);
  await db.execute({
    sql: `INSERT INTO work_paper_requirements
            (${R.requirement_id}, ${R.organization_id}, ${R.work_paper_id}, ${R.description},
             ${R.status}, ${R.requested_date}, ${R.received_date}, ${R.created_at}, ${R.updated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      organizationId,
      workPaperId,
      input.description,
      statusForReceipt(input.receivedDate),
      requested,
      input.receivedDate,
      now,
      now,
    ],
  });
  return id;
}

export async function updateRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
  input: RequirementInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE work_paper_requirements
              SET ${R.description} = ?, ${R.status} = ?, ${R.requested_date} = ?,
                  ${R.received_date} = ?, ${R.updated_at} = ?
            WHERE ${R.requirement_id} = ? AND ${R.organization_id} = ?`,
    args: [
      input.description,
      statusForReceipt(input.receivedDate),
      input.requestedDate,
      input.receivedDate,
      new Date().toISOString(),
      requirementId,
      organizationId,
    ],
  });
}

export async function removeRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_requirements
           WHERE ${R.requirement_id} = ? AND ${R.organization_id} = ?`,
    args: [requirementId, organizationId],
  });
}
