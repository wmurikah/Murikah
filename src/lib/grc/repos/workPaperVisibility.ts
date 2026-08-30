/**
 * Row-level visibility for the work-paper list, mirroring the action-plan
 * viewer model (actionPlans.ts). The matrix grant (WORK_PAPER read) opens the
 * door; this decides which rows a viewer sees once inside, as defence in depth
 * independent of how the live role_permissions are configured:
 *
 *  - an auditor-side viewer (anyone the matrix lets author, review, approve or
 *    send a finding) sees the whole organisation;
 *  - everyone else (the auditee side: unit managers, junior staff, board roles
 *    holding only read) sees only findings they are assigned to or named
 *    responsible for;
 *  - a Draft finding is the author's workbench: hidden from everyone except
 *    the creator, the preparer and the assigned auditor. A platform owner sees
 *    everything.
 *
 * Affiliate confinement (Build Prompt 45) sits on top of all of this and never
 * under it: it only ever removes rows the rules above would have shown, so a
 * confined auditor still sees the whole organisation's findings minus those
 * outside their affiliate, and a confined auditee still sees only their own.
 *
 * Import-free but for the scope type, so node strips types and unit-tests this
 * directly.
 */
import type { AffiliateScope } from '@grc/auth/affiliateScope';

/** The viewer, as the middleware attaches it to locals.grc. */
export interface WorkPaperViewer {
  userId: string;
  roleCode: string;
  perms: string[];
  isPlatformOwner: boolean;
  /** The affiliate confinement in force, from locals.grc.affiliateScope. */
  affiliateScope: AffiliateScope;
}

/** The legacy codes that mark the auditor side of the house. */
const AUDITOR_SIDE_PERMS = [
  'WORK_PAPERS.create',
  'WORK_PAPERS.edit',
  'WORK_PAPERS.review',
  'WORK_PAPERS.approve',
  'WORK_PAPERS.send',
];

/** Whether the viewer works findings (and so sees the whole organisation). */
export function isWorkPaperAuditor(v: WorkPaperViewer): boolean {
  return v.isPlatformOwner || AUDITOR_SIDE_PERMS.some((p) => v.perms.includes(p));
}

/** Whether the viewer's list must be restricted to assigned or responsible rows. */
export function restrictToOwnFindings(v: WorkPaperViewer): boolean {
  return !isWorkPaperAuditor(v);
}

/** Whether Draft rows may appear for authors other than the viewer. */
export function seesForeignDrafts(v: WorkPaperViewer): boolean {
  return v.isPlatformOwner;
}
