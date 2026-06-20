# Current State

## What Works

- `control-plane/server`: Effect TS HTTP server on `:7070`.
- `control-plane/web`: React/Vite operator UI.
- Agents are OrbStack VMs named `shilo-agent-N`, cloned from `shilo-agent-base`.
- The web UI can create, start, stop, delete, select agents, open Codex TUI, and view diffs.
- Codex sessions are server-owned PTYs with buffered replay after websocket reconnect.
- Stack repair runs docker compose inside the VM via `POST /api/agents/:n/stack/up`.

## Architecture

```text
web UI
  -> REST /api/agents
  -> websocket /term?machine=shilo-agent-N

server
  Agents      lifecycle + diff
  Machines    orbctl/orb wrapper
  VmStack     VM-local docker compose status/up
  Codex       persistent PTY sessions
```

State is derived live from `orbctl`, docker-in-VM, and PTY sessions. There is no DB.

## VM Stack

Current direction: dependencies run inside each agent VM, not as host-managed per-agent containers.

`VmStack.up(n)`:

- starts `hasura/docker compose` services: `postgres`, `graphql-engine`;
- caps `shilo-graphql-engine-1` memory;
- waits for Hasura metadata consistency;
- starts backend deps from `apps/backend/docker compose`: redis + temporal by default.

Configured by:

- `ORB_HASURA_SERVICES` default `postgres graphql-engine`
- `ORB_BACKEND_DEP_SERVICES` default `redis-queue redis-cache temporal`

## API

```text
GET    /api/agents
POST   /api/agents
DELETE /api/agents/:n
POST   /api/agents/:n/start
POST   /api/agents/:n/stop
POST   /api/agents/:n/stack/up
GET    /api/agents/:n/diff/status
GET    /api/agents/:n/diff
GET    /term?machine=shilo-agent-N
```

## Run

```sh
pnpm --dir control-plane install
pnpm --dir control-plane --filter server check
pnpm --dir control-plane dev:server
pnpm --dir control-plane dev:web
```

Dev ports:

- server: `7070`
- web: Vite default or next free port

## Known Gotchas

- Do not attach a separate `ws` server to the Effect HTTP server; use `HttpServerRequest.upgrade`.
- `CodexTerminal` has a ResizeObserver guard around `fit.proposeDimensions()`; removing it can trigger an xterm resize loop.
- `Shift+Enter` in the web terminal is special-cased for Codex/crossterm; verify behavior before touching.
- The project is still hardcoded for Shilo in `control-plane/server/src/config.ts`.
- `REPO_DIR` defaults to `~/projects/shilo-ai-mono` inside the VM.

## Next Work

1. Externalize project config instead of hardcoding Shilo values.
2. Add a JobService for long operations and live logs.
3. Add base VM refresh/update flow.
4. Add quick links: backend app, Hasura, VS Code.
5. Add memory visibility and cleanup controls.
