# keen.fleet Agent Handoff

## Status (Experiment 1 DONE)

Clean Shilo base VM built and frozen. Fast clone verified end-to-end.

Decisions locked in:

```text
repo slug      ShiloAI/shilo-ai-mono  (branch: dev)
node           asdf v0.15.0 -> Node 22.22.0  (matches local)
pnpm           10.16.0 via corepack
pnpm install   baked into base
turbo build    packages + backend baked (.turbo cache warm)
hasura         per-agent, SEPARATE experiment (next)
--isolated     KEEP (does NOT block host.docker.internal; only isolate_network does)
~/projects mnt REMOVED (repo lives inside VM)
```

Verified on fresh clone `shilo-agent-1`:

```text
clone time     0.07s
node/pnpm/codex/gh all work, repo on dev, backend dist present (1692 js)
host.docker.internal 5432/6379/8080/7233 all OK
```

Note: `pnpm b:build` compiles fully but its final step (Sentry sourcemap
upload) fails without SENTRY_AUTH_TOKEN. Harmless for local dev/run.

Next: Experiment 2 — per-agent Hasura (hasura/docker-compose.yml:
postgres:15 + graphql-engine v2.40.0 + data-connector-agent), wired to
backend running inside the VM.

## Goal

Build local parallel Codex agent environments using OrbStack machines.

Core idea:

- One prepared base VM.
- Fast `orb clone` per agent.
- Repo and dependencies inside VM for isolation.
- Shared heavy infra via Docker on host/OrbStack.

## What Worked

Created:

```text
shilo-agent-base
shilo-agent-1
```

OrbStack clone was very fast:

```bash
orbctl clone shilo-agent-base shilo-agent-1
```

Observed clone time:

```text
~0.38s
```

Codex inside VM works:

```bash
orb -m shilo-agent-1 codex --version
```

Output:

```text
codex-cli 0.137.0
```

VS Code Remote SSH works:

```bash
code --remote ssh-remote+shilo-agent-1@orb /home/dmitrijilin
```

Observed memory:

```text
VM + Codex only              ~250 MiB
VM + Codex + VS Code Remote  ~660 MiB idle
VS Code first setup peak     ~1.5 GiB
```

## Important Lesson

Do not mount `~/projects` for real agent environments.

We tested:

```bash
--mount /Users/dmitrijilin/projects:/mnt/projects
```

This works, but it means the VM writes directly into Mac files. That removes filesystem isolation.

For real setup:

```text
repo should live inside VM:
/home/dmitrijilin/projects/shilo-ai-mono
```

## Codex Auth

Codex binary is installed inside VM:

```bash
orb -m shilo-agent-base -u root npm install -g @openai/codex
```

Codex auth/config is shared by mounting host `~/.codex`:

```bash
--mount /Users/dmitrijilin/.codex:/mnt/host-codex
```

Then inside VM:

```bash
ln -s /mnt/host-codex ~/.codex
```

Codex still looks at normal:

```text
~/.codex
```

The symlink redirects it to the mounted Mac folder.

## GitHub CLI Auth

`~/.config/gh` mount was not enough.

Reason:

```text
host gh stores token in macOS keyring
VM only saw hosts.yml/config.yml
token was invalid inside VM
```

Working command:

```bash
gh auth token | orb -m shilo-agent-base gh auth login --with-token
```

Check:

```bash
orb -m shilo-agent-1 gh api user --jq .login
```

Output:

```text
Dimirolz
```

## Networking

VM can access shared Docker infra through `host.docker.internal`.

Checked from `shilo-agent-1`:

```text
host.docker.internal:5432  Postgres OK
host.docker.internal:6379  Redis OK
host.docker.internal:8080  Hasura OK
host.docker.internal:7233  Temporal OK
```

Useful env values:

```env
PG_DATABASE_URL=postgres://postgres:postgrespassword@host.docker.internal:5432/postgres
REDIS_URL=redis://host.docker.internal:6379
HASURA_GRAPHQL_URL=http://host.docker.internal:8080/v1/graphql
TEMPORAL_ADDRESS=host.docker.internal:7233
```

Host/browser can access service running inside VM through OrbStack DNS.

Tested:

```text
http://shilo-agent-1.orb.local:19090
```

So backend inside agent VM can be exposed as:

```text
http://shilo-agent-1.orb.local:8010
```

## Current Machines

At handoff time:

```bash
orbctl list
```

Expected:

```text
shilo-agent-1
shilo-agent-base
```

There may also be `shilo-agent-2` from experiments.

These were experimental and include the unwanted `~/projects` mount. Prefer deleting and recreating clean.

## Clean Base Creation Plan

Delete experimental machines:

```bash
orbctl delete shilo-agent-1
orbctl delete shilo-agent-2
orbctl delete shilo-agent-base
```

Create clean base without `~/projects` mount:

```bash
orbctl create ubuntu:24.04 shilo-agent-base \
  --isolated \
  --forward-ssh-agent \
  --mount /Users/dmitrijilin/.codex:/mnt/host-codex
```

Install basics:

```bash
orb -m shilo-agent-base -u root apt-get update
orb -m shilo-agent-base -u root apt-get install -y git curl ca-certificates nodejs npm gh
orb -m shilo-agent-base -u root npm install -g @openai/codex
```

Link Codex auth:

```bash
orb -m shilo-agent-base bash -lc '
  rm -rf ~/.codex
  ln -s /mnt/host-codex ~/.codex
'
```

Login GitHub CLI:

```bash
gh auth token | orb -m shilo-agent-base gh auth login --with-token
```

Optional: connect VS Code once to base so `~/.vscode-server` is baked into future clones.

## Next Experiment

Build a real Shilo base VM:

1. Clean base VM without `~/projects` mount.
2. Clone Shilo repo inside VM:

```bash
orb -m shilo-agent-base bash -lc '
  mkdir -p ~/projects
  cd ~/projects
  gh repo clone <ORG>/<REPO> shilo-ai-mono
'
```

3. Install project dependencies inside VM.
4. Build enough packages for backend web.
5. Stop base.
6. Clone agent:

```bash
orbctl clone shilo-agent-base shilo-agent-1
```

7. Open VS Code:

```bash
code --remote ssh-remote+shilo-agent-1@orb /home/dmitrijilin/projects/shilo-ai-mono
```

8. Run Codex from repo:

```bash
orb -m shilo-agent-1 bash -lc '
  cd ~/projects/shilo-ai-mono
  codex --yolo
'
```

9. Run backend web only.
10. Check:

```text
http://shilo-agent-1.orb.local:8010
```

## Open Questions

- Exact repo GitHub slug for `shilo-ai-mono`.
- Whether to install Node via Ubuntu apt, asdf, mise, or repo `.tool-versions`.
- Whether to bake full `pnpm install` and built packages into base.
- Whether to use per-agent Hasura or shared Hasura for first backend test.
- How much disk grows after each clone starts changing files.
