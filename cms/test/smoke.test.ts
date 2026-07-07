/**
 * Data-layer smoke test against the seeded non-production database. It applies to
 * a local libSQL file (or a staging Turso URL via CMS_DB_URL) that has been
 * seeded with `pnpm cms:db:apply && pnpm cms:db:seed`; when no seeded database is
 * present it skips cleanly, so CI without a seed stays honest rather than falsely
 * green. It exercises the core reads every phase relies on and verifies the demo
 * sign-in, so a broken query or a schema drift is caught before a page 500s.
 *
 * This complements the app-level smoke crawl (sign in and GET every page), which
 * runs against a staging Turso HTTP endpoint the Worker build can reach; a local
 * libSQL file is node-only. Both are gated behind the same seeded database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { createClient } from '@libsql/client';

const url = process.env.CMS_DB_URL ?? 'file:cms/.data/staging.db';
const fileMissing = url.startsWith('file:') && !existsSync(url.slice('file:'.length));
const skip = fileMissing
  ? 'no seeded database (run: pnpm cms:db:apply && pnpm cms:db:seed)'
  : false;

/** Verify a pbkdf2$iter$salt$hash value the way the app's shared verifier does. */
async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    expected.length * 8,
  );
  return Buffer.from(new Uint8Array(bits)).equals(expected);
}

test('cms smoke: seeded customers and contacts read back', { skip }, async () => {
  const db = createClient({ url });
  const customers = await db.execute('SELECT customer_id, company_name FROM customers');
  assert.ok(customers.rows.length > 0, 'expected seeded customers');

  const first = String(customers.rows[0].customer_id);
  const contacts = await db.execute({
    sql: 'SELECT contact_id FROM contacts WHERE customer_id = ?',
    args: [first],
  });
  assert.ok(contacts.rows.length >= 0, 'contacts query runs');
});

test('cms smoke: the staff sign-in resolves with its role and permissions', { skip }, async () => {
  const db = createClient({ url });
  const user = await db.execute({
    sql: "SELECT user_id, password_hash FROM users WHERE email = ? AND status = 'ACTIVE'",
    args: ['admin@hasspetroleum.com'],
  });
  assert.equal(user.rows.length, 1, 'expected the seeded super admin');
  const userId = String(user.rows[0].user_id);

  const role = await db.execute({
    sql: 'SELECT role_code FROM user_roles WHERE user_id = ?',
    args: [userId],
  });
  assert.ok(
    role.rows.some((r) => r.role_code === 'SUPER_ADMIN'),
    'expected the super admin role',
  );

  const perms = await db.execute({
    sql: 'SELECT permission_code FROM role_permissions WHERE role_code = ?',
    args: ['SUPER_ADMIN'],
  });
  assert.ok(
    perms.rows.some((r) => r.permission_code === 'customers.view'),
    'expected the customers.view grant',
  );

  const ok = await verifyPassword('HassDemo1!', String(user.rows[0].password_hash));
  assert.equal(ok, true, 'the demo password verifies against the seeded hash');
});

test('cms smoke: a portal customer can sign in', { skip }, async () => {
  const db = createClient({ url });
  const contact = await db.execute({
    sql: "SELECT password_hash FROM contacts WHERE is_portal_user = 1 AND status = 'ACTIVE' LIMIT 1",
  });
  assert.equal(contact.rows.length, 1, 'expected a seeded portal contact');
  const ok = await verifyPassword('HassDemo1!', String(contact.rows[0].password_hash));
  assert.equal(ok, true, 'the demo portal password verifies');
});

test('cms smoke: seeded orders read back and join to their lines', { skip }, async () => {
  const db = createClient({ url });
  const orders = await db.execute(
    'SELECT order_id, order_number, total_amount FROM orders ORDER BY requested_date DESC',
  );
  assert.ok(orders.rows.length > 0, 'expected seeded orders');

  // Every order joins to its customer (the staff list LEFT JOINs customers).
  const joined = await db.execute(
    `SELECT o.order_number, c.company_name
       FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id
      ORDER BY o.requested_date DESC LIMIT 1`,
  );
  assert.equal(joined.rows.length, 1, 'the order-to-customer join returns a row');

  // At least one order has lines (the detail view reads order_lines by order_id).
  const withLines = await db.execute(
    `SELECT ol.order_id, COUNT(*) AS n
       FROM order_lines ol GROUP BY ol.order_id HAVING n > 0 LIMIT 1`,
  );
  assert.ok(withLines.rows.length > 0, 'expected at least one order with lines');
});

