// Seed a non-production Hass CMS database with deterministic demo data, ported
// and extended from the source 99_dev_seed.gs, so every screen, chart and report
// has content. Targets CMS_DB_URL (a local libSQL file by default, or a staging
// Turso URL). Never production. A build-time dev tool; it ships nothing.
//
//   CMS_DB_URL=file:cms/.data/staging.db pnpm cms:db:seed
//
// The demo sign-in is admin@hasspetroleum.com / the DEMO_PASSWORD below (a
// non-production demo credential, printed once), so the smoke test and the demo
// video can sign in. Re-running replaces the seed rows (stable ids).
import { createClient } from '@libsql/client';
import { webcrypto as crypto } from 'node:crypto';

const url = process.env.CMS_DB_URL ?? 'file:cms/.data/staging.db';
const authToken = process.env.CMS_DB_AUTH_TOKEN;
const db = createClient(authToken ? { url, authToken } : { url });

const DEMO_PASSWORD = 'HassDemo1!';
const now = '2025-01-06T08:00:00.000Z';

async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$60000$${Buffer.from(salt).toString('base64')}$${Buffer.from(new Uint8Array(bits)).toString('base64')}`;
}

const run = (sql, args = []) => db.execute({ sql, args });

async function seed() {
  const pw = await hashPassword(DEMO_PASSWORD);

  // Countries.
  const countries = [
    ['KE', 'Kenya', 'HASS-KE', 'KES', 'Africa/Nairobi'],
    ['UG', 'Uganda', 'HASS-UG', 'UGX', 'Africa/Kampala'],
    ['TZ', 'Tanzania', 'HASS-TZ', 'TZS', 'Africa/Dar_es_Salaam'],
  ];
  for (const [code, name, aff, cur, tz] of countries) {
    await run(
      `INSERT OR REPLACE INTO countries (country_code, name, affiliate_code, currency_code, timezone) VALUES (?,?,?,?,?)`,
      [code, name, aff, cur, tz],
    );
  }

  // Roles.
  const roles = [
    ['SUPER_ADMIN', 'Super Admin'],
    ['SALES_MANAGER', 'Sales Manager'],
    ['SUPPORT_AGENT', 'Support Agent'],
    ['PORTAL_USER', 'Portal User'],
  ];
  for (const [code, label] of roles) {
    await run(`INSERT OR REPLACE INTO roles (role_code, role_name, is_system) VALUES (?,?,1)`, [
      code,
      label,
    ]);
  }

  // Permissions (the codes the module gates read).
  const perms = [
    ['customers.view', 'View customers'],
    ['customers.edit', 'Edit customers'],
    ['orders.view', 'View orders'],
    ['orders.edit', 'Edit orders'],
    ['invoices.view', 'View invoices'],
    ['payments.view', 'View payments'],
    ['tickets.view', 'View tickets'],
    ['tickets.edit', 'Edit tickets'],
    ['catalog.view', 'View catalogue'],
    ['reports.view', 'View reports'],
    ['admin.manage', 'Manage settings'],
  ];
  for (const [code, label] of perms) {
    await run(`INSERT OR REPLACE INTO permissions (permission_code, label) VALUES (?,?)`, [
      code,
      label,
    ]);
  }
  // Super admin holds every permission.
  for (const [code] of perms) {
    await run(
      `INSERT OR REPLACE INTO role_permissions (role_code, permission_code) VALUES ('SUPER_ADMIN', ?)`,
      [code],
    );
  }
  // A couple of scoped roles for realism.
  for (const code of [
    'customers.view',
    'orders.view',
    'orders.edit',
    'invoices.view',
    'reports.view',
  ])
    await run(
      `INSERT OR REPLACE INTO role_permissions (role_code, permission_code) VALUES ('SALES_MANAGER', ?)`,
      [code],
    );
  for (const code of ['tickets.view', 'tickets.edit', 'customers.view'])
    await run(
      `INSERT OR REPLACE INTO role_permissions (role_code, permission_code) VALUES ('SUPPORT_AGENT', ?)`,
      [code],
    );

  // Staff sign-in user (super admin).
  await run(
    `INSERT OR REPLACE INTO users
       (user_id, email, first_name, last_name, password_hash, must_change_password, status,
        mfa_enabled, country_code, created_at, updated_at)
     VALUES ('usr-admin', 'admin@hasspetroleum.com', 'Super', 'Admin', ?, 0, 'ACTIVE', 0, 'KE', ?, ?)`,
    [pw, now, now],
  );
  await run(
    `INSERT OR REPLACE INTO user_roles (user_id, role_code) VALUES ('usr-admin', 'SUPER_ADMIN')`,
  );

  // Branding: the Murikah default at global scope.
  await run(
    `INSERT OR REPLACE INTO branding (scope_code, app_name, primary_color, secondary_color, accent_color)
     VALUES ('GLOBAL', 'Hass CMS', '#0b1733', '#1f2d5c', '#c9a227')`,
  );

  // Customers.
  const customers = [
    [
      'cust-001',
      'HASS-001',
      'Nairobi Logistics Ltd',
      'B2B',
      'KE',
      'KES',
      5000000,
      1200000,
      8400000,
    ],
    ['cust-002', 'HASS-002', 'Mombasa Traders', 'B2C', 'KE', 'KES', 1500000, 300000, 2100000],
    ['cust-003', 'HASS-003', 'Kampala Distributors', 'B2B', 'UG', 'UGX', 3000000, 900000, 5200000],
    ['cust-004', 'HASS-004', 'Rift Valley Transport', 'B2C', 'KE', 'KES', 800000, 120000, 1400000],
    [
      'cust-005',
      'HASS-005',
      'Dar Coastal Supplies',
      'GOVERNMENT',
      'TZ',
      'TZS',
      2500000,
      640000,
      3900000,
    ],
    ['cust-006', 'HASS-006', 'Eldoret Agri Co', 'B2C', 'KE', 'KES', 600000, 60000, 900000],
  ];
  for (const [id, acc, name, type, cc, cur, lim, used, ltv] of customers) {
    await run(
      `INSERT OR REPLACE INTO customers
         (customer_id, account_number, company_name, customer_type, country_code, currency_code,
          credit_limit, credit_used, lifetime_value, status, onboarding_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE', 'COMPLETE', ?, ?)`,
      [id, acc, name, type, cc, cur, lim, used, ltv, now, now],
    );
  }

  // Contacts, including a portal-enabled customer login on the first account.
  const contacts = [
    ['con-001', 'cust-001', 'Achieng', 'Otieno', 'achieng@nairobilogistics.co.ke', 1, 'ADMIN'],
    ['con-002', 'cust-001', 'Brian', 'Kimani', 'brian@nairobilogistics.co.ke', 0, null],
    ['con-003', 'cust-002', 'Fatuma', 'Ali', 'fatuma@mombasatraders.co.ke', 0, null],
    ['con-004', 'cust-003', 'David', 'Okello', 'david@kampaladist.co.ug', 0, null],
    ['con-005', 'cust-004', 'Grace', 'Chebet', 'grace@riftvalley.co.ke', 0, null],
    ['con-006', 'cust-005', 'Juma', 'Salehe', 'juma@darcoastal.co.tz', 0, null],
  ];
  for (const [id, cid, fn, ln, email, portal, prole] of contacts) {
    await run(
      `INSERT OR REPLACE INTO contacts
         (contact_id, customer_id, first_name, last_name, email, is_portal_user, portal_role,
          password_hash, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?)`,
      [id, cid, fn, ln, email, portal, prole, portal ? pw : null, now, now],
    );
  }

  // Products (fuel and lubricants).
  const products = [
    ['prod-pms', 'PMS', 'Premium Motor Spirit (Petrol)', 'FUEL', 'litre'],
    ['prod-ago', 'AGO', 'Automotive Gas Oil (Diesel)', 'FUEL', 'litre'],
    ['prod-ik', 'IK', 'Illuminating Kerosene', 'FUEL', 'litre'],
    ['prod-lub', 'LUB', 'Engine Lubricant 20W-50', 'LUBRICANT', 'litre'],
    ['prod-lpg', 'LPG', 'Liquefied Petroleum Gas', 'GAS', 'kg'],
  ];
  for (const [id, sku, name, cat, uom] of products) {
    await run(
      `INSERT OR REPLACE INTO products (product_id, sku, name, category, unit_of_measure, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?, 1, ?, ?)`,
      [id, sku, name, cat, uom, now, now],
    );
  }
  const unitPrice = {
    'prod-pms': 189,
    'prod-ago': 175,
    'prod-ik': 165,
    'prod-lub': 950,
    'prod-lpg': 320,
  };

  // Price lists: a default per country (Kenya in KES, Uganda in UGX), each
  // pricing every product (FK-ordered after countries and products). The Kenya
  // list carries the KES prices the orders use; the Uganda list is a rough
  // local-currency equivalent so a second affiliate has its own pricing.
  const priceLists = [
    ['pl-ke', 'Kenya retail', 'KE', 'KES', 1],
    ['pl-ug', 'Uganda retail', 'UG', 'UGX', 1],
  ];
  for (const [id, name, cc, cur, isDefault] of priceLists) {
    await run(
      `INSERT OR REPLACE INTO price_list
         (price_id, name, country_code, currency_code, is_default, status, effective_from, created_at, updated_at)
       VALUES (?,?,?,?,?, 'ACTIVE', ?, ?, ?)`,
      [id, name, cc, cur, isDefault, '2025-01-01', now, now],
    );
  }
  const ugxFactor = 30; // rough KES→UGX for the demo local price.
  let pliSeq = 0;
  for (const [id] of products) {
    for (const pl of priceLists) {
      pliSeq += 1;
      const base = unitPrice[id];
      const price = pl[0] === 'pl-ug' ? base * ugxFactor : base;
      await run(
        `INSERT OR REPLACE INTO price_list_items
           (item_id, price_list_id, product_id, unit_price, min_quantity, discount_percent, tax_rate, effective_from, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [`pli-${String(pliSeq).padStart(3, '0')}`, pl[0], id, price, 500, 0, 16, '2025-01-01', now],
      );
    }
  }

  // Orders across the customers and the last twelve months, for a time series.
  const custIds = customers.map((c) => c[0]);
  const custCountry = Object.fromEntries(customers.map((c) => [c[0], [c[4], c[5]]]));
  const orderStatuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'FULFILLED', 'CANCELLED'];
  const payStatuses = ['UNPAID', 'PARTIAL', 'PAID'];
  const prodIds = products.map((p) => p[0]);
  const orderRecords = [];
  let lineSeq = 0;
  for (let i = 0; i < 24; i++) {
    const id = `ord-${String(i + 1).padStart(3, '0')}`;
    const cust = custIds[i % custIds.length];
    const [cc, cur] = custCountry[cust];
    const status = orderStatuses[i % orderStatuses.length];
    const pay = payStatuses[i % payStatuses.length];
    const month = (i % 12) + 1;
    const reqDate = `2025-${String(month).padStart(2, '0')}-15`;
    // One or two lines per order.
    const lineCount = (i % 2) + 1;
    let subtotal = 0;
    const lines = [];
    for (let l = 0; l < lineCount; l++) {
      const pid = prodIds[(i + l) % prodIds.length];
      const qty = 500 + ((i + l) % 5) * 250;
      const price = unitPrice[pid];
      const lineTotal = qty * price;
      subtotal += lineTotal;
      lines.push([pid, products.find((p) => p[0] === pid)[2], qty, price, lineTotal]);
    }
    const tax = Math.round(subtotal * 0.16);
    const total = subtotal + tax;
    await run(
      `INSERT OR REPLACE INTO orders
         (order_id, order_number, customer_id, country_code, currency_code, status, payment_status,
          requested_date, subtotal, tax_amount, total_amount, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        `SO-2025-${String(i + 1).padStart(4, '0')}`,
        cust,
        cc,
        cur,
        status,
        pay,
        reqDate,
        subtotal,
        tax,
        total,
        reqDate,
        reqDate,
      ],
    );
    for (const [pid, pname, qty, price, lineTotal] of lines) {
      lineSeq += 1;
      await run(
        `INSERT OR REPLACE INTO order_lines
           (line_id, order_id, product_id, product_name, quantity, unit_price, line_total, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [`oln-${String(lineSeq).padStart(4, '0')}`, id, pid, pname, qty, price, lineTotal, reqDate],
      );
    }
    orderRecords.push({ id, cust, cc, cur, status, pay, reqDate, subtotal, tax, total, month });
  }

  // Invoices for the orders that have been approved or fulfilled (FK-ordered
  // after orders). Payment state mirrors the order; a paid invoice carries an
  // ETIMS submission, matching the source billing flow.
  const dueDate = (month) =>
    month === 12 ? '2026-01-15' : `2025-${String(month + 1).padStart(2, '0')}-15`;
  const invoiceRecords = [];
  let invSeq = 0;
  for (const o of orderRecords) {
    if (o.status !== 'APPROVED' && o.status !== 'FULFILLED') continue;
    invSeq += 1;
    const invId = `inv-${String(invSeq).padStart(3, '0')}`;
    const invNo = `INV-2025-${String(invSeq).padStart(4, '0')}`;
    const paid = o.pay === 'PAID' ? o.total : o.pay === 'PARTIAL' ? Math.round(o.total / 2) : 0;
    const invStatus = o.pay === 'PAID' ? 'PAID' : 'SENT';
    const paidDate = o.pay === 'PAID' ? o.reqDate : null;
    const etimsNo = o.pay === 'PAID' ? `KRA-${String(1000 + invSeq)}` : null;
    const etimsStatus = o.pay === 'PAID' ? 'SUBMITTED' : null;
    const etimsAt = o.pay === 'PAID' ? o.reqDate : null;
    await run(
      `INSERT OR REPLACE INTO invoices
         (invoice_id, invoice_number, order_id, customer_id, country_code, currency_code,
          issue_date, due_date, subtotal, tax_amount, total_amount, status, payment_status,
          paid_amount, paid_date, etims_invoice_number, etims_status, etims_submitted_at,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        invId,
        invNo,
        o.id,
        o.cust,
        o.cc,
        o.cur,
        o.reqDate,
        dueDate(o.month),
        o.subtotal,
        o.tax,
        o.total,
        invStatus,
        o.pay,
        paid,
        paidDate,
        etimsNo,
        etimsStatus,
        etimsAt,
        o.reqDate,
        o.reqDate,
      ],
    );
    invoiceRecords.push({
      id: invId,
      cust: o.cust,
      cc: o.cc,
      cur: o.cur,
      total: o.total,
      pay: o.pay,
      reqDate: o.reqDate,
    });
  }

  // Payment uploads: proof-of-payment receipts matched to invoices (FK-ordered
  // after invoices). A paid invoice has an approved, matched receipt; a partial
  // one is pending review. The portal customer always gets a pending upload so
  // the portal payments view has content. Methods cycle M-Pesa/bank/Oracle.
  const methods = ['MPESA', 'BANK_TRANSFER', 'ORACLE'];
  const refPrefix = { MPESA: 'QGH', BANK_TRANSFER: 'FT', ORACLE: 'ORA' };
  let paySeq = 0;
  for (const inv of invoiceRecords) {
    const isPortalCust = inv.cust === 'cust-001';
    if (inv.pay !== 'PAID' && inv.pay !== 'PARTIAL' && !isPortalCust) continue;
    paySeq += 1;
    const method = methods[paySeq % methods.length];
    const approved = inv.pay === 'PAID';
    const amount =
      inv.pay === 'PAID'
        ? inv.total
        : inv.pay === 'PARTIAL'
          ? Math.round(inv.total / 2)
          : inv.total;
    await run(
      `INSERT OR REPLACE INTO payment_uploads
         (upload_id, customer_id, invoice_id, file_name, payment_method, amount, currency_code,
          reference_number, upload_date, uploaded_by, status, reviewed_by, review_notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `pay-${String(paySeq).padStart(3, '0')}`,
        inv.cust,
        inv.id,
        `receipt-${paySeq}.pdf`,
        method,
        amount,
        inv.cur,
        `${refPrefix[method]}${String(100000 + paySeq)}`,
        inv.reqDate,
        'CUSTOMER',
        approved ? 'APPROVED' : 'PENDING',
        approved ? 'usr-admin' : null,
        approved ? 'Matched to invoice.' : null,
        inv.reqDate,
      ],
    );
  }

  // Support tickets across the customers, with a short comment thread each
  // (FK-ordered after customers/contacts/orders). Priority honours the CHECK
  // (CRITICAL/HIGH/MEDIUM/LOW). The first ticket is on the portal customer so
  // the portal tickets view has content. A comment marked internal must not
  // reach the portal thread.
  const tickets = [
    {
      id: 'tkt-001',
      no: 'TK-2025-0001',
      cust: 'cust-001',
      contact: 'con-001',
      order: 'ord-001',
      channel: 'PORTAL',
      category: 'DELIVERY',
      subject: 'Delivery arrived short by 200 litres',
      description: 'The AGO delivery on order SO-2025-0001 was 200 litres short of the order.',
      priority: 'HIGH',
      status: 'RESOLVED',
      resolvedAt: '2025-01-18',
      comments: [
        ['CUSTOMER', 'con-001', 'Achieng Otieno', 'Our dip reading is 200 litres under.', 0, 0],
        [
          'STAFF',
          'usr-admin',
          'Hass Support',
          'Confirmed with the depot, arranging a top-up.',
          0,
          0,
        ],
        ['STAFF', 'usr-admin', 'Hass Support', 'Credit note raised; top-up delivered.', 0, 1],
      ],
    },
    {
      id: 'tkt-002',
      no: 'TK-2025-0002',
      cust: 'cust-002',
      contact: null,
      order: null,
      channel: 'EMAIL',
      category: 'BILLING',
      subject: 'Invoice ETIMS number missing',
      description: 'A customer invoice is missing its ETIMS reference for VAT filing.',
      priority: 'MEDIUM',
      status: 'IN_PROGRESS',
      resolvedAt: null,
      comments: [
        ['STAFF', 'usr-admin', 'Hass Support', 'Resubmitting to ETIMS; will confirm.', 1, 0],
      ],
    },
    {
      id: 'tkt-003',
      no: 'TK-2025-0003',
      cust: 'cust-003',
      contact: null,
      order: null,
      channel: 'PHONE',
      category: 'ACCOUNT',
      subject: 'Request to raise credit limit',
      description: 'Customer requests a higher credit limit for the coming quarter.',
      priority: 'LOW',
      status: 'NEW',
      resolvedAt: null,
      comments: [],
    },
    {
      id: 'tkt-004',
      no: 'TK-2025-0004',
      cust: 'cust-004',
      contact: null,
      order: null,
      channel: 'PORTAL',
      category: 'QUALITY',
      subject: 'Suspected water in kerosene batch',
      description: 'Customer reports a quality concern with a recent IK batch.',
      priority: 'CRITICAL',
      status: 'IN_PROGRESS',
      resolvedAt: null,
      comments: [
        ['CUSTOMER', 'con-005', 'Grace Chebet', 'The batch smells off and burns poorly.', 0, 0],
        ['STAFF', 'usr-admin', 'Hass Support', 'QA sample collected; escalated to the lab.', 0, 0],
      ],
    },
    {
      id: 'tkt-005',
      no: 'TK-2025-0005',
      cust: 'cust-005',
      contact: null,
      order: null,
      channel: 'WHATSAPP',
      category: 'DELIVERY',
      subject: 'Reschedule tomorrow’s LPG delivery',
      description: 'Customer asks to move the LPG delivery to the afternoon window.',
      priority: 'MEDIUM',
      status: 'CLOSED',
      resolvedAt: '2025-02-02',
      comments: [['STAFF', 'usr-admin', 'Hass Support', 'Rescheduled to the 2–5pm window.', 0, 1]],
    },
  ];
  let cmtSeq = 0;
  for (const t of tickets) {
    const created = t.resolvedAt ?? '2025-01-10';
    await run(
      `INSERT OR REPLACE INTO tickets
         (ticket_id, ticket_number, customer_id, contact_id, channel, category, subject,
          description, priority, status, related_order_id, resolved_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        t.id,
        t.no,
        t.cust,
        t.contact,
        t.channel,
        t.category,
        t.subject,
        t.description,
        t.priority,
        t.status,
        t.order,
        t.resolvedAt,
        created,
        created,
      ],
    );
    let ci = 0;
    for (const [atype, aid, aname, content, internal, resolution] of t.comments) {
      cmtSeq += 1;
      ci += 1;
      const at = `${created}T0${Math.min(ci, 9)}:00:00.000Z`;
      await run(
        `INSERT OR REPLACE INTO ticket_comments
           (comment_id, ticket_id, author_type, author_id, author_name, content,
            is_internal, is_resolution, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          `cmt-${String(cmtSeq).padStart(4, '0')}`,
          t.id,
          atype,
          aid,
          aname,
          content,
          internal,
          resolution,
          at,
          at,
        ],
      );
    }
  }

  // Self-check: report row counts so a run verifies the seed landed.
  const counts = {};
  for (const t of [
    'countries',
    'roles',
    'permissions',
    'users',
    'customers',
    'contacts',
    'products',
    'price_list',
    'price_list_items',
    'orders',
    'order_lines',
    'invoices',
    'payment_uploads',
    'tickets',
    'ticket_comments',
  ]) {
    const r = await run(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = Number(r.rows[0].n);
  }
  console.log('Seeded:', JSON.stringify(counts));
  console.log(`Demo staff sign-in: admin@hasspetroleum.com / ${DEMO_PASSWORD}`);
  console.log(`Demo portal sign-in: achieng@nairobilogistics.co.ke / ${DEMO_PASSWORD}`);
}

await seed();
