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

  // Orders across the customers and the last twelve months, for a time series.
  const custIds = customers.map((c) => c[0]);
  const custCountry = Object.fromEntries(customers.map((c) => [c[0], [c[4], c[5]]]));
  const orderStatuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'FULFILLED', 'CANCELLED'];
  const payStatuses = ['UNPAID', 'PARTIAL', 'PAID'];
  const prodIds = products.map((p) => p[0]);
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
    'orders',
    'order_lines',
  ]) {
    const r = await run(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = Number(r.rows[0].n);
  }
  console.log('Seeded:', JSON.stringify(counts));
  console.log(`Demo staff sign-in: admin@hasspetroleum.com / ${DEMO_PASSWORD}`);
  console.log(`Demo portal sign-in: achieng@nairobilogistics.co.ke / ${DEMO_PASSWORD}`);
}

await seed();
