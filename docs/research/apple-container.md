# Apple Container Feasibility

Date: 2026-06-12.

## Result

Apple `container machine` looks feasible as an OrbStack replacement candidate.

Validated:

- docker compose works inside the machine;
- machine create from a prepared image can be under 1s;
- disk footprint was roughly 181 MB per machine in the tested path;
- command mapping is close to `orbctl`.

## Why It Matters

It could remove the dependency on closed paid OrbStack while preserving the core UX:

- create/start/stop/remove/list machines;
- run commands inside a VM;
- bake a base image;
- clone cheap isolated agents.

The compose-in-VM decision makes this migration easier because the stack no longer needs host-managed ports or `.orb.local` auth hook routing.

## Expected Code Impact

Mostly the VM adapter layer:

- `Machines.ts`: replace `orbctl`/`orb` calls with `container machine` calls;
- `Codex.ts`: PTY command should enter the machine with the new runtime;
- config/bootstrap: base VM becomes an OCI image/build flow.

## Open Risks

- memory reclaim behavior still needs real measurement;
- image build/update ergonomics need a clean workflow;
- networking and local service access need e2e validation;
- security defaults must be reviewed before exposing the UI broadly.

