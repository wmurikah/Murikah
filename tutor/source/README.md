# Tutor upstream source

Murikah Tutor currently consumes DeepTutor from a pinned upstream commit instead of vendoring the full project into the Murikah repository.

Pinned source is declared in `upstream.env`.

To materialize a working checkout, run:

```bash
cd tutor
./scripts/materialize.sh
```

The generated checkout is written to `tutor/.vendor/DeepTutor` and is ignored by Git. The materialization step also copies the existing Murikah transparent logo from `docs/images/murikah_6.png` into the generated Tutor web assets and applies the Murikah Tutor presentation overlay.

## What is intentionally not renamed

The following remain upstream-compatible DeepTutor internals:

- Python package/import names
- CLI/runtime identifiers
- API paths
- environment variable names
- persistence paths and data structures
- Docker/service internals

Only user-facing presentation branding is changed at this stage.

## Fork transition

The preferred long-term source remains a Murikah-owned fork. The current GitHub connection cannot create a fork or new repository, so this pinned-source workflow is the safe interim implementation.

After `wmurikah/DeepTutor` is created, change only `DEEPTUTOR_REPOSITORY` in `upstream.env` to the fork URL and retain HKUDS/DeepTutor as the fork's upstream remote. The pinning and branding workflow can remain unchanged.

## Licence

DeepTutor is distributed under Apache License 2.0. Upstream licence and notice files remain part of the materialized checkout and must be retained in deployed/redistributed derivatives as applicable.
