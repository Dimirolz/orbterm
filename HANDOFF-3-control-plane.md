# Orb Agent Handoff 3 — Effect Control Plane

Continues from `HANDOFF.md` and `HANDOFF-2-hasura.md`.

## Direction

Move from `exp0` shell tooling toward a real control plane:

```text
Effect TS backend  -> owns agent lifecycle
React TS frontend  -> operator UI
oa CLI             -> discarded after exp0; not carried forward
```

Key decision: do **not** rewrite `oa` or keep it as a shim. `oa` proved the
workflow and commands, but after the experiment it is no longer needed. The
next stage should be a service because the future consumer is the
backend/control plane, not a human CLI.

## Target shape

Effect backend services:

```text
AgentService       create/delete/start/stop/list agents
MachineService     wraps orbctl/orb
HasuraService      per-agent hasura/db lifecycle
RepoService        repo/base update operations
JobService         long-running provisioning jobs + logs/status
```

API surface:

```text
GET    /agents
POST   /agents
DELETE /agents/:id
POST   /agents/:id/start
POST   /agents/:id/stop
POST   /agents/:id/doctor
POST   /agents/:id/hasura/up
POST   /agents/:id/hasura/down
GET    /jobs/:id
GET    /jobs/:id/logs
```

React frontend:

```text
- agent list with state/health
- create/delete/start/stop controls
- provisioning job progress + logs
- doctor/health check results
- links/actions for VS Code, shell, codex session where possible
```

## Design principles

- Shell commands live behind typed Effect services, not scattered through UI
  or handlers.
- Long operations are jobs with logs, status, and failure details.
- Errors are typed/domain-level where useful:
  `MachineNotFound`, `InvalidAgentNumber`, `CommandFailed`, `UserAborted`.
- Interactive operations (`shell`, `codex`) stay separate from normal RPC
  workflows because they need stdio/session passthrough.
- Drop `oa` entirely once its proven behavior has been ported into the
  backend services.

## Suggested sequence

1. Define the `Agent` model and persisted state.
2. Build Effect backend by porting the proven `oa` behavior.
3. Add minimal HTTP API for list/create/delete/start/stop.
4. Add job runner + log streaming for provisioning.
5. Build React dashboard on top.
6. Add Hasura lifecycle from `HANDOFF-2-hasura.md`.
7. Delete/archive `oa` after the service covers the exp0 workflows.

## Open questions

- Where should control-plane state live first: JSON file, SQLite, or Postgres?
- Should the backend run on the host Mac, inside OrbStack, or as a managed
  local service?
- What is the first UI action set: lifecycle only, or lifecycle + Hasura?
- How to expose interactive `codex`/shell sessions cleanly from the UI?
