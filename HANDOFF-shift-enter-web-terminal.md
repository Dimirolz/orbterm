# Shift+Enter in web Codex terminal

## Current situation

- In normal terminals, Codex behaves correctly:
  - VS Code terminal: `Shift+Enter` inserts a new line and moves cursor correctly.
  - Ghostty: `Shift+Enter` inserts a new line and moves cursor correctly.
- In our web UI terminal, `Shift+Enter` is broken.

## Web UI symptoms

- Earlier attempt with `CSI 13;2u`:
  - Codex inserted a multiline/new line.
  - Cursor stayed visually at the top / wrong line.
- Attempt with bracketed paste newline:
  - Sequence: `\x1b[200~\n\x1b[201~`
  - Bad behavior:
    - adds multiline on repeated `Shift+Enter`
    - cursor jumps to beginning/top of input
    - if input already has text, `Shift+Enter` can submit instead of inserting newline
- Current working tree attempt:
  - File: `control-plane/web/src/CodexTerminal.tsx`
  - Sequence: `\x1b[13;2:1u\x1b[13;2:3u`
  - Intended as crossterm enhanced keyboard `Shift+Enter` press + release.
  - User reports web UI is still broken.

## Relevant code

`control-plane/web/src/CodexTerminal.tsx`

```ts
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey) {
    sendInput('\x1b[13;2:1u\x1b[13;2:3u')
    return false
  }
  return true
})
```

## Notes

- Codex CLI is a crossterm/ratatui TUI and appears to support the `shift-enter` key name.
- `strings` on the Codex binary showed:
  - `shift-enter`
  - `PushKeyboardEnhancementFlags`
  - `EnableBracketedPaste`
- Crossterm parses CSI-u:
  - `ESC [ 13 ; 2 u` as `Shift+Enter`
  - `ESC [ 13 ; 2 : 1 u` as press
  - `ESC [ 13 ; 2 : 3 u` as release

## Likely direction

- Stop guessing terminal sequences from the browser side.
- Compare exact bytes produced by Ghostty/VS Code terminal for `Shift+Enter` against bytes sent by our web UI.
- Possible ways:
  - run a small raw-input byte dumper inside the VM/pty
  - press `Shift+Enter` in Ghostty/VS Code and record bytes
  - send same bytes from web UI
- If exact byte emulation still fails, the issue may be xterm.js / pty redraw interaction rather than Codex key parsing.

## Verification so far

- Frontend checks passed after the latest attempt:
  - `pnpm --dir control-plane --filter web lint`
  - `pnpm --dir control-plane --filter web build`

## Git state

- Last committed cleanup:
  - `dfbf856 Clean unused UI API surface`
- Current uncommitted change:
  - `control-plane/web/src/CodexTerminal.tsx`
