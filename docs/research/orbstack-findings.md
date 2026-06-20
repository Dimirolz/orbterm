# OrbStack Findings

Date: 2026-06-19.

Read-only reconnaissance of OrbStack internals.

## Useful Facts

- OrbStack uses Apple `Virtualization.framework`, not QEMU.
- Main VMM process: `OrbStack Helper vmgr`.
- It ships its own kernel/rootfs assets.
- Guest kernel includes Btrfs, zram, cgroups, and virtio balloon support.
- Logs indicate free page reporting is enabled.
- Docker data lives on a large raw disk image under OrbStack group containers.
- The guest data filesystem supports Btrfs/reflink behavior.

## Product Relevance

OrbStack gives two important properties:

- fast CoW-style machine cloning;
- better host memory behavior for idle VMs than naive VM setups.

The second property is the harder one to reproduce.

## Replacement Criteria

Any alternative should prove:

- fast agent creation from a prepared base;
- docker compose works inside the VM;
- host memory drops after guest memory is freed;
- stable command execution and PTY attachment;
- clean stop/delete semantics.

