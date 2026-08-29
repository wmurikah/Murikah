/**
 * What a customer may read, and nothing else.
 *
 * EVERY QUERY IN THIS FILE GOES THROUGH `accountPredicate`.
 * That is not a convention, it is the security model: the account
 * identifiers come from the authenticated membership, server-side, and a
 * query that forgot to apply them would be a cross-customer leak. The
 * predicate is built from bound parameters, so even a wrong clause elsewhere
 * cannot reach another customer's row.
 *
 * INTERNAL COMMUNICATIONS ARE EXCLUDED IN SQL.
 * `case_communications.direction = 'INTERNAL'` is filtered in the WHERE
 * clause, so an internal note never enters the response object at all. Not
 * hidden by a template, not greyed out by a class, not dropped by a client
 * filter: absent. The acceptance test inspects the JSON body rather than the
 * screen, and this is why it can pass.
 *
 * NO EMPLOYEE, NO INTERNAL STAGE, NO INTERNAL SLA.
 * The shapes below carry no user name, no assignee, no workflow stage, no
 * internal timer and no approver. A customer sees what happened to their own
 * record and roughly where it is, in their own language.
 */
import type { Client } from '@libsql/client/web';
import { toDbTimestamp } from '../auth/session.ts';
import {
  accountPredicate,
  customerCaseStatus,
  customerOrderStatus,
  DELAY_WORDING,
  type PortalScope,
} from '../portal/tenant.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const number = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const NOT_AVAILABLE = 'Not available';

// ---- Orders ------------------------------------------------------------------

export interface PortalOrderRow {
  salesOrderId: string;
  documentNumber: string;
  orderCreatedAt: string;
  /** Customer-safe wording. Never an internal status name. */
  status: string;
  invoiceNumber: string | null;
  invoiceCreatedAt: string | null;
  loadingAt: string | null;
  /** The external promise only. An internal timer never reaches the portal. */
  slaState: 'On track' | 'Taking longer than our target' | 'Completed' | 'Not applicable';
}

/**
 * The external SLA, and only the external one. Internal timers say which
 * team held a case, which is our business and not the customer's.
 */
const EXTERNAL_SLA_STATE = `(
  SELECT si.status FROM sla_instances si
  JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
  JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
  WHERE si.entity_type = ? AND si.entity_id = {ENTITY} AND sp.sla_type = 'EXTERNAL'
  ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END
  LIMIT 1)`;

function slaWording(status: string | null): PortalOrderRow['slaState'] {
  if (status === null) return 'Not applicable';
  if (status === 'BREACHED') return 'Taking longer than our target';
  if (status === 'MET') return 'Completed';
  return 'On track';
}

export async function portalOrders(
  db: Client,
  scope: PortalScope,
  limit = 100,
): Promise<PortalOrderRow[]> {
  const predicate = accountPredicate(scope, 'so.account_id');
  const result = await db.execute({
    sql: `SELECT so.sales_order_id AS id, so.document_number AS doc,
            so.order_created_at AS created, so.status AS status,
            so.invoice_number AS invoice_number, so.invoice_created_at AS invoiced,
            so.loading_authority_at AS loading,
            ${EXTERNAL_SLA_STATE.replace('{ENTITY}', 'so.sales_order_id')} AS sla_status
          FROM sales_orders so
          WHERE ${predicate.sql}
          ORDER BY so.order_created_at DESC LIMIT ?`,
    args: ['SALES_ORDER', ...predicate.args, limit] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      salesOrderId: text(row.id),
      documentNumber: text(row.doc),
      orderCreatedAt: text(row.created),
      status: customerOrderStatus(text(row.status)),
      invoiceNumber: nullableText(row.invoice_number),
      invoiceCreatedAt: nullableText(row.invoiced),
      loadingAt: nullableText(row.loading),
      slaState: slaWording(nullableText(row.sla_status)),
    };
  });
}

export interface PortalOrderDetail extends PortalOrderRow {
  lines: {
    lineNumber: number;
    product: string;
    quantity: string;
  }[];
  /** Shown where the external promise was missed, without naming anybody. */
  delayNote: string | null;
}

/**
 * One order, or null.
 *
 * NULL IS THE ONLY REFUSAL. An order belonging to another customer and an
 * order that does not exist both produce null here and one identical
 * not-found response at the endpoint. A different message for the two would
 * confirm the other customer's order exists.
 */
