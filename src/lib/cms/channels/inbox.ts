import type { Client } from '@libsql/client/web';

export interface InquiryMessageRow {
  channelMessageId: string;
  channel: 'EMAIL' | 'WHATSAPP';
  direction: 'INBOUND' | 'OUTBOUND';
  connectionName: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  body: string | null;
  receivedAt: string;
  status: string;
  accountId: string | null;
  accountName: string | null;
  contactName: string | null;
  caseId: string | null;
  caseNumber: string | null;
  caseSubject: string | null;
}

const maybe = (v: unknown): string | null => (v == null ? null : String(v));

export async function listInquiryMessages(
  db: Client,
  options: { channel?: string | null; direction?: string | null; search?: string | null; limit?: number } = {},
): Promise<InquiryMessageRow[]> {
  const where = ["cc.channel IN ('EMAIL','WHATSAPP')"];
  const args: string[] = [];
  if (options.channel === 'EMAIL' || options.channel === 'WHATSAPP') {
    where.push('cc.channel = ?');
    args.push(options.channel);
  }
  if (options.direction === 'INBOUND' || options.direction === 'OUTBOUND') {
    where.push('cm.direction = ?');
    args.push(options.direction);
  }
  const search = options.search?.trim() ?? '';
  if (search !== '') {
    where.push(`(lower(COALESCE(cm.subject,'')) LIKE ? OR lower(COALESCE(cm.body,'')) LIKE ?
                 OR lower(COALESCE(cm.from_address,'')) LIKE ? OR lower(COALESCE(a.account_name,'')) LIKE ?
                 OR lower(COALESCE(sc.case_number,'')) LIKE ?)`);
    const needle = `%${search.toLowerCase()}%`;
    args.push(needle, needle, needle, needle, needle);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 80, 200));
  const result = await db.execute({
    sql: `SELECT cm.channel_message_id, cc.channel, cm.direction, cc.display_name,
                 cm.from_address, cm.to_address, cm.subject, cm.body, cm.received_at,
                 cm.status, cm.account_id, a.account_name,
                 CASE WHEN c.contact_id IS NULL THEN NULL
                      ELSE trim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) END AS contact_name,
                 cm.case_id, sc.case_number, sc.subject AS case_subject
            FROM channel_messages cm
            JOIN channel_connections cc ON cc.channel_connection_id = cm.channel_connection_id
            LEFT JOIN accounts a ON a.account_id = cm.account_id
            LEFT JOIN contacts c ON c.contact_id = cm.contact_id
            LEFT JOIN service_cases sc ON sc.case_id = cm.case_id
           WHERE ${where.join(' AND ')}
           ORDER BY cm.received_at DESC, cm.created_at DESC
           LIMIT ${limit}`,
    args,
  });
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      channelMessageId: String(row.channel_message_id),
      channel: String(row.channel) as 'EMAIL' | 'WHATSAPP',
      direction: String(row.direction) as 'INBOUND' | 'OUTBOUND',
      connectionName: String(row.display_name ?? ''),
      fromAddress: maybe(row.from_address),
      toAddress: maybe(row.to_address),
      subject: maybe(row.subject),
      body: maybe(row.body),
      receivedAt: String(row.received_at ?? ''),
      status: String(row.status ?? ''),
      accountId: maybe(row.account_id),
      accountName: maybe(row.account_name),
      contactName: maybe(row.contact_name),
      caseId: maybe(row.case_id),
      caseNumber: maybe(row.case_number),
      caseSubject: maybe(row.case_subject),
    };
  });
}

export async function inquiryInboxCounts(db: Client): Promise<{ total: number; unlinked: number; email: number; whatsapp: number }> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cm.direction = 'INBOUND' AND cm.case_id IS NULL AND cm.status <> 'IGNORED' THEN 1 ELSE 0 END) AS unlinked,
            SUM(CASE WHEN cc.channel = 'EMAIL' THEN 1 ELSE 0 END) AS email,
            SUM(CASE WHEN cc.channel = 'WHATSAPP' THEN 1 ELSE 0 END) AS whatsapp
       FROM channel_messages cm
       JOIN channel_connections cc ON cc.channel_connection_id = cm.channel_connection_id
      WHERE cc.channel IN ('EMAIL','WHATSAPP')`,
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    unlinked: Number(row.unlinked ?? 0),
    email: Number(row.email ?? 0),
    whatsapp: Number(row.whatsapp ?? 0),
  };
}
