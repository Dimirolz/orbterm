# Orb Agent Handoff 4 — exp4 Vertical Slice (end-to-end, validated)

Continues from `docs/handoffs/01-base.md`, `docs/handoffs/02-hasura.md`, `docs/handoffs/03-control-plane.md`.

## Goal

Close the two open questions left by handoff 02 by provisioning **one** agent
end-to-end as plain shell steps (later ported 1:1 into Effect services):

1. CoW golden from the **real** dev cluster (not a btrfs lab).
2. Live `auth_hook` round-trip with the backend running **inside the VM**.

Both proven. ✅

## Result (2026-06-09, on host OrbStack)

```diagram
shilo-postgres-1 (live, postgres:15, vol shilo_shilo_db_data, btrfs /dev/vdb1)
   │ docker stop (clean shutdown) → cp --reflink=always → docker start
   ▼
orb_pg volume:  /golden  (quiesced 2.5G snapshot, never run as agent)
   │ cp --reflink=always  (0.27s, ~0 disk)
   ▼
/agent_1  ──▶ orb-pg-1  :15441  (own postgres, 136 public tables, isolated)
   ▲
   │ PG_DATABASE_URL host.docker.internal:15441
orb-hasura-1  :18081  --memory 512m
   │ AUTH_HOOK → shilo-agent-1.orb.local:8010/auth/hasura
   ▼
shilo-agent-1 VM:  backend:web on :8010  (real .env, worker off)
```

### Validated facts

```text
golden reflink of 2.5G data dir         0.25s
agent_1 reflink clone of golden         0.27s
disk growth for golden + agent_1        ~3 MB physical (5G logical, CoW shared)
orb-pg-1 RAM idle                       ~42 MiB
orb-hasura-1 RAM (full metadata loaded) ~387 MiB (cap 512m)
agent_1 isolation                       mutation in agent_1 NOT visible in main
auth_hook round-trip                    WORKS (anonymous role applied live)
```

### The round-trip proof (the whole point of exp4)

Query to `orb-hasura-1` **without** admin secret → hasura calls the in-VM
backend `auth_hook` → backend returns `{"X-Hasura-Role":"anonymous"}` →
hasura serves the role-scoped schema:

```text
no admin secret (via auth_hook):  anonymous query_root = 1 field  (callByPk)
with admin secret (bypass hook):  admin query_root     = 502 fields
```

If the hook were unreachable, an unauthenticated request would error out
instead of cleanly resolving to the anonymous role. 1-vs-502 fields proves the
backend-in-VM was consulted and its role honored.

## Key new finding: `.orb.local` resolves from docker containers

Handoff 02's biggest open risk was DNS: can the host hasura **container** reach
`shilo-agent-N.orb.local:8010`? Initially **no** — the engine logged
`Temporary failure in name resolution` for `shilo-agent-1.orb.local`.

**After granting OrbStack the macOS local-network permission prompt**, docker
containers can resolve AND reach both `shilo-agent-1.orb.local:8010` and the
raw VM IP (`192.168.x.y:8010`). So **no `--add-host` is needed** — the
`AUTH_HOOK`/`API_URL`/`WEBHOOK_URL`/`VENDOR_API_URL` can use the stable
`.orb.local` name directly. (If a future container can't resolve it, fall back
to `--add-host shilo-agent-N.orb.local:<vm-ip>` from `orbctl`.)

## Exact commands that worked

Step 1 — golden (one-time, ~seconds of main downtime):

```bash
docker stop shilo-postgres-1
docker volume create orb_pg
docker run --rm -v shilo_shilo_db_data:/src:ro -v orb_pg:/dst debian:stable-slim \
  bash -c 'cp --reflink=always -a /src /dst/golden'
docker start shilo-postgres-1
```

Step 2 — per-agent CoW clone (no main downtime):

```bash
docker run --rm -v orb_pg:/dst debian:stable-slim \
  bash -c 'cp --reflink=always -a /dst/golden /dst/agent_1'
```

Step 3 — per-agent postgres:

```bash
docker run -d --name orb-pg-1 \
  -v orb_pg:/pgroot -e PGDATA=/pgroot/agent_1 \
  -e POSTGRES_PASSWORD=postgrespassword -p 15441:5432 postgres:15
```

