# Murikah

Five independently built systems live in this repository:

| Directory | System | Public hostname |
| --- | --- | --- |
| [HomeWeb](HomeWeb/) | Public website and marketing | murikah.com |
| [HassCMS](HassCMS/) | Hass customer operations | cms.murikah.com |
| [Engr](Engr/) | Engineering Rhythm | engr.murikah.com |
| [GRC](GRC/) | Audit and risk | grc.murikah.com |
| [Tutor](Tutor/) | AI learning and virtual internships | tutor.murikah.com |

Each system owns its source, documentation, database tooling, assets, dependencies, configuration and tests. Generic helpers needed by multiple systems have local copies, so building a system does not require another system's checkout or package tree. Product documentation is kept inside its folder; there is no root application, docs directory, shared dependency installation or compatibility symlink.

GitHub Actions entry points remain in `.github/workflows/`, as required by GitHub. The root license, ignore rules and editor defaults apply to the repository.

## Development

For HomeWeb, HassCMS, Engr or GRC, enter that directory and run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm cf:dev
```

Use Node 22.22.2 and pnpm 10.33.0. Each generated Worker configuration is at that product's `dist/server/wrangler.json`. Runtime secrets must be configured separately for each product. Tutor has its own container and Worker toolchains; see [Tutor's instructions](Tutor/README.md). Its devcontainer configuration is at `Tutor/.devcontainer/devcontainer.json`; open the Tutor folder or select that configuration explicitly with a devcontainer client.

## Deployment transition

This layout replaces the old combined Astro Worker with four independently built Workers. Existing production services have not been changed by this repository refactor. Before deploying HomeWeb over the old `murikah-web` Worker, deploy and configure `hass-cms`, `murikah-engr` and `murikah-grc`, copy each system's own secret bindings through Cloudflare's secure configuration, and move its existing hostname to the corresponding Worker. Confirm login, database access and scheduled jobs before the HomeWeb cutover. Do not deploy HomeWeb first while the other hostnames still point to the old combined Worker.

No database migrations, seeds or production deployments are performed by the reorganization. The manual deployment workflow selects one product. The CI matrix builds and tests each product separately and continues reporting existing test failures.

## License

See [LICENSE](LICENSE). Tutor's pinned DeepTutor upstream retains its Apache-2.0 notices.
