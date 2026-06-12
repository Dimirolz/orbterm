# QoL roadmap for day-to-day agent work

Дата: 2026-06-12.

## Цель

Сделать control panel не только VM launcher, а лёгкий workbench для агентной
разработки без обязательного VS Code Remote на каждый агент.

## Ближайшие действия

1. **Quick links в строке агента**
   - web app: `http://shilo-agent-N.orb.local:<web-port>`
   - backend: `http://shilo-agent-N.orb.local:8010`
   - VS Code Remote: memory-heavy escape hatch
   - позже: Hasura/Temporal links, но они менее важны для everyday web work.

2. **Diff viewer в UI**
   - API:
     - `GET /api/agents/:n/diff` -> `git diff --patch --stat`
     - `GET /api/agents/:n/files` -> `git diff --name-status`
   - UI:
     - left: changed files tree/list
     - right: rendered patch
   - Candidate libs:
     - `@pierre/trees` — https://trees.software/
     - `@pierre/diffs` — https://diffs.com/
   - Rationale: lightweight review without opening VS Code Remote.

3. **Fork agent**
   - `clone shilo-agent-N -> next free agent`
   - warn/disable when Codex is `working=true`
   - default child state: stopped.

4. **Stop controls**
   - stop selected
   - stop all idle
   - memory-friendly cleanup workflow.

5. **Memory visibility**
   - per-agent rough memory from `free` / `docker stats`
   - show warning around high pressure / many running agents.

## Hotkeys

Use `@tanstack/hotkeys` after the main views exist.

Candidate vim-like bindings:

```text
j/k       next/prev agent
enter     select/open agent
n         new agent
s         start/stop selected
d         diff selected
w         open web
b         open backend
c         open VS Code
x         stop selected
?         hotkey help
esc       close overlay
```

Important rule: disable app-level hotkeys while the Codex terminal or any input
has focus, except maybe `esc`.

## Notes

- Web/app links are higher priority than Hasura/Temporal links.
- VS Code is useful but expensive in RAM; diff viewer should cover the common
  “what changed?” workflow.
- Keep UI dense and operational, not landing-page-like.
