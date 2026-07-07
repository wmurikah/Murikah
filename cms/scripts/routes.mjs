// The canonical Hass CMS route manifest: the single source of truth for the
// app-level crawl, the demo recorder and the static route-coverage test. Every
// page the app serves is listed here with the file that renders it and the auth
// context it needs, so the crawl target set cannot silently fall behind the app
// (a new page with no manifest entry fails the route-coverage test).
//
// The detail routes use ids from the deterministic seed (cms/db/seed.mjs), so
// they resolve against the seeded non-production database.

export const DEMO = {
  staff: { email: 'admin@hasspetroleum.com', password: 'HassDemo1!' },
  portal: { email: 'achieng@nairobilogistics.co.ke', password: 'HassDemo1!' },
};

// auth: 'public' | 'staff' | 'portal'
// crawl: false marks a page the GET crawl skips (needs a transient session),
// but which the route-coverage test still requires to exist and be boundaried.
export const ROUTES = [
  // Public entry points.
  { path: '/login', file: 'src/pages/cms/login.astro', auth: 'public', crawl: true },
  { path: '/portal/login', file: 'src/pages/cms/portal/login.astro', auth: 'public', crawl: true },
  { path: '/mfa', file: 'src/pages/cms/mfa.astro', auth: 'public', crawl: false },

  // Staff list pages.
  { path: '/', file: 'src/pages/cms/index.astro', auth: 'staff', crawl: true },
  { path: '/customers', file: 'src/pages/cms/customers/index.astro', auth: 'staff', crawl: true },
  { path: '/orders', file: 'src/pages/cms/orders/index.astro', auth: 'staff', crawl: true },
  { path: '/invoices', file: 'src/pages/cms/invoices/index.astro', auth: 'staff', crawl: true },
  { path: '/payments', file: 'src/pages/cms/payments/index.astro', auth: 'staff', crawl: true },
  { path: '/tickets', file: 'src/pages/cms/tickets/index.astro', auth: 'staff', crawl: true },
  { path: '/analytics', file: 'src/pages/cms/analytics/index.astro', auth: 'staff', crawl: true },

  // Staff detail pages (ids from the seed).
  {
    path: '/customers/cust-001',
    file: 'src/pages/cms/customers/[id].astro',
    auth: 'staff',
    crawl: true,
  },
  { path: '/orders/ord-012', file: 'src/pages/cms/orders/[id].astro', auth: 'staff', crawl: true },
  {
    path: '/invoices/inv-001',
    file: 'src/pages/cms/invoices/[id].astro',
    auth: 'staff',
    crawl: true,
  },
  {
    path: '/payments/pay-001',
    file: 'src/pages/cms/payments/[id].astro',
    auth: 'staff',
    crawl: true,
  },
  {
    path: '/tickets/tkt-001',
    file: 'src/pages/cms/tickets/[id].astro',
    auth: 'staff',
    crawl: true,
  },

  // Portal pages (scoped to the signed-in customer).
  { path: '/portal', file: 'src/pages/cms/portal/index.astro', auth: 'portal', crawl: true },
  {
    path: '/portal/orders',
    file: 'src/pages/cms/portal/orders.astro',
    auth: 'portal',
    crawl: true,
  },
  {
    path: '/portal/invoices',
    file: 'src/pages/cms/portal/invoices.astro',
    auth: 'portal',
    crawl: true,
  },
  {
    path: '/portal/payments',
    file: 'src/pages/cms/portal/payments.astro',
    auth: 'portal',
    crawl: true,
  },
  {
    path: '/portal/tickets',
    file: 'src/pages/cms/portal/tickets.astro',
    auth: 'portal',
    crawl: true,
  },
];

// Auth endpoints the crawl posts to (not pages; excluded from route coverage).
export const AUTH_ENDPOINTS = {
  staffLogin: '/api/auth/login',
  logout: '/api/auth/logout',
  mfa: '/api/auth/mfa',
};

// A search dry-run per list page: appending the query must not 500.
export const SEARCH_DRY_RUNS = [
  '/customers?q=nairobi',
  '/orders?q=SO-2025',
  '/invoices?q=INV-2025',
  '/payments?q=QGH',
  '/tickets?q=delivery&priority=HIGH',
];

// The 60-second demo storyboard: ordered scenes with a dwell budget (seconds)
// that sums to ~60s. The recorder walks these; the same list is the written
// designed-walkthrough fallback in cms/docs/demo/storyboard.md.
export const STORYBOARD = [
  { seconds: 6, auth: 'staff', path: '/', caption: 'Sign in — the branded staff dashboard' },
  { seconds: 6, auth: 'staff', path: '/customers', caption: 'Customers: the account base' },
  {
    seconds: 5,
    auth: 'staff',
    path: '/customers/cust-001',
    caption: 'A customer and its contacts',
  },
  { seconds: 6, auth: 'staff', path: '/orders', caption: 'Orders across the affiliates' },
  { seconds: 5, auth: 'staff', path: '/orders/ord-012', caption: 'An order and its lines' },
  { seconds: 6, auth: 'staff', path: '/invoices', caption: 'Invoices with ETIMS' },
  { seconds: 5, auth: 'staff', path: '/payments', caption: 'Payments to review and match' },
  { seconds: 5, auth: 'staff', path: '/tickets', caption: 'Support tickets and SLAs' },
  { seconds: 6, auth: 'staff', path: '/analytics', caption: 'Analytics: revenue and the funnel' },
  { seconds: 5, auth: 'portal', path: '/portal', caption: 'The customer portal home' },
  { seconds: 5, auth: 'portal', path: '/portal/orders', caption: 'A customer tracks their orders' },
];
