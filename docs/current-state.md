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
- `Shift+Enter` in the web terminal is special-cased for Codex/crossterm (see below); verify behavior before touching.
- The project is still hardcoded for Shilo in `control-plane/server/src/config.ts`.
- `REPO_DIR` defaults to `~/projects/shilo-ai-mono` inside the VM.

## Shift+Enter in the Web Terminal

Codex is a crossterm TUI: it only distinguishes `Shift+Enter` (insert newline)
from `Enter` (submit) when the terminal supports the **kitty keyboard protocol**.
The browser collapses `Shift+Enter` to a bare CR, which Codex reads as submit, so
it required a three-layer fix — a one-line client tweak alone was not enough:

1. **Client** (`web/src/CodexTerminal.tsx`): on `Shift+Enter` keydown (no other
   modifiers) send the CSI-u press `\x1b[13;2u` and swallow the event, so
   crossterm decodes `Enter+SHIFT` instead of a CR.
2. **Server probe answer** (`server/src/Codex.ts`): Codex probes support with
   `CSI ? u`; xterm.js answers DSR/DA queries but never that one, so Codex
   concludes enhanced keys are unsupported and disables the mode entirely. The
   server scans live PTY output and replies `\x1b[?0u` ("protocol understood,
   no flags active") so Codex enables enhanced keys.
3. **Replay sanitation** (`server/src/Codex.ts`): on reconnect the whole output
   buffer is replayed; without stripping, xterm.js re-answers the original
   startup probes (`CSI 6n`, OSC 10/11 color, `CSI ?u`, `CSI c`) into a live
   Codex and corrupts its cursor state. `stripTerminalQueries` removes these
   invisible queries from the replay.

```text
client  Shift+Enter ───▶ \x1b[13;2u ──▶ server ──▶ pty ──▶ Codex (Enter+SHIFT)
server  Codex CSI ?u probe ──▶ reply \x1b[?0u (enables enhanced keys)
server  reconnect replay ──▶ strip CSI 6n / OSC 10,11 / CSI ?u / CSI c
```

Verify: restart the server (recreates the PTY), then in a running agent's
terminal type `hello` → `Shift+Enter` → `world`; plain `Enter` should submit one
message `hello\nworld`, and repeated `Shift+Enter` must never submit.

## Image Paste — Research (not yet implemented)

Goal: paste/drop an image in the web terminal and have Codex attach it.

Key finding: **Codex does NOT detect images from prompt text.** Bracketed-pasting
a path like `/tmp/foo.png` is treated as plain text. Attachment is a structured
UI action (`UserInput::LocalImage` + `[Image #N]` placeholder), triggered only by:

1. The `@` file-search popup: type `@<path>`, the popup surfaces the match, and
   accepting it (Tab/Enter) makes Codex run `image_dimensions()` and attach.
   Search is rooted at cwd (`REPO_DIR`), so the file must live under the repo,
   not `/tmp`.
2. `Ctrl+V` / `Alt+V` from the *system clipboard of the machine Codex runs on*
   (inside the VM) — not reachable from the browser.
3. Structured `UserInput::LocalImage` via Codex's app-server API — a different
   channel than the TUI/PTY, larger rework.

Supported formats (sniffed by bytes, not extension): PNG, JPEG, GIF, WebP.

Only viable PTY path today is option 1:

```text
browser paste blob ─▶ POST /api/agents/:n/upload ─▶ file in REPO_DIR/.keenterm-paste/x.png (in VM)
                                                 ─▶ pty: "@.keenterm-paste/x.png" + Tab/Enter
                                                                  └─▶ Codex popup attaches [Image #N]
```

Risks to resolve next session:
- Timing/race: must wait for the `@` popup to populate before sending Tab/Enter,
  with no TUI feedback over the PTY. Likely needs a small delay or retry.
- Confirm the `@` popup accepts repo-relative (and/or absolute) paths.
- Cleanup of uploaded temp files in the VM.
- Ignore the upload dir from git WITHOUT touching the project's committed
  `.gitignore`: add `.keenterm-paste/` to `.git/info/exclude` in the VM checkout
  (local, uncommitted). Do it once in the base VM so clones inherit it; otherwise
  the uploaded images pollute `git status` / agent diffs.
- Server upload endpoint: multipart/raw body, MIME allow-list (image/*), size cap;
  push into VM via `orb -m <machine>` (see `Machines.runInRepo` pattern).

Client hooks: DOM `paste`/`drop` listeners on the xterm container (read
`clipboardData.files` / `dataTransfer.files`), not `attachCustomKeyEventHandler`.

## Next Work

1. Externalize project config instead of hardcoding Shilo values.
2. Add a JobService for long operations and live logs.
3. Add base VM refresh/update flow.
4. Add quick links: backend app, Hasura, VS Code.
5. Add memory visibility and cleanup controls.