Step 4 — per-agent hasura (env mirrored from `shilo-graphql-engine-1`, but
pointed at orb-pg-1 + the agent's VM; data-connector skipped):

```bash
docker run -d --name orb-hasura-1 --memory 512m -p 18081:8080 \
  -e PG_DATABASE_URL="postgres://postgres:postgrespassword@host.docker.internal:15441/postgres" \
  -e HASURA_GRAPHQL_METADATA_DATABASE_URL="postgres://postgres:postgrespassword@host.docker.internal:15441/postgres" \
  -e HASURA_GRAPHQL_ADMIN_SECRET="hasura_graphql_admin_secret" \
  -e HASURA_GRAPHQL_CORS_DOMAIN="*" \
  -e HASURA_GRAPHQL_EXPERIMENTAL_FEATURES="naming_convention" \
  -e HASURA_GRAPHQL_ENABLE_CONSOLE="false" \
  -e HASURA_GRAPHQL_DEV_MODE="true" \
  -e HASURA_GRAPHQL_AUTH_HOOK="http://shilo-agent-1.orb.local:8010/auth/hasura" \
  -e API_URL="http://shilo-agent-1.orb.local:8010" \
  -e WEBHOOK_URL="http://shilo-agent-1.orb.local:8010" \
  -e VENDOR_API_URL="http://shilo-agent-1.orb.local:8010/graphql" \
  hasura/graphql-engine:v2.40.0
```

Step 5 — agent VM backend (real `.env` copied from the Mac dev checkout,
`apps/backend/.env`, with overrides):

```text
HASURA_URL=http://host.docker.internal:18081           # agent's own hasura
UPSTASH_REDIS_URL=redis://host.docker.internal:6379    # else /graphql hangs
UPSTASH_REDIS_CACHE_URL=redis://host.docker.internal:6379
TEMPORAL_WORKER_ENABLED=false                          # avoid worker side effects
# run web only:  pnpm backend:web   (NOT the worker)
```

Port defaults to 8010 (`PORT`, config `cfg.port`). The `/auth/hasura` endpoint
returns `{"X-Hasura-Role":"anonymous"}` with no `authorization` header — so the
round-trip is provable WITHOUT firebase secrets.

## Gotchas found in exp4

```text
- Backend dev .env points WRITE_DB/READONLY_DB at NEON PROD (shilo_prod_db),
  while HASURA_URL points at the local hasura. For a throwaway agent this means
  the backend talks to prod DB directly unless overridden. exp4 only used the
  anonymous (read-nothing) auth path + worker OFF, so prod was not mutated.
  TODO: point WRITE_DB/READONLY_DB at the agent's own pg for true isolation
  (needs schema-compat check: agent pg = clone of shilo-postgres-1, which may
  differ from the Neon prod schema).
- data-connector-agent is NOT required per agent; the engine starts fine
  without it (only the athena/mysql/etc connectors would be unavailable,
  which the metadata does not use here).
```

### vendorApi remote schema timeout — root cause = Redis (RESOLVED)

The `vendorApi` inconsistency was NOT an auth/hasura problem. `vendorApi` is
the backend's OWN GraphQL endpoint (`/graphql`, a GraphQL Yoga server in
NestJS, see `apps/backend/src/@modules/graphql/graphql.module.ts`) that hasura
stitches in as a remote schema (`VENDOR_API_URL`).

Why it hung:

```text
hasura introspects VENDOR_API_URL=/graphql
  -> Yoga runs the useResponseCache plugin on EVERY request
    -> plugin hits Redis (GraphqlCacheService, lib/redis.ts)
      -> Redis URL was redis://127.0.0.1:6379 (inside the VM = nothing there)
        -> ioredis reconnects forever -> /graphql hangs -> hasura times out
```

`/auth/hasura` does not use the cache plugin, which is exactly why the auth
round-trip worked while `/graphql` hung.

Fix: set BOTH `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_CACHE_URL` to
`redis://host.docker.internal:6379` (host.docker.internal resolves to
`0.250.250.254` from the VM; 6379 reachable). After a clean restart:
`/graphql` returns in ~25 ms with `responseCache.didCache:true`, and
`reload_metadata` → **0 inconsistent objects** (vendorApi + all ~16 remote
relationships consistent).

Note: ioredis defaulting to `127.0.0.1:6379` is the tell-tale of an EMPTY
config value, not a wrong host (figue throws if the env is missing, so the
value was present-but-localhost from .env). host.docker.internal errors would
show `0.250.250.254`, not `127.0.0.1`.

### Per-agent Redis (decided, validated)

There is NO BullMQ anymore (background work moved to Temporal). Redis
(`apps/backend/src/lib/redis.ts`) is still used for shared state via two
ioredis connections:

