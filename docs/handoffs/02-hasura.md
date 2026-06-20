# Orb Agent Handoff 2 — Shared-Host Hasura (Plan B, validated)

Continues from `docs/handoffs/01-base.md` (Experiment 1 = clean base VM, repo + baked
`pnpm install`, fast clone verified).

## Decision (locked in, experimentally verified)

Each agent VM needs its **own** `hasura/graphql-engine` (because its
`auth_hook`/actions/webhook point at the backend running **inside that VM**).
We do **NOT** run docker inside the VMs. Instead, everything per-agent runs on
the **host OrbStack docker engine**:

```text
golden Postgres data dir (stopped) -> btrfs CoW clone per agent (~0 disk)
N per-agent Postgres containers     -> one real isolated DB per agent
N capped graphql-engine containers  -> one per agent, memory-capped
no docker inside the VM             -> base stays small, clones stay fast
```

**Locked-in decision: every agent gets its own cloned database (Option 3,
btrfs CoW golden).** We always start an agent from a full copy of the real dev
data, with full mutation isolation. The cost is one Postgres process per agent
(~30–100 MB idle); the disk cost is ~0 because btrfs reflink shares unwritten
blocks. This is an accepted tradeoff — cheap isolation for the price of one
extra pg per agent — and it mirrors the project's design (the VM is CoW-cloned
by OrbStack; the DB is CoW-cloned by btrfs).

Why per-agent docker (not docker-in-VM):

- graphql-engine (~60 MB) is needed per agent either way.
- docker-in-VM also costs an **80–150 MB dockerd per agent** + bakes docker
  into the base (bigger image, slower clones, more disk per agent).
- This reuses the dockerd that OrbStack already runs. More free RAM = more
  parallel agents.

Tradeoff accepted: hasura **and** the agent's Postgres live on the **host**,
not in the VM. So the agent lifecycle (`oa new` / `oa rm`) must also
create/remove the host containers (pg + hasura) and the CoW data dir. That
coupling is the price for the RAM/clone savings + real data isolation.

```diagram
                  ┌──────── host OrbStack docker (one engine) ────────┐
                  │                                                    │
  shilo-agent-1 ──┤  orb-hasura-1  :18081  --memory 512m              │
   (.orb.local)   │    metadata+data ─────▶ orb-pg-1 :15441          │
   auth_hook ◀────┤    auth_hook → shilo-agent-1.orb.local:8010       │   golden pg
                  │                         (CoW clone of golden)     │   data dir
  shilo-agent-2 ──┤  orb-hasura-2  :18082  --memory 512m              │   (stopped)
   (.orb.local)   │    metadata+data ─────▶ orb-pg-2 :15442          │──▶ btrfs reflink
   auth_hook ◀────┤    auth_hook → shilo-agent-2.orb.local:8010       │   per agent
                  │                         (CoW clone of golden)     │   (~0 disk)
                  └────────────────────────────────────────────────-─┘
```

## Experiment results (2026-06-08, on host OrbStack)

Spun up two capped graphql-engine containers on the host engine, each with
its own database on the shared `shilo-postgres-1` (postgres:15):

```text
orb-hasura-1  :18081  --memory 512m  metadata+data DB = agent_1
orb-hasura-2  :18082  --memory 512m  metadata+data DB = agent_2
```

Verified:

- Both `/healthz` → `OK`, GraphQL responds.
- Memory cap works: limit 512 MiB, idle usage ~50–65 MiB each
  (two engines ≈ 120 MiB total on host; no extra dockerd per agent).
- **Isolation proven**: created table `widget` in DB `agent_1`, tracked it on
  hasura-1 → query returns `only-in-agent-1`; same query on hasura-2 →
  `field 'widget' not found`. Separate metadata + separate DB ⇒ agents do
  not see each other.
- Per-agent wiring confirmed: each container's `AUTH_HOOK`/`API_URL`/
  `WEBHOOK_URL` point at its own `shilo-agent-N.orb.local:8010`.

Key correction we learned: there is **no separate metadata Postgres per
agent**. Postgres is one process; per agent we create a logical `agent_N`
**database**, and hasura stores its metadata in the `hdb_catalog` schema
inside it. Cost of metadata isolation ≈ 0 RAM.

Note from the experiment: `pg_add_source` (the `default` source) and table
tracking are normally done by the repo's `hasura migrate apply` +
`metadata apply`. In the experiment we added the source by hand as a stand-in.

## Why hasura is needed for the full PR loop (verified)

The minimal "Codex change -> PR" loop works WITHOUT infra, but the repo's
`.husky/pre-push` hook runs:

```sh
pnpm turbo run fetch-schema           # needs a live Hasura GraphQL endpoint
pnpm turbo run lint  --filter @shilo/web[...]
pnpm turbo run tsc:check --filter @shilo/web[...]
```

`fetch-schema` (`packages/graphql-api/schema.ts`) hits
`${HASURA_URL}/v1/graphql` with `x-hasura-admin-secret`. So:

```text
push WITH hooks   -> needs per-agent Hasura (this plan)
push --no-verify  -> works today (smoke-tested, PR #4037)
```

