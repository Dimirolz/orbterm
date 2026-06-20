# Orb Agent Handoff 5 — Control Plane MVP (in progress)

Continues from `docs/handoffs/03-control-plane.md` (direction) and
`docs/handoffs/04-vertical-slice.md` (validated shell steps). Experiments are DONE;
this is the build phase: **Effect TS backend + React UI**, replacing `oa`.

## Decisions locked in this session

```text
package manager   pnpm (workspace: control-plane/{server,web}); NOT bun
state             derived live from orbctl + pty sessions; nothing persisted
runtime           node 22 (host Mac), tsx for dev
terminal          server-owned pty per
                  machine, buffered+replayed over websocket; codex included
                  in the first slice
ws transport      Effect-idiomatic: HttpServerRequest.upgrade + Socket.
                  IMPORTANT: do NOT attach an external `ws` WebSocketServer to
                  the same http server — NodeHttpServer installs its own
                  upgrade handler; two handlers corrupt frames
                  ("RSV1 must be clear").
macOS gotcha      no setsid; background the dev server with
                  (nohup npx tsx src/main.ts </dev/null >/tmp/orb-cp.log 2>&1 &)
```

## Code layout (all new, in `control-plane/`)

```text
control-plane/
  package.json            pnpm workspace root (dev:server / dev:web scripts)
  pnpm-workspace.yaml     packages: server, web; onlyBuiltDependencies: node-pty, esbuild
  server/                 Effect backend (effect 3.21, @effect/platform 0.96,
                          @effect/platform-node 0.107, node-pty)
    src/config.ts         PORT 7070, PREFIX shilo-agent-, BASE shilo-agent-base, REPO_DIR
    src/Machines.ts       Machines service: typed orbctl/orb wrapper via
                          Command/CommandExecutor; CommandFailed domain error
                          (PlatformError -> defect); list parses `orbctl list -f json`
    src/Codex.ts          imperative pty session manager:
                          Map<machine, Session>, 8MB replay buffer, OSC-title
                          braille-spinner "working" detection, transport-agnostic
                          TermClient interface { send, close }
    src/Agents.ts         Agents service: list (derive orbctl+sessions),
                          create (next free n, clone base, start), start/stop/
                          remove (kills pty first), stopCodex, doctor;
                          MachineNotFound error
    src/main.ts           HttpRouter REST + GET /term websocket upgrade route
                          (socket.runRaw blocks for session; writer via
                          Runtime.runFork; Socket.CloseEvent to close);
                          HttpRouter.catchTags -> JSON error responses
  web/                    Vite + React 19 + TS (+ @xterm/xterm 6, addon-fit)
    vite.config.ts        proxy /api -> :7070, /term -> ws :7070     [DONE]
    src/api.ts            fetch client + AgentInfo type              [DONE]
    src/CodexTerminal.tsx xterm component: ws binary frames -> term.write,
                          term.onData -> {type:input}, ResizeObserver -> fit +
                          {type:resize}; status text frames ignored (poll covers)
                          [DONE]
    src/App.tsx           NOT STARTED (still vite boilerplate)
    src/index.css/App.css NOT STARTED (still boilerplate)
```

## API (implemented and verified by curl)

```text
GET    /api/agents                 [{n,name,state,codex,working}]  ✅
POST   /api/agents                 clone base->next free n, start  ✅ (created agent-1)
DELETE /api/agents/:n              kill pty, stop, delete          (implemented, NOT yet exercised)
POST   /api/agents/:n/start        ✅
POST   /api/agents/:n/stop         kills pty first                 ✅
POST   /api/agents/:n/codex/stop   ✅
POST   /api/agents/:n/doctor       node/pnpm/codex/gh/repo + host ports, all green ✅
GET    /term?machine=shilo-agent-N websocket: binary = terminal bytes,
                                   text JSON = {type:status,working,title};
                                   client sends {type:input,data} / {type:resize,cols,rows} ✅
404 -> {"error":"shilo-agent-9 does not exist"}                    ✅
```

## Verification already performed (don't redo)

```text
- tsc --noEmit clean (pnpm --filter server check)
- node-pty loads + spawns on host
- full pty round-trip: connect -> codex TUI bytes stream; reconnect ->
  buffer replayed; resize -> SIGWINCH redraw; input -> typed
  "hello from control plane" visible in codex composer (gpt-5.5,
  ~/projects/shilo-ai-mono); session survives ws disconnect (codex:true in list)
- codex on first run shows an "Update available 0.137->0.139" arrow-key menu
  (letters don't echo there — not a bug; option 2 = Skip)
- stop kills pty + VM (state stopped, codex:false); start brings VM back
```

## Current live state

```text
machines:  shilo-agent-base (stopped, golden), shilo-agent-1 (running, created
           via the API; codex session may have been killed by the stop test)
server:    dev instance may still be running on :7070
           (kill: lsof -ti :7070 | xargs kill)
log:       /tmp/orb-cp.log
```

## Next steps (in order)

1. **web/src/App.tsx + css** — build the React operator UI: sidebar with agent rows
   (state dot, codex badge idle/work-pulse), poll `/api/agents` every 2s,
   actions new/start/stop/rm/doctor (doctor output in an overlay <pre>),
   main pane = CodexTerminal for the selected running agent, notice+start
   button for stopped ones.
   Consider removing React.StrictMode (double ws connect in dev is noisy).
2. Verify in browser: pnpm dev:server + pnpm dev:web, create/select agent,
   codex terminal interactive, scrollback survives tab switch (server replay).
3. Exercise DELETE /api/agents/:n once; leave one fresh agent for play.
4. Then (later iterations, from handoff 04): HasuraService per-agent
   pg/redis/hasura up/down (reflink golden, ports pg :154NN hasura :180NN
   redis :163NN), golden refresh job, JobService with log streaming for
   long provisioning ops.
```
