# Terminal Model Experiment

Small side experiment for server-side terminal emulation.

Pipeline:

```text
node-pty -> @xterm/headless on server -> screen snapshot JSON -> browser renderer
```

The browser does not receive raw PTY bytes. It only receives cells, cursor, and size.

Run:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:7081
```

Optional command:

```bash
TERM_MODEL_CMD='orb -m shilo-agent-1 bash -lc "cd ~/projects/shilo-ai-mono && exec codex --yolo"' npm run dev
```

Next candidates:

- `@termless/core + @termless/xtermjs`: cleaner terminal-model API over `@xterm/headless`.
- `@termless/vt100`: pure TS, lighter, but less complete.
