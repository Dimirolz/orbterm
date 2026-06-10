// Persistent per-machine Codex pty sessions, ported from exp0.
//
// Deliberately imperative: interactive stdio passthrough is a separate concern
// from the RPC lifecycle (HANDOFF-3). Sessions survive websocket disconnects;
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
  working: boolean
  title: string
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

  const inner = `. ~/.asdf/asdf.sh && cd ${REPO_DIR} && exec codex --yolo`
  const term = pty.spawn("orb", ["-m", machine, "bash", "-lc", inner], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  })

  const session: Session = { term, buffer: "", clients: new Set(), carry: "", working: false, title: "" }

  term.onData((data) => {
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

  if (s.buffer) client.send(Buffer.from(s.buffer, "utf8"))
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
