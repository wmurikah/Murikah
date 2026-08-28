/**
 * Completed approval work, for the tests AND for the screenshots.
 *
 * The base seed has almost none: one finished finance approval and two things
 * still open, which is honest about a fresh install and useless as a picture of
 * a working dashboard. This adds the completed work the SLA section is built to
 * report, in one place, so a figure asserted in a test and a figure visible in a
 * screenshot are the same figure.
 *
 * USR-GAB approves at TWO functions on purpose: finance approval on sales
 * orders (fast) and the purchase order finance level (slow). Blending them
 * would produce a median that matches neither, which is what the test looks
 * for.
 */
import type { TestClient } from './db.ts';

export async function withApprovalWork(c: TestClient): Promise<void> {
  // Sales order finance approvals: USR-GAB at 30 minutes each, three of them.
  await c.execute(`INSERT INTO workflow_instances VALUES
    ('WFI-T1','WFD-001','SALES_ORDER','SO-003','COMPLETED','2026-08-25 09:00:00','2026-08-25 10:30:00','WST-003',CURRENT_TIMESTAMP),
    ('WFI-T2','WFD-001','SALES_ORDER','SO-004','IN_PROGRESS','2026-08-26 08:00:00',NULL,'WST-001',CURRENT_TIMESTAMP),
    ('WFI-T3','WFD-001','SALES_ORDER','SO-005','IN_PROGRESS','2026-08-26 08:20:00',NULL,'WST-002',CURRENT_TIMESTAMP),
    ('WFI-T4','WFD-002','PURCHASE_ORDER','PO-001','COMPLETED','2026-08-24 07:40:00','2026-08-24 12:00:00','WST-006',CURRENT_TIMESTAMP),
    ('WFI-T5','WFD-002','PURCHASE_ORDER','PO-004','COMPLETED','2026-08-25 09:10:00','2026-08-25 13:00:00','WST-006',CURRENT_TIMESTAMP)`);

  // A purchase order's first stage is measured from submission, so the two
  // orders that complete one need a submission timestamp.
  await c.execute(
    `UPDATE purchase_orders SET submitted_for_approval_at = '2026-08-24 07:40:00' WHERE purchase_order_id = 'PO-001'`,
  );
  await c.execute(
    `UPDATE purchase_orders SET submitted_for_approval_at = '2026-08-25 09:10:00' WHERE purchase_order_id = 'PO-004'`,
  );

  await c.execute(`INSERT INTO workflow_stage_instances VALUES
    ('WSI-T1','WFI-T1','WST-001','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-25 09:00:00','2026-08-25 09:00:00','2026-08-25 09:30:00','Approved'),
    ('WSI-T2','WFI-T1','WST-002','USR-VIC','TEAM-CRD-GRP','APPROVED','2026-08-25 09:30:00','2026-08-25 09:30:00','2026-08-25 10:10:00','Released'),
    ('WSI-T3','WFI-T2','WST-001','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-26 08:00:00','2026-08-26 08:00:00','2026-08-26 08:30:00','Approved'),
    ('WSI-T4','WFI-T3','WST-001','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-26 08:20:00','2026-08-26 08:20:00','2026-08-26 08:50:00','Approved'),
    ('WSI-T5','WFI-T3','WST-002','USR-VIC','TEAM-CRD-GRP','ACTIVE','2026-08-26 08:50:00','2026-08-26 08:50:00',NULL,'Under review'),
    ('WSI-T6','WFI-T4','WST-004','USR-ZUL','TEAM-FIN-KE','APPROVED','2026-08-24 07:40:00','2026-08-24 07:40:00','2026-08-24 09:40:00','Cost reviewed'),
    ('WSI-T7','WFI-T4','WST-005','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-24 09:40:00','2026-08-24 09:40:00','2026-08-24 12:00:00','Approved'),
    ('WSI-T8','WFI-T5','WST-004','USR-ZUL','TEAM-FIN-KE','APPROVED','2026-08-25 09:10:00','2026-08-25 09:10:00','2026-08-25 10:10:00','Cost reviewed'),
    ('WSI-T9','WFI-T5','WST-005','USR-GAB','TEAM-FIN-KE','APPROVED','2026-08-25 10:10:00','2026-08-25 10:10:00','2026-08-25 13:00:00','Approved')`);
}