Other gotchas found during the smoke test:

```text
- asdf is only in ~/.bashrc; non-interactive/login shells (and husky
  hooks) don't get pnpm on PATH. Source ~/.asdf/asdf.sh, or add it to
  ~/.profile so git hooks can find pnpm.
- branch prefix `test/` collides with existing remote branch `test`
  ("directory file conflict"). Avoid `test/...` names.
- git identity + `gh auth setup-git` are now baked into the base.
```

## Config reference (from repo + running host stack)

graphql-engine image:

```text
hasura/graphql-engine:v2.40.0     # already pulled on host
```

Env that the host dev stack uses (admin secret etc.), mirror per agent:

```env
HASURA_GRAPHQL_METADATA_DATABASE_URL=postgres://postgres:postgrespassword@host.docker.internal:5432/agent_N
PG_DATABASE_URL=postgres://postgres:postgrespassword@host.docker.internal:5432/agent_N
HASURA_GRAPHQL_ADMIN_SECRET=hasura_graphql_admin_secret
HASURA_GRAPHQL_CORS_DOMAIN=*
HASURA_GRAPHQL_EXPERIMENTAL_FEATURES=naming_convention
HASURA_GRAPHQL_ENABLE_CONSOLE=false
HASURA_GRAPHQL_DEV_MODE=true
HASURA_GRAPHQL_AUTH_HOOK=http://shilo-agent-N.orb.local:8010/auth/hasura
API_URL=http://shilo-agent-N.orb.local:8010
WEBHOOK_URL=http://shilo-agent-N.orb.local:8010
```

Backend ports (apps/backend/.env.example):

```env
BASE_URL=http://localhost:8010    # backend HTTP, exposed as shilo-agent-N.orb.local:8010
APP_URL=http://localhost:3001
# hasura actions handler baseurl (hasura/config.yaml) = http://localhost:3000
```

Backend → hasura wiring (apps/backend/.env.example):

```env
HASURA_URL=http://localhost:18081      # the agent's own hasura on host
HASURA_GRAPHQL_ADMIN_SECRET=hasura_graphql_admin_secret
WEBHOOK_URL=...
```

Hasura CLI scripts already in repo (`hasura/package.json`, root
`package.json`):

```text
pnpm migrate          -> turbo run db:migrate (migrate apply + metadata apply)
pnpm metadata:apply   -> pnpm --filter @shilo/hasura hasura:metadata
pnpm h:console        -> hasura console --project ./hasura
```

## Provisioning agent DB: clone, don't migrate (validated)

Instead of `hasura migrate apply` + `metadata apply` from scratch, **clone
the existing main dev DB** into `agent_N`. This is faster and removes the
need for the hasura CLI in the base.

Why it works cleanly: the `default` source stores its connection as
`{"from_env": "PG_DATABASE_URL"}` (NOT a literal URL). So metadata is not
tied to a database name — copy it into `agent_N`, start the engine with
`PG_DATABASE_URL=...agent_N`, and the source auto-retargets.

```bash
docker exec shilo-postgres-1 psql -U postgres -c "CREATE DATABASE agent_N;"
docker exec shilo-postgres-1 bash -lc \
  "pg_dump -U postgres --no-owner --no-privileges -d postgres | psql -U postgres -d agent_N -q"
```

This copies BOTH the app schema/data (`public`) AND the hasura metadata
(`hdb_catalog`). `pg_dump` runs against the live main DB (consistent
snapshot); note `CREATE DATABASE ... TEMPLATE postgres` does NOT work while
the main hasura/backend hold connections, so use dump|restore.

Validated (agent_3, port 18083): engine came up with **502 query fields
exposed, zero migrations run**. The only `inconsistent_objects` were the
env-driven ones (remote schema `vendorApi` → `VENDOR_API_URL`; event
triggers `userDeleted`/`integrationCreated` → `WEBHOOK_URL`; and the remote
relationships that cascade off `vendorApi`). Those become consistent once the
container is started with `VENDOR_API_URL` / `WEBHOOK_URL` / `AUTH_HOOK`
pointing at the agent's backend — the clone itself (tables, permissions,
relationships) is clean.

Data mode was a choice between three validated options (2026-06-08). **We
picked Option 3.** Options 1 and 2 are kept below as rejected alternatives /
fallbacks only.

```text
                       data        disk/agent   data isolation   PG procs
 shared data           real        ~9 MB(meta)  NO               0 (shared)
 schema + enum seed    empty       ~15 MB       yes              0 (shared)
 btrfs CoW (golden) ◀  real        ~0 (CoW)     YES   ✅ CHOSEN   1 per agent
```

Rationale: agents must be able to mutate real data without polluting each
other or the shared dev DB, and CoW makes that ~free on disk. The only cost is
one pg process per agent, which we accept.

### Option 3 (CHOSEN) — btrfs copy-on-write golden (isolated, real data, ~0 disk)

See the full description below. This is the path `oa`/the control plane will
implement for every agent.

### Option 1 (rejected) — shared data, cloned metadata only (lightest)

