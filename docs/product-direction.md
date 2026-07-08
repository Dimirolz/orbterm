# Product Direction

Goal: turn this from a Shilo-specific local control plane into a shareable tool for running parallel coding agents in isolated local VMs.

## Main Blocker

Project-specific settings are hardcoded in `control-plane/server/src/config.ts`:

- machine prefix and base VM name;
- repo path inside the VM;
- compose service names;
- Shilo-specific stack assumptions.

Packaging before fixing this would only package the hardcode.

## Direction

1. Add a declarative project config.
2. Add an init flow that creates that config and builds/updates the base VM.
3. Package server + built web UI as one CLI.
4. Add Electron only later if a native window/tray matters.

## Config Shape

Prefer YAML/TOML/JSON over TS. The target repo may not be a Node project.

Example:

```yaml
machine_prefix: myapp-agent-
base_machine: myapp-agent-base
workspace_dir: ~/projects/myapp
repos:
  - slug: org/myapp
    dir: .
    branch: main
stack:
  hasura:
    services: [postgres, graphql-engine]
  backend_deps:
    services: [redis, temporal]
setup:
  - corepack enable
  - pnpm install
```

Config locations should support:

- project file: `./orbterm.yml`;
- ignored local file: `./orbterm.local.yml`;
- private user file: `~/.config/orbterm/<project>.yml`.

## Shareable Package

First target:

```sh
npx orbterm
```

That command should start the local server, serve the built web UI, and open a browser.

Electron is polish, not a prerequisite.

## Risks

- secrets must be referenced, not stored in config;
- each VM needs Codex/auth/bootstrap state;
- resource visibility and cleanup matter once multiple agents run;
- result delivery still needs branch/push/PR workflow;
- OrbStack means macOS-only until the VM layer is abstracted.
