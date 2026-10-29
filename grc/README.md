# grc

This directory owns the grc application, database scripts, tests, Worker configuration and local dependency tree.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, then `pnpm cf:dev` here. Use Node 22.22.2 and pnpm 10.33.0. The Worker serves grc.murikah.com and grc.localhost, including its existing /grc internal route rewrite. Database tools are in db/ and source is in src/.

The Worker owns this product's scheduled jobs. Configure its product-specific Turso and session secrets before a production cutover. See the repository README for the deployment sequence. Existing database schemas and migration history are retained.