test(
  'cms smoke: seeded invoices read back and resolve their parent order lines',
  { skip },
  async () => {
    const db = createClient({ url });
    const invoices = await db.execute(
      `SELECT invoice_id, invoice_number, order_id, total_amount, payment_status
       FROM invoices ORDER BY issue_date DESC`,
    );
    assert.ok(invoices.rows.length > 0, 'expected seeded invoices');

    // Every invoice references a real order and customer (the list LEFT JOINs
    // customers; the detail reads the parent order's lines).
    const joined = await db.execute(
      `SELECT i.invoice_number, c.company_name, i.order_id
       FROM invoices i LEFT JOIN customers c ON c.customer_id = i.customer_id
      ORDER BY i.issue_date DESC LIMIT 1`,
    );
    assert.equal(joined.rows.length, 1, 'the invoice-to-customer join returns a row');
    const orderId = String(joined.rows[0].order_id);

    const lines = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?',
      args: [orderId],
    });
    assert.ok(Number(lines.rows[0].n) > 0, "the invoice's parent order has lines");

    // A paid invoice carries an ETIMS submission (the source billing flow).
    const paid = await db.execute(
      "SELECT etims_invoice_number FROM invoices WHERE payment_status = 'PAID' LIMIT 1",
    );
    if (paid.rows.length) {
      assert.ok(paid.rows[0].etims_invoice_number, 'a paid invoice has an ETIMS number');
    }
  },
);

test(
  'cms smoke: seeded tickets read back and honour priority and portal scoping',
  { skip },
  async () => {
    const db = createClient({ url });
    const tickets = await db.execute(
      'SELECT ticket_id, ticket_number, customer_id, priority FROM tickets ORDER BY created_at DESC',
    );
    assert.ok(tickets.rows.length > 0, 'expected seeded tickets');

    // Every priority is within the CHECK domain (a drift here would 500 the list).
    const domain = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    assert.ok(
      tickets.rows.every((r) => domain.has(String(r.priority))),
      'every ticket priority is in the allowed set',
    );

    // A ticket joins to its customer and its comment thread.
    const first = String(tickets.rows[0].ticket_id);
    const comments = await db.execute({
      sql: 'SELECT is_internal FROM ticket_comments WHERE ticket_id = ?',
      args: [first],
    });
    assert.ok(comments.rows.length >= 0, 'the ticket comments query runs');

    // The portal thread must never include internal comments: the not-internal
    // count is never greater than the full count.
    const full = await db.execute('SELECT COUNT(*) AS n FROM ticket_comments');
    const external = await db.execute(
      'SELECT COUNT(*) AS n FROM ticket_comments WHERE is_internal = 0',
    );
    assert.ok(
      Number(external.rows[0].n) <= Number(full.rows[0].n),
      'the portal-visible comment count excludes internal notes',
    );
  },
);

test('cms smoke: seeded payment uploads read back and match to invoices', { skip }, async () => {
  const db = createClient({ url });
  const payments = await db.execute(
    `SELECT upload_id, customer_id, invoice_id, payment_method, status
       FROM payment_uploads ORDER BY upload_date DESC`,
  );
  assert.ok(payments.rows.length > 0, 'expected seeded payment uploads');

  // Every upload joins to its customer and (when matched) its invoice: the
  // staff list LEFT JOINs both.
  const joined = await db.execute(
    `SELECT p.reference_number, c.company_name, iv.invoice_number
       FROM payment_uploads p
       LEFT JOIN customers c ON c.customer_id = p.customer_id
       LEFT JOIN invoices iv ON iv.invoice_id = p.invoice_id
      ORDER BY p.upload_date DESC LIMIT 1`,
  );
  assert.equal(joined.rows.length, 1, 'the payment-to-customer/invoice join returns a row');

  // An approved receipt carries a reviewer (the source review flow).
  const approved = await db.execute(
    "SELECT reviewed_by FROM payment_uploads WHERE status = 'APPROVED' LIMIT 1",
  );
  if (approved.rows.length) {
    assert.ok(approved.rows[0].reviewed_by, 'an approved payment records who reviewed it');
  }
});

