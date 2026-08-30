/**
 * The universal notification queue, ported from queueNotification. One function
 * every module calls: it renders the notification (from an active email_templates
 * row when present, else the inline branded layout), writes a notification_queue
 * row (batch_type, priority, channel email, recipient, payload, related entity,
 * rendered subject and body, status PENDING, attempts 0, max_attempts 5), mirrors
 * an in_app_notifications row for the notification centre, and writes is_cc rows for any
 * explicit CC and for the Head of Audit on the key events. Every write is scoped
 * to the acting organisation and is best-effort, so a schema difference never
 * breaks the triggering transition. Column names follow
 * grc/docs/schema-assumptions.md.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { priorityOf, severityOf, ccsHoa, type NotificationType, type Priority } from './types';
import { renderNotification, type Payload, type EmailTemplate } from './render';
import { listHoaRecipients, type Recipient } from './recipients';

const MAX_ATTEMPTS = 5;

async function loadTemplate(db: Client, type: NotificationType): Promise<EmailTemplate | null> {
  try {
    const res = await db.execute({
      sql: `SELECT subject_template, body_template, is_active FROM email_templates
             WHERE template_type = ? LIMIT 1`,
      args: [type],
    });
    const r = res.rows[0];
    if (!r) return null;
    return {
      subjectTemplate: r.subject_template == null ? null : String(r.subject_template),
      bodyTemplate: r.body_template == null ? null : String(r.body_template),
      isActive: Number(r.is_active ?? 0) === 1,
    };
  } catch {
    return null;
  }
}

interface QueueRow {
  batchType: NotificationType;
  priority: Priority;
  recipientUserId: string | null;
  recipientEmail: string;
  recipientName: string | null;
  payload: Payload;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  subject: string;
  body: string;
  isCc: boolean;
}

function queueStmt(organizationId: string, r: QueueRow): InStatement {
  return {
    sql: `INSERT INTO notification_queue
            (notification_id, organization_id, batch_type, priority, channel,
             recipient_user_id, recipient_email, recipient_name, payload,
             related_entity_type, related_entity_id, rendered_subject, rendered_body,
             status, attempts, max_attempts, is_cc, created_at)
          VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      organizationId,
      r.batchType,
      r.priority,
      r.recipientUserId,
      r.recipientEmail,
      r.recipientName,
      JSON.stringify(r.payload),
      r.relatedEntityType,
      r.relatedEntityId,
      r.subject,
      r.body,
      MAX_ATTEMPTS,
      r.isCc ? 1 : 0,
      new Date().toISOString(),
    ],
  };
}

// The live `in_app_notifications` is user-scoped with no organisation column;
// its key is in_app_id and its link column deep_link (grc/docs/
// schema-assumptions.md, matching repos/inApp.ts). The earlier column list
// (notification_id, organization_id, link) failed the whole enqueue batch
// silently on the live shape.
function inAppStmt(
  userId: string,
  title: string,
  body: string,
  severity: string,
  link: string | null,
): InStatement {
  return {
    sql: `INSERT INTO in_app_notifications
            (in_app_id, user_id, title, body, severity, deep_link, read_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    args: [crypto.randomUUID(), userId, title, body, severity, link, new Date().toISOString()],
  };
}

function inAppBody(data: Payload): string {
  const parts = [data.reference, data.title].filter((v) => v != null && String(v) !== '');
  return parts.map((v) => String(v)).join(' - ');
}

export interface QueueParams {
  type: NotificationType;
  recipient: Recipient;
  data: Payload;
  priority?: Priority;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  /** Explicit CC email addresses (each gets its own is_cc row). */
  cc?: string[];
  /** The triggering user, excluded from the Head-of-Audit copy. */
  actorUserId?: string | null;
}

/** Queue one notification for a recipient, mirror it in-app, and add any explicit CC rows. */
export async function queueNotification(
  db: Client,
  organizationId: string,
  params: QueueParams,
): Promise<void> {
  try {
    const tpl = await loadTemplate(db, params.type);
    const rendered = renderNotification(tpl, params.type, params.data);
    const priority = params.priority ?? priorityOf(params.type);
    const link = typeof params.data.link === 'string' ? params.data.link : null;
    const relType = params.relatedEntityType ?? null;
    const relId = params.relatedEntityId ?? null;

    const stmts: InStatement[] = [
      queueStmt(organizationId, {
        batchType: params.type,
        priority,
        recipientUserId: params.recipient.userId,
        recipientEmail: params.recipient.email,
        recipientName: params.recipient.name,
        payload: params.data,
        relatedEntityType: relType,
        relatedEntityId: relId,
        subject: rendered.subject,
        body: rendered.body,
        isCc: false,
      }),
      inAppStmt(
        params.recipient.userId,
        rendered.subject,
        inAppBody(params.data),
        severityOf(params.type),
        link,
      ),
    ];
    for (const cc of params.cc ?? []) {
      if (!cc.trim()) continue;
      stmts.push(
        queueStmt(organizationId, {
          batchType: params.type,
          priority,
          recipientUserId: null,
          recipientEmail: cc.trim(),
          recipientName: null,
          payload: params.data,
          relatedEntityType: relType,
          relatedEntityId: relId,
          subject: rendered.subject,
          body: rendered.body,
          isCc: true,
        }),
      );
    }
    await db.batch(stmts, 'write');
  } catch (err) {
    // Best-effort: enqueue must never break the transition that triggered it.
    // But a silent swallow hid a schema mismatch for months, so it is logged.
    console.error('[grc.notify.queue] enqueue failed', err);
  }
}

export interface HoaCcParams {
  type: NotificationType;
  data: Payload;
  priority?: Priority;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  actorUserId?: string | null;
}

/**
 * Copy the Head of Audit on a key event (queueHoaCcNotifications): every active
 * SUPER_ADMIN (except the actor) gets an is_cc queue row and an in-app mirror.
 */
export async function queueHoaCc(
  db: Client,
  organizationId: string,
  params: HoaCcParams,
): Promise<void> {
  try {
    if (!ccsHoa(params.type)) return;
    const hoa = await listHoaRecipients(db, organizationId, params.actorUserId ?? null);
    if (hoa.length === 0) return;
    const tpl = await loadTemplate(db, params.type);
    const rendered = renderNotification(tpl, params.type, params.data);
    const priority = params.priority ?? priorityOf(params.type);
    const link = typeof params.data.link === 'string' ? params.data.link : null;
    const stmts: InStatement[] = [];
    for (const r of hoa) {
      stmts.push(
        queueStmt(organizationId, {
          batchType: params.type,
          priority,
          recipientUserId: r.userId,
          recipientEmail: r.email,
          recipientName: r.name,
          payload: params.data,
          relatedEntityType: params.relatedEntityType ?? null,
          relatedEntityId: params.relatedEntityId ?? null,
          subject: rendered.subject,
          body: rendered.body,
          isCc: true,
        }),
        inAppStmt(
          r.userId,
          rendered.subject,
          inAppBody(params.data),
          severityOf(params.type),
          link,
        ),
      );
    }
    await db.batch(stmts, 'write');
  } catch (err) {
    console.error('[grc.notify.queue] HOA CC enqueue failed', err);
  }
}