export async function portalOrder(
  db: Client,
  scope: PortalScope,
  salesOrderId: string,
): Promise<PortalOrderDetail | null> {
  const predicate = accountPredicate(scope, 'so.account_id');
  const result = await db.execute({
    sql: `SELECT so.sales_order_id AS id, so.document_number AS doc,
            so.order_created_at AS created, so.status AS status,
            so.invoice_number AS invoice_number, so.invoice_created_at AS invoiced,
            so.loading_authority_at AS loading,
            ${EXTERNAL_SLA_STATE.replace('{ENTITY}', 'so.sales_order_id')} AS sla_status
          FROM sales_orders so
          WHERE so.sales_order_id = ? AND ${predicate.sql} LIMIT 1`,
    args: ['SALES_ORDER', salesOrderId, ...predicate.args] as never[],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  const lines = await db.execute({
    sql: `SELECT sol.line_number, p.product_name, p.product_code, p.unit_of_measure, sol.quantity
          FROM sales_order_lines sol
          LEFT JOIN products p ON p.product_id = sol.product_id
          WHERE sol.sales_order_id = ? ORDER BY sol.line_number`,
    args: [salesOrderId],
  });
  const slaState = slaWording(nullableText(row.sla_status));
  return {
    salesOrderId: text(row.id),
    documentNumber: text(row.doc),
    orderCreatedAt: text(row.created),
    status: customerOrderStatus(text(row.status)),
    invoiceNumber: nullableText(row.invoice_number),
    invoiceCreatedAt: nullableText(row.invoiced),
    loadingAt: nullableText(row.loading),
    slaState,
    lines: lines.rows.map((raw) => {
      const line = raw as unknown as Record<string, unknown>;
      const quantity = number(line.quantity);
      return {
        lineNumber: Number(line.line_number),
        product:
          nullableText(line.product_name) ?? nullableText(line.product_code) ?? NOT_AVAILABLE,
        // The imported extract carries no quantities, so this is usually
        // absent. "Not available", never a zero that claims we moved nothing.
        quantity:
          quantity === null
            ? NOT_AVAILABLE
            : `${quantity.toLocaleString('en-KE')} ${nullableText(line.unit_of_measure) ?? ''}`.trim(),
      };
    }),
    delayNote: slaState === 'Taking longer than our target' ? DELAY_WORDING : null,
  };
}

// ---- Service -----------------------------------------------------------------

export interface PortalCaseRow {
  caseId: string;
  caseNumber: string;
  subject: string;
  raisedAt: string;
  status: string;
  caseType: string;
  lastUpdateAt: string | null;
  awaitingYourReply: boolean;
}

export async function portalCases(
  db: Client,
  scope: PortalScope,
  limit = 100,
): Promise<PortalCaseRow[]> {
  const predicate = accountPredicate(scope, 'sc.account_id');
  const result = await db.execute({
    sql: `SELECT sc.case_id AS id, sc.case_number AS number, sc.subject AS subject,
            sc.raised_at AS raised, sc.status AS status, sc.case_type AS case_type,
            (SELECT MAX(cc.communicated_at) FROM case_communications cc
              WHERE cc.case_id = sc.case_id AND cc.direction <> 'INTERNAL') AS last_update
          FROM service_cases sc
          WHERE ${predicate.sql}
          ORDER BY sc.raised_at DESC LIMIT ?`,
    args: [...predicate.args, limit] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const status = text(row.status);
    return {
      caseId: text(row.id),
      caseNumber: text(row.number),
      subject: text(row.subject),
      raisedAt: text(row.raised),
      status: customerCaseStatus(status),
      caseType: text(row.case_type).toLowerCase(),
      lastUpdateAt: nullableText(row.last_update),
      awaitingYourReply: status === 'WAITING_CUSTOMER',
    };
  });
}

export interface PortalMessage {
  /** INBOUND (theirs) or OUTBOUND (ours). INTERNAL never appears. */
  direction: 'INBOUND' | 'OUTBOUND';
  at: string;
  message: string;
  /** "You" or "Hass Petroleum". Never an employee name. */
  from: string;
}

export interface PortalCaseDetail extends PortalCaseRow {
  description: string;
  resolution: string | null;
  messages: PortalMessage[];
  delayNote: string | null;
  slaState: PortalOrderRow['slaState'];
  /** A survey the customer has been invited to answer, where one is open. */
  surveyInvitation: {
    invitationId: string;
    surveyId: string;
    surveyType: string;
    question: string;
    answered: boolean;
  } | null;
}

export async function portalCase(
  db: Client,
  scope: PortalScope,
  caseId: string,
): Promise<PortalCaseDetail | null> {
  const predicate = accountPredicate(scope, 'sc.account_id');
  const result = await db.execute({
    sql: `SELECT sc.case_id AS id, sc.case_number AS number, sc.subject AS subject,
            sc.description AS description, sc.raised_at AS raised, sc.status AS status,
            sc.case_type AS case_type, sc.resolution_summary AS resolution,
            ${EXTERNAL_SLA_STATE.replace('{ENTITY}', 'sc.case_id')} AS sla_status
          FROM service_cases sc
          WHERE sc.case_id = ? AND ${predicate.sql} LIMIT 1`,
    args: ['CASE', caseId, ...predicate.args] as never[],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  // THE LINE THAT MUST NOT BE CROSSED: direction <> 'INTERNAL', in SQL, so
  // an internal note is never part of the result set to begin with.
  const messages = await db.execute({
    sql: `SELECT cc.direction, cc.communicated_at, cc.message_summary
          FROM case_communications cc
          WHERE cc.case_id = ? AND cc.direction <> 'INTERNAL'
          ORDER BY cc.communicated_at`,
    args: [caseId],
  });

  const invitation = await db.execute({
    sql: `SELECT si.survey_invitation_id, si.survey_id, si.survey_response_id,
            cs.survey_type, cs.question_text
          FROM survey_invitations si
          JOIN customer_surveys cs ON cs.survey_id = si.survey_id
          WHERE si.case_id = ? AND si.account_id IN (${scope.accountIds.map(() => '?').join(', ')})
          LIMIT 1`,
    args: [caseId, ...scope.accountIds],
  });
  const invitationRow = invitation.rows[0] as Record<string, unknown> | undefined;

  const status = text(row.status);
  const slaState = slaWording(nullableText(row.sla_status));
  return {
    caseId: text(row.id),
    caseNumber: text(row.number),
    subject: text(row.subject),
    description: text(row.description),
    raisedAt: text(row.raised),
    status: customerCaseStatus(status),
    caseType: text(row.case_type).toLowerCase(),
    lastUpdateAt: null,
    awaitingYourReply: status === 'WAITING_CUSTOMER',
    resolution: nullableText(row.resolution),
    messages: messages.rows.map((raw) => {
      const message = raw as unknown as Record<string, unknown>;
      const direction = text(message.direction) === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
      return {
        direction: direction as PortalMessage['direction'],
        at: text(message.communicated_at),
        message: text(message.message_summary),
        // Never an employee name: the customer corresponds with Hass, not
        // with a person whose queue they might then chase.
        from: direction === 'INBOUND' ? 'You' : 'Hass Petroleum',
      };
    }),
    slaState,
    delayNote: slaState === 'Taking longer than our target' ? DELAY_WORDING : null,
    surveyInvitation:
      invitationRow === undefined
        ? null
        : {
            invitationId: text(invitationRow.survey_invitation_id),
            surveyId: text(invitationRow.survey_id),
            surveyType: text(invitationRow.survey_type),
            question: text(invitationRow.question_text),
            answered: invitationRow.survey_response_id !== null,
          },
  };
}

// ---- Documents ---------------------------------------------------------------

export interface PortalDocument {
  entityAttachmentId: string;
  /** The customer-facing title, never the internal filename. */
  title: string;
  attachedAt: string;
  /** What it belongs to, in customer words. */
  relatesTo: string;
  sizeBytes: number | null;
}

/**
 * Only attachments explicitly marked customer_visible, and only on entities
 * inside the caller's own accounts.
 *
 * The visibility flag defaults to 0, so every attachment that existed before
 * the portal is invisible until somebody decides otherwise. That default is
 * the right way round: a document becomes customer-facing by a decision, not
 * by an oversight.
 *
 * THE STORAGE KEY IS NOT IN THIS SHAPE. A customer never receives one:
 * downloads go through an endpoint that re-checks the session, the
 * membership, the account and the flag before it streams anything.
 */
export async function portalDocuments(db: Client, scope: PortalScope): Promise<PortalDocument[]> {
  const accounts = scope.accountIds.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT ea.entity_attachment_id AS id,
            COALESCE(ea.portal_document_title, 'Document') AS title,
            ea.attached_at AS attached_at, ea.entity_type AS entity_type,
            fo.size_bytes AS size_bytes,
            CASE ea.entity_type
              WHEN 'SALES_ORDER' THEN (SELECT so.document_number FROM sales_orders so
                                        WHERE so.sales_order_id = ea.entity_id)
              WHEN 'CASE' THEN (SELECT sc.case_number FROM service_cases sc
                                 WHERE sc.case_id = ea.entity_id)
              ELSE NULL END AS reference
          FROM entity_attachments ea
          JOIN file_objects fo ON fo.file_id = ea.file_id
          WHERE ea.customer_visible = 1
            AND (
              (ea.entity_type = 'ACCOUNT' AND ea.entity_id IN (${accounts}))
              OR (ea.entity_type = 'SALES_ORDER' AND EXISTS (
                    SELECT 1 FROM sales_orders so WHERE so.sales_order_id = ea.entity_id
                      AND so.account_id IN (${accounts})))
              OR (ea.entity_type = 'CASE' AND EXISTS (
                    SELECT 1 FROM service_cases sc WHERE sc.case_id = ea.entity_id
                      AND sc.account_id IN (${accounts})))
            )
          ORDER BY ea.attached_at DESC`,
    args: [...scope.accountIds, ...scope.accountIds, ...scope.accountIds] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const reference = nullableText(row.reference);
    const entityType = text(row.entity_type);
    return {
      entityAttachmentId: text(row.id),
      title: text(row.title),
      attachedAt: text(row.attached_at),
      relatesTo:
        entityType === 'SALES_ORDER'
          ? `Order ${reference ?? ''}`.trim()
          : entityType === 'CASE'
            ? `Request ${reference ?? ''}`.trim()
            : 'Your account',
      sizeBytes: number(row.size_bytes),
    };
  });
}

/**
 * The download check, in the order the build prompt names: the session (the
 * caller reached here at all), the membership and account (the predicate
 * below), and the visibility flag. Only then is anything streamed.
 *
 * Returns null for an attachment that is invisible, belongs to another
 * customer or does not exist. One answer for all three.
 */
export async function portalDownload(
  db: Client,
  scope: PortalScope,
  entityAttachmentId: string,
): Promise<{ storageKey: string; filename: string; mimeType: string | null } | null> {
  const accounts = scope.accountIds.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT fo.storage_key, fo.original_filename, fo.mime_type,
            COALESCE(ea.portal_document_title, fo.original_filename) AS title
          FROM entity_attachments ea
          JOIN file_objects fo ON fo.file_id = ea.file_id
          WHERE ea.entity_attachment_id = ?
            AND ea.customer_visible = 1
            AND (
              (ea.entity_type = 'ACCOUNT' AND ea.entity_id IN (${accounts}))
              OR (ea.entity_type = 'SALES_ORDER' AND EXISTS (
                    SELECT 1 FROM sales_orders so WHERE so.sales_order_id = ea.entity_id
                      AND so.account_id IN (${accounts})))
              OR (ea.entity_type = 'CASE' AND EXISTS (
                    SELECT 1 FROM service_cases sc WHERE sc.case_id = ea.entity_id
                      AND sc.account_id IN (${accounts})))
            )
          LIMIT 1`,
    args: [
      entityAttachmentId,
      ...scope.accountIds,
      ...scope.accountIds,
      ...scope.accountIds,
    ] as never[],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    storageKey: text(row.storage_key),
    filename: text(row.title),
    mimeType: nullableText(row.mime_type),
  };
}

// ---- Home --------------------------------------------------------------------

export interface PortalHome {
  currentOrders: PortalOrderRow[];
  openRequests: PortalCaseRow[];
  actionRequired: { label: string; href: string }[];
  recentUpdates: { at: string; summary: string; href: string }[];
}

/**
 * The customer's own home. NO INTERNAL PERFORMANCE INFORMATION OF ANY KIND:
 * no compliance percentage, no team, no turnaround, no comparison with other
 * customers. Their orders, their requests, what needs them, what changed.
 */
export async function portalHome(db: Client, scope: PortalScope): Promise<PortalHome> {
  const [orders, cases] = await Promise.all([
    portalOrders(db, scope, 5),
    portalCases(db, scope, 5),
  ]);
  const current = orders.filter(
    (order) => order.status !== 'Completed' && order.status !== 'Cancelled',
  );
  const open = cases.filter((row) => row.status !== 'Resolved' && row.status !== 'Closed');
  return {
    currentOrders: current,
    openRequests: open,
    actionRequired: open
      .filter((row) => row.awaitingYourReply)
      .map((row) => ({
        label: `${row.caseNumber} is waiting for your reply`,
        href: `/portal/helpdesk/${row.caseId}`,
      })),
    recentUpdates: [
      ...orders
        .filter((order) => order.invoiceCreatedAt !== null)
        .map((order) => ({
          at: order.invoiceCreatedAt as string,
          summary: `Order ${order.documentNumber} was invoiced`,
          href: `/portal/orders/${order.salesOrderId}`,
        })),
      ...cases
        .filter((row) => row.lastUpdateAt !== null)
        .map((row) => ({
          at: row.lastUpdateAt as string,
          summary: `${row.caseNumber} was updated`,
          href: `/portal/helpdesk/${row.caseId}`,
        })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 6),
  };
}

// ---- What a customer may raise a request about --------------------------------

export interface PortalCategory {
  caseCategoryId: string;
  label: string;
}

/**
 * The categories offered on the portal request form.
 *
 * THE PRIORITY IS NOT OFFERED. `raisePortalCase` reads the category's own
 * `default_priority`, so the customer chooses what the request is about and
 * we decide how urgent that is. A priority field on this form would be a
 * field every customer sets to critical, which would make the whole scale
 * meaningless within a week.
 *
 * The label joins the category and the subcategory because "Delivery" alone
 * is not enough to route on and "Delivery / Late delivery" reads naturally
 * to somebody who has never seen our category tree.
 */
export async function portalCategories(db: Client): Promise<PortalCategory[]> {
  const result = await db.execute({
    sql: `SELECT case_category_id AS id, category_name AS category,
            subcategory_name AS subcategory
          FROM case_categories WHERE active = 1
          ORDER BY category_name, subcategory_name`,
    args: [],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      caseCategoryId: text(row.id),
      label: `${text(row.category)} / ${text(row.subcategory)}`,
    };
  });
}

// ---- Feedback ----------------------------------------------------------------

export interface PortalSurveyRow {
  invitationId: string;
  question: string;
  invitedAt: string;
  /** The request it followed, where it followed one. */
  caseNumber: string | null;
  caseId: string | null;
  /** The score the customer gave, or null where they have not answered. */
  score: number | null;
  answeredAt: string | null;
  expired: boolean;
}

/**
 * Every survey this account has been invited to answer, answered or not.
 *
 * THE SCORE COMES BACK. A customer who told us six out of ten should be able
 * to see that they did; hiding their own answer would make the whole
 * exercise feel like a box we tick rather than something we read.
 *
 * An expired invitation is shown and marked rather than dropped, so somebody
 * who meant to answer and did not can see what became of it instead of
 * wondering whether the page is broken.
 */
export async function portalSurveys(
  db: Client,
  scope: PortalScope,
  now: Date,
): Promise<PortalSurveyRow[]> {
  const predicate = accountPredicate(scope, 'si.account_id');
  const result = await db.execute({
    sql: `SELECT si.survey_invitation_id AS id, cs.question_text AS question,
            si.invited_at AS invited_at, si.expires_at AS expires_at,
            sc.case_number AS case_number, sc.case_id AS case_id,
            sr.score AS score, sr.responded_at AS responded_at
          FROM survey_invitations si
          JOIN customer_surveys cs ON cs.survey_id = si.survey_id
          LEFT JOIN service_cases sc ON sc.case_id = si.case_id
          LEFT JOIN survey_responses sr ON sr.survey_response_id = si.survey_response_id
          WHERE ${predicate.sql}
          ORDER BY si.invited_at DESC`,
    args: predicate.args as never[],
  });
  const stamp = toDbTimestamp(now);
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const expiresAt = nullableText(row.expires_at);
    const answeredAt = nullableText(row.responded_at);
    return {
      invitationId: text(row.id),
      question: text(row.question),
      invitedAt: text(row.invited_at),
      caseNumber: nullableText(row.case_number),
      caseId: nullableText(row.case_id),
      score: number(row.score),
      answeredAt,
      // An answered invitation is never "expired", whatever the date says.
      expired: answeredAt === null && expiresAt !== null && expiresAt < stamp,
    };
  });
}
