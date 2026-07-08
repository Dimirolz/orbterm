# Current State

## What Works

- `server`: Effect TS HTTP server on `:7070`.
- `web`: React/Vite operator UI.
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
POST   /api/sidequests
GET    /term?machine=shilo-agent-N
```

## Run

```sh
pnpm install
pnpm --filter server check
bun dev
```

Dev ports:

- server: `7070`
- web: `5173`

Sidequest helpers:

```sh
ORBTERM_HOST=http://host.orb.internal:7070 scripts/orbterm-sidequest "prompt"
node scripts/orbterm-mcp.mjs
```

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

## Image Paste — Clipboard Bridge PoC

Goal: paste an image in the web terminal and have Codex attach it.

Prerequisites in every agent/base VM:

```sh
sudo apt-get install -y xvfb xclip
```

The `@` picker path was rejected:
- `@<uuid>.png` produced "no matches" because the file was in a subdir.
- `@.orbterm-paste/<uuid>.png` hung on "loading" because the dir was hidden and
  in `.git/info/exclude`; Codex's picker appears to respect ignore/hidden rules.
- `@/tmp/...` produced "no matches"; the picker appears repo-rooted.
- Visible repo dirs are not acceptable because they pollute the project tree.

Current PoC uses a headless Linux clipboard inside the VM:
- Server `POST /api/agents/:n/upload` (`main.ts`): raw image bytes in the body →
  `Agents.uploadImage` → `Machines.setClipboardImage`.
- `Machines.setClipboardImage`: starts `Xvfb :77` if needed, writes the image to
  `/tmp/orbterm-paste/<uuid>.<ext>`, then runs `xclip -selection clipboard -t
  image/png -i <path>` inside that display.
- `Codex.ts`: starts Codex with `DISPLAY=:77` when Xvfb is available.
- Client (`web/src/CodexTerminal.tsx`): a DOM `paste` listener on the xterm
  container uploads the image, then sends Ctrl+V (`\x16`) to the TUI.
- `web/src/api.ts`: `api.uploadImage(n, blob)`.

PoC prerequisite inside the VM: `xvfb` and `xclip`.

Original research below.

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

Rejected PTY picker path:

```text
browser paste blob ─▶ POST /api/agents/:n/upload ─▶ file in /tmp/orbterm-paste/x.png (in VM)
                                                 ─▶ pty: "@/tmp/orbterm-paste/x.png" + Tab/Enter
                                                                  └─▶ Codex popup attaches [Image #N]
```

Risks:
- Need to bake/install `xvfb` and `xclip` into the base VM.
- Verify Codex's Linux clipboard reader accepts the Xvfb clipboard when run with
  `DISPLAY=:77`.
- Cleanup of uploaded temp files in the VM.
- Do not write uploads into the repo tree.
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

## Handoff: Agent3 Image Paste Failure

Date: 2026-06-21.

User saw on agent3:

```text
Failed to paste image: clipboard unavailable: Unknown error while interacting with the clipboard: X11 server connection timed out because it was unreachable
```

Findings:

- `shilo-agent-3` is running.
- `xvfb` and `xclip` are installed in agent3.
- `Xvfb :77` was not initially running.
- Old code used `pgrep -f 'Xvfb :77'`; this can match the shell command itself,
  so Xvfb is skipped.
- Patched locally, not committed yet:
  - `server/src/Codex.ts`: start Xvfb by checking `/tmp/.X11-unix/X77`.
  - `server/src/Machines.ts`: same socket check, plus `test -s <path>`, plus
    `(pkill -x xclip ... || true)`.
- Manual start fixed X11 on agent3:

```sh
orb -m shilo-agent-3 bash -lc 'export DISPLAY=:77; test -S /tmp/.X11-unix/X77 || (rm -f /tmp/.X77-lock; Xvfb :77 -screen 0 1024x768x24 >/tmp/orbterm-xvfb.log 2>&1 &)'
```

Second issue:

- `/tmp/orbterm-paste/*.png` on agent3 are 0 bytes.
- `curl --data-binary @/tmp/orbterm-test.png ... /api/agents/3/upload` returned
  `200`, but the new VM file was still 0 bytes.
- Direct `Machines.setClipboardImage(...)` via `tsx` also returned `ok`, but
  wrote 0 bytes.
- Likely problem: `Sh.runWithInput` / `Command.feed` is not getting stdin through
  to `orb -m ... bash -lc 'base64 -d > file'`.

Next exact steps:

1. Reproduce `Command.feed` locally with `Effect.scoped`.
2. If local feed works, replace image transfer with a no-stdin path, e.g.
   `python3 -c 'import base64,sys; open(path,"wb").write(base64.b64decode(sys.argv[1]))' "$base64"`.
3. Restart server on `:7070`.
4. Test:

```sh
curl -sS -i -X POST --data-binary @/tmp/orbterm-test.png \
  -H 'content-type: image/png' \
  http://localhost:7070/api/agents/3/upload

orb -m shilo-agent-3 bash -lc \
  'find /tmp/orbterm-paste -maxdepth 1 -type f -printf "%T@ %s %p\n" | sort -n | tail -5; DISPLAY=:77 xclip -selection clipboard -t TARGETS -o'
```

Success criteria:

- newest file in `/tmp/orbterm-paste` is non-empty;
- `xclip TARGETS` includes `image/png`;
- web paste sends Ctrl+V and Codex attaches `[Image #N]`.