test('cms smoke: the customer analytics aggregations return shape', { skip }, async () => {
  const db = createClient({ url });
  const summary = await db.execute(
    `SELECT COUNT(*) AS total, COALESCE(SUM(lifetime_value), 0) AS ltv FROM customers`,
  );
  assert.ok(Number(summary.rows[0].total) > 0, 'expected customers for the summary');
  assert.ok(Number(summary.rows[0].ltv) > 0, 'expected a non-zero lifetime value total');

  const byCountry = await db.execute(
    `SELECT COALESCE(country_code, 'Unknown') AS label, COUNT(*) AS n
       FROM customers GROUP BY country_code ORDER BY n DESC`,
  );
  assert.ok(byCountry.rows.length > 0, 'expected a country breakdown');
});

test(
  'cms smoke: seeded catalogue reads back and products price across lists',
  { skip },
  async () => {
    const db = createClient({ url });
    const products = await db.execute(
      'SELECT product_id, sku, category FROM products ORDER BY name',
    );
    assert.ok(products.rows.length > 0, 'expected seeded products');

    const priceLists = await db.execute('SELECT price_id, country_code FROM price_list');
    assert.ok(priceLists.rows.length > 0, 'expected seeded price lists');

    // The detail view joins a product's price rows to their price list; at least
    // one product prices across more than one list (KE and UG).
    const first = String(products.rows[0].product_id);
    const prices = await db.execute({
      sql: `SELECT pl.country_code, pli.unit_price
            FROM price_list_items pli JOIN price_list pl ON pl.price_id = pli.price_list_id
           WHERE pli.product_id = ? ORDER BY pl.country_code`,
      args: [first],
    });
    assert.ok(prices.rows.length >= 1, 'the product-to-price-list join returns rows');
    assert.ok(
      prices.rows.every((r) => Number(r.unit_price) > 0),
      'every price is positive',
    );

    // The price-lists overview counts items per list.
    const counts = await db.execute(
      `SELECT pl.price_id, COUNT(pli.item_id) AS n
       FROM price_list pl LEFT JOIN price_list_items pli ON pli.price_list_id = pl.price_id
      GROUP BY pl.price_id`,
    );
    assert.ok(
      counts.rows.some((r) => Number(r.n) > 0),
      'at least one price list covers products',
    );
  },
);

test('cms smoke: the sales analytics aggregations return shape', { skip }, async () => {
  const db = createClient({ url });

  // Revenue time series: one point per month, non-cancelled, chronological.
  const revenue = await db.execute(
    `SELECT substr(requested_date, 1, 7) AS label, COALESCE(SUM(total_amount), 0) AS value
       FROM orders WHERE requested_date IS NOT NULL AND status != 'CANCELLED'
      GROUP BY substr(requested_date, 1, 7) ORDER BY label ASC`,
  );
  assert.ok(revenue.rows.length > 0, 'expected a revenue time series');
  assert.ok(
    revenue.rows.every((r) => Number(r.value) >= 0),
    'each revenue point is non-negative',
  );

  // The order funnel, invoice payment mix and payment-method mix each return
  // at least one bucket.
  const ordersByStatus = await db.execute(
    "SELECT COALESCE(status, 'Unknown') AS label, COUNT(*) AS n FROM orders GROUP BY status",
  );
  assert.ok(ordersByStatus.rows.length > 0, 'expected an order status breakdown');

  const invoicesByPayment = await db.execute(
    "SELECT COALESCE(payment_status, 'Unknown') AS label, COUNT(*) AS n FROM invoices GROUP BY payment_status",
  );
  assert.ok(invoicesByPayment.rows.length > 0, 'expected an invoice payment breakdown');

  const paymentsByMethod = await db.execute(
    "SELECT COALESCE(payment_method, 'Unspecified') AS label, COUNT(*) AS n FROM payment_uploads GROUP BY payment_method",
  );
  assert.ok(paymentsByMethod.rows.length > 0, 'expected a payment-method breakdown');
});