```text
redisConnection      ("Redis Queue" — legacy name): distributed locks
                      (lock.repository.ts, SET NX PX + Lua release)
redisCacheConnection ("Redis Cache"): GraphQL response cache, external-api
                      + FUB rate limiting, vendor/FUB caches, chatkit session
```

A SHARED host Redis still breaks isolation on three fronts:

```text
- caches are query/session keyed, NOT agent-scoped -> agent_1 (its own cloned
  DB) caches a result that agent_2 would then read = wrong data.
- distributed locks share a namespace -> agent_1 holding a lock blocks the
  same scheduled task on agent_2.
- rate-limit counters pool across agents -> agent_1's calls eat agent_2's budget.
```

So each agent gets its OWN ephemeral Redis, mirroring orb-pg-N / orb-hasura-N:

```bash
docker run -d --name orb-redis-1 --memory 128m -p 16391:6379 \
  redis:7-alpine redis-server --save "" --appendonly no
# agent .env: UPSTASH_REDIS_URL=UPSTASH_REDIS_CACHE_URL=redis://host.docker.internal:16391
```

Validated: ~5.3 MiB RAM idle (rounding error vs hasura's ~390 MiB), instant
start, no disk/golden needed (everything in Redis is now ephemeral/regenerable
— caches, locks, rate-limit counters; no persistent queues). End-to-end: agent
backend wrote its cache key to its own orb-redis-1 (`dbsize=1`), `/graphql` 20 ms.

Rejected alternatives: shared Redis + logical DB index (caps at 16 agents,
and keyv/lock keys would need per-agent DB selection); shared Redis + global
keyPrefix (needs repo code changes).

Port scheme now per agent: pg `:154NN`, hasura `:180NN`, redis `:163NN`.

### Process-persistence gotcha (matters for the control plane)

A backgrounded `pnpm backend:web` survives the `orb` session, but a stale
nodemon keeps holding port 8010 and keeps retrying its OLD Redis config. A
naive "restart" then fails to truly rebind, and the log still shows the old
boot lines — making it look like edits had no effect. Reliable restart =
hard-kill the old process first (`pkill -9 -f app.ts` / nodemon), confirm 8010
is free, then launch with `setsid bash -c '... ' </dev/null & disown`. This
becomes `AgentService.restart` in the control plane.

## What this unblocks for the control plane

Every step above is a deterministic shell command → maps cleanly onto Effect
services:

```text
HasuraService.up(n)   = reflink golden->agent_n + run orb-pg-n + orb-redis-n + orb-hasura-n
HasuraService.down(n) = docker rm -f orb-pg-n orb-redis-n orb-hasura-n + rm CoW data dir
MachineService        = orbctl clone/start/stop (already proven in oa)
AgentService.create   = clone VM + write per-agent .env + HasuraService.up
RepoService           = base build/update (already in oa)
```

Golden lifecycle (refresh periodically from `shilo-postgres-1`) is its own
small job: stop main → reflink to a fresh `/golden` → start main.

## Current experiment state (left running)

```text
machines:   shilo-agent-base (running), shilo-agent-1 (running, backend on :8010)
containers: orb-pg-1 (:15441), orb-redis-1 (:16391), orb-hasura-1 (:18081)
volumes:    orb_pg  (/golden, /agent_1)
```

### Cleanup (when done)

```bash
orb -m shilo-agent-1 bash -lc 'pkill -f backend:web' || true
docker rm -f orb-hasura-1 orb-pg-1 orb-redis-1
docker run --rm -v orb_pg:/d alpine sh -c 'rm -rf /d/agent_1'   # keep /golden
# full reset: docker volume rm orb_pg ; orbctl delete shilo-agent-1
```

## Open questions carried forward

- ~~Real data isolation for the backend's **direct** DB layer (not just hasura):
  point WRITE_DB/READONLY_DB at the agent pg, verify schema compatibility.~~
  **RESOLVED (handoff 06, 2026-06-12):** agent .env is generated by the control
  plane with WRITE_DB/READONLY_DB -> agent pg; schema diff vs Neon prod = 3
  tables unused by backend code. Also note: the backend is NOT auto-started by
  the control plane — the agent (codex) starts it itself when needed.
- Golden refresh cadence + how to quiesce main with minimal downtime at scale.
- Port allocation scheme in the control plane (pg `:154NN`, hasura `:180NN`).
- RAM/disk growth with N parallel agents (1 pg + 1 hasura + 1 backend each).
</content>
</invoke>