Clone ONLY `hdb_catalog` into a tiny per-agent metadata DB; point the data
source at the shared main `postgres`:

```bash
docker exec shilo-postgres-1 psql -U postgres -c "CREATE DATABASE agent_N_meta;"
docker exec shilo-postgres-1 bash -lc \
  "pg_dump -U postgres --no-owner --no-privileges --schema=hdb_catalog -d postgres | psql -U postgres -d agent_N_meta -q"
# engine: HASURA_GRAPHQL_METADATA_DATABASE_URL=...agent_N_meta
#         PG_DATABASE_URL=...postgres   (shared real data)
```

Validated: metadata DB ~8.6 MB, **502 query fields**, reads real data. But
all agents read/write the SAME main `postgres` — no data isolation; agent
mutations pollute the shared dev DB. Use only if agents read (don't mutate)
or shared mutation is acceptable.

### Option 2 (rejected) — schema + enum seed (isolated, empty data)

`pg_dump --schema-only` for `public` + data for `hdb_catalog` + data for the
`is_enum` tables only (Hasura refuses to track an empty enum table, so the
reference/enum tables must be seeded). ~15 MB, isolated, agent starts empty
and mutates its own copy. Caveat: no real transactional data to start from.

### Option 3 (CHOSEN) — btrfs copy-on-write golden — full description

The OrbStack docker volume filesystem is **btrfs with reflink/CoW support**
(verified: `/var/lib/postgresql/data` is `btrfs` on `/dev/vdb1`,
`cp --reflink=always` works). So we can give each agent its own full real
DB without physically copying the ~1 GB:

```text
- keep one GOLDEN postgres cluster (data dir) = snapshot of main data,
  refreshed periodically, kept STOPPED/quiesced.
- per agent:  cp --reflink=always -a golden agent_N   (or btrfs subvolume
  snapshot) — instant, ~0 disk; blocks are shared until written.
- run a per-agent postgres container on agent_N's data dir.
- agent's hasura: cloned metadata DB + data source -> the agent's own CoW PG.
```

Validated in a btrfs lab (golden = 1.6 GB cluster, 2M rows):

```text
- reflink clone of 1.6 GB data dir: 0.02 s  (a real copy would take seconds)
- isolation: mutated agent_a -> 2.5M rows; agent_b stayed 2.0M (untouched)
- 8.2 GB logical across golden + 3 clones lived in ~1 GB physical blocks
```

Cost: one postgres process per agent (~30–100 MB RAM idle) and the golden
must be cloned from a *stopped/consistent* cluster (cannot reflink a live
data dir safely). This is the only option that gives real data + full
mutation isolation + ~0 disk, and it mirrors the project's design (VM is
CoW-cloned by OrbStack; the DB is CoW-cloned by btrfs).

## What still needs adding to the base / oa

1. **Golden cluster management** — maintain one stopped/quiesced golden
   Postgres data dir (snapshot of main dev data, refreshed periodically). This
   is the source for every agent's CoW clone.
2. **`oa hasura up <n>` / `oa hasura down <n>`** — on startup:
   `cp --reflink=always` (or btrfs subvolume snapshot) the golden data dir to
   `agent_N`'s data dir, `docker run` a per-agent Postgres on it
   (`orb-pg-N :154NN`), then `docker run` the capped graphql-engine
   (`orb-hasura-N :180NN`) pointed at that pg with the per-agent env. On
   teardown: `docker rm -f` both containers and delete the CoW data dir.
3. Wire `oa new` / `oa rm` to call the above so an agent gets its own pg +
   hasura automatically and cleans them up.
4. Confirm the host port scheme — hasura `:18081/2/3...`, pg `:15441/2/3...`
   (one of each per agent).

Note: hasura CLI is NO LONGER required in the base for provisioning, since we
clone instead of migrate. (CLI may still be wanted later for `pnpm migrate` /
`h:console` workflows inside an agent, but it is not needed to stand up the
engine.)

## Open questions carried over

- **auth_hook round-trip not yet tested live**: the agent VMs were not
  running a backend during the experiment. Wiring is correct, but verify a
  real GraphQL query flows through the auth hook into the in-VM backend once
  `pnpm b:dev` runs inside the VM.
- `HASURA_GRAPHQL_JWT_SECRET` vs `HASURA_GRAPHQL_AUTH_HOOK`: confirm which
  auth mode the backend expects locally (host stack uses AUTH_HOOK).
- Real secrets source (admin secret, jwt secret, API keys) for non-local
  use; `hasura/db:sync` pulls from staging.
- Disk/RAM growth once N backends + N hasuras run in parallel.

## Experiment cleanup

If the `orb-hasura-1/2` containers and `agent_1/2` databases from the
experiment are still around and you want them gone:

```bash
docker rm -f orb-hasura-1 orb-hasura-2 orb-hasura-3
docker exec shilo-postgres-1 psql -U postgres -c "DROP DATABASE agent_1;"
docker exec shilo-postgres-1 psql -U postgres -c "DROP DATABASE agent_2;"
docker exec shilo-postgres-1 psql -U postgres -c "DROP DATABASE agent_3;"
```
