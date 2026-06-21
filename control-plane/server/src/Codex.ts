// Persistent per-machine Codex pty sessions.
//
// Deliberately imperative: interactive stdio passthrough is a separate concern
// from the RPC lifecycle. Sessions survive websocket disconnects;
// output is buffered and replayed on reconnect.

import pty from "node-pty"
import { REPO_DIR } from "./config.js"

const BUFFER_CAP = 8 * 1024 * 1024 // ~8 MB replayable output per session

// Codex signals "working" by prefixing the terminal title (OSC 0/1/2) with a
// braille spinner glyph (U+2800–U+28FF). No spinner -> idle / done.
const OSC_TITLE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** Transport-agnostic terminal client (the websocket lives in main.ts). */
export interface TermClient {
  readonly send: (data: string | Uint8Array) => void
  readonly close: () => void
}

interface Session {
  term: pty.IPty
  buffer: string
  clients: Set<TermClient>
  carry: string
  probeCarry: string
  working: boolean
  title: string
}

// Codex probes for kitty keyboard protocol support by writing `CSI ? u`. xterm.js
// answers DSR/DA queries but not this one, so Codex concludes enhanced keys are
// unsupported and never enables the mode that distinguishes Shift+Enter from a
// bare Enter. Answer it ourselves (flags = 0: "protocol understood, none active")
// so Codex enables enhanced keys and accepts our CSI-u Shift+Enter sequence.
const KITTY_QUERY = "\x1b[?u"
const KITTY_QUERY_REPLY = "\x1b[?0u"

function answerKeyboardProbe(s: Session, data: string) {
  const combined = s.probeCarry + data
  let from = 0
  for (;;) {
    const idx = combined.indexOf(KITTY_QUERY, from)
    if (idx === -1) break
    s.term.write(KITTY_QUERY_REPLY)
    from = idx + KITTY_QUERY.length
  }
  s.probeCarry = combined.slice(-(KITTY_QUERY.length - 1)) // keep tail for split seqs
}

// On reconnect the whole output buffer is replayed; without this, xterm.js would
// re-answer the original startup probes (cursor position, colors, device attrs)
// and inject stale responses into a Codex that finished probing long ago, which
// corrupts its input/cursor state. These are invisible queries, safe to drop.
function stripTerminalQueries(data: string): string {
  return data
    .replace(/\x1b\[6n/g, "") // cursor position report
    .replace(/\x1b\]1[01];\?(?:\x07|\x1b\\)/g, "") // OSC 10/11 color queries
    .replace(/\x1b\[\?u/g, "") // kitty keyboard query
    .replace(/\x1b\[c/g, "") // primary device attributes
}

const sessions = new Map<string, Session>()

function detectStatus(s: Session, data: string) {
  s.carry += data
  const matches = [...s.carry.matchAll(OSC_TITLE)]
  if (matches.length) {
    const last = matches[matches.length - 1]
    const title = last[1]
    const first = [...title.trimStart()][0]
    const cp = first ? first.codePointAt(0)! : 0
    const working = cp >= 0x2800 && cp <= 0x28ff
    s.carry = s.carry.slice(last.index + last[0].length)
    s.title = title
    if (working !== s.working) {
      s.working = working // only broadcast on the work/idle transition
      broadcastStatus(s)
    }
  }
  if (s.carry.length > 512) s.carry = s.carry.slice(-512) // bound for split seqs
}

function broadcastStatus(s: Session) {
  const msg = JSON.stringify({ type: "status", working: s.working, title: s.title })
  for (const client of s.clients) client.send(msg)
}

function getSession(machine: string): Session {
  let s = sessions.get(machine)
  if (s) return s

  const inner = [
    ". ~/.asdf/asdf.sh",
    "if command -v Xvfb >/dev/null; then",
    "  export DISPLAY=:77",
    "  test -S /tmp/.X11-unix/X77 || (rm -f /tmp/.X77-lock; Xvfb :77 -screen 0 1024x768x24 >/tmp/keenterm-xvfb.log 2>&1 &)",
    "  for i in $(seq 1 20); do test -S /tmp/.X11-unix/X77 && break; sleep 0.1; done",
    "fi",
    `cd ${REPO_DIR}`,
    "exec codex --yolo",
  ].join("\n")
  const term = pty.spawn("orb", ["-m", machine, "bash", "-lc", inner], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  })

  const session: Session = { term, buffer: "", clients: new Set(), carry: "", probeCarry: "", working: false, title: "" }

  term.onData((data) => {
    answerKeyboardProbe(session, data)
    session.buffer += data
    if (session.buffer.length > BUFFER_CAP) session.buffer = session.buffer.slice(-BUFFER_CAP)
    detectStatus(session, data)
    // terminal output as binary; control/status frames are sent as text JSON
    const bin = Buffer.from(data, "utf8")
    for (const client of session.clients) client.send(bin)
  })

  term.onExit(({ exitCode }) => {
    console.log(`[pty:${machine}] exit ${exitCode}`)
    for (const client of session.clients) client.close()
    sessions.delete(machine)
  })

  sessions.set(machine, session)
  console.log(`[pty:${machine}] spawned codex`)
  return session
}

export function killSession(machine: string): boolean {
  const s = sessions.get(machine)
  if (!s) return false
  s.term.kill()
  sessions.delete(machine)
  return true
}

export function sessionStatus(machine: string): { codex: boolean; working: boolean } {
  const s = sessions.get(machine)
  return { codex: !!s, working: s?.working ?? false }
}

/** Attach a client to the (possibly new) session. Returns transport callbacks. */
export function attach(machine: string, client: TermClient) {
  const s = getSession(machine)
  s.clients.add(client)
  console.log(`[term] ${machine} connected (${s.clients.size} client(s))`)

  const replay = stripTerminalQueries(s.buffer)
  if (replay) client.send(Buffer.from(replay, "utf8"))
  client.send(JSON.stringify({ type: "status", working: s.working, title: s.title }))

  return {
    onMessage: (raw: string) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number }
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === "input" && typeof msg.data === "string") s.term.write(msg.data)
      else if (msg.type === "resize" && msg.cols && msg.rows) s.term.resize(msg.cols, msg.rows)
    },
    detach: () => {
      s.clients.delete(client)
      console.log(`[term] ${machine} disconnected (pty alive, ${s.clients.size} left)`)
    },
  }
}
