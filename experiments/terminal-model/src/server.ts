import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

const PORT = Number(process.env.PORT || 7081);
const COLS = Number(process.env.TERM_COLS || 100);
const ROWS = Number(process.env.TERM_ROWS || 30);
const CMD =
  process.env.TERM_MODEL_CMD ||
  "bash -lc 'printf \"server-side terminal model experiment\\n\\n\"; i=0; while true; do printf \"tick %04d  %s\\n\" \"$i\" \"$(date)\"; i=$((i+1)); sleep 1; done'";

type Cell = {
  ch: string;
  width: number;
  fg?: number;
  bg?: number;
  bold?: boolean;
  italic?: boolean;
  inverse?: boolean;
};

type Snapshot = {
  type: "snapshot";
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  lines: Cell[][];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/model" });
const clients = new Set<WebSocket>();

const model: HeadlessTerminal = new Terminal({
  cols: COLS,
  rows: ROWS,
  scrollback: 1000,
  allowProposedApi: true,
});

const shell = pty.spawn("bash", ["-lc", CMD], {
  name: "xterm-256color",
  cols: COLS,
  rows: ROWS,
  env: { ...process.env, TERM: "xterm-256color" },
});

let dirty = true;
let lastSent = "";

shell.onData((data) => {
  model.write(data);
  dirty = true;
});

shell.onExit(({ exitCode }) => {
  console.log(`[pty] exit ${exitCode}`);
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(snapshot()));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as { type?: string; data?: string };
    if (msg.type === "input" && typeof msg.data === "string") shell.write(msg.data);
  });

  ws.on("close", () => clients.delete(ws));
});

setInterval(() => {
  if (!dirty || clients.size === 0) return;
  dirty = false;
  const payload = JSON.stringify(snapshot());
  if (payload === lastSent) return;
  lastSent = payload;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}, 33);

function snapshot(): Snapshot {
  const buffer = model.buffer.active;
  const base = buffer.baseY;
  const cursorY = buffer.cursorY;
  const cursorX = buffer.cursorX;
  const cell = buffer.getNullCell();

  const lines: Cell[][] = [];
  for (let y = 0; y < model.rows; y += 1) {
    const line = buffer.getLine(base + y);
    const row: Cell[] = [];
    for (let x = 0; x < model.cols; x += 1) {
      line?.getCell(x, cell);
      row.push({
        ch: cell.getChars() || " ",
        width: cell.getWidth(),
        fg: cell.getFgColor(),
        bg: cell.getBgColor(),
        bold: Boolean(cell.isBold()),
        italic: Boolean(cell.isItalic()),
        inverse: Boolean(cell.isInverse()),
      });
    }
    lines.push(row);
  }

  return {
    type: "snapshot",
    cols: model.cols,
    rows: model.rows,
    cursor: { x: cursorX, y: cursorY },
    lines,
  };
}

server.listen(PORT, () => {
  console.log(`terminal model experiment on http://localhost:${PORT}`);
  console.log(`command: ${CMD}`);
});
