# VMM Memory Reclaim

Date: 2026-06-19.

## Finding

Memory reclaim is the key blocker for replacing OrbStack with a custom or lower-level VMM path.

OrbStack appears to use a virtio balloon setup with free page reporting enabled. That is likely why idle VM memory returns to the host more effectively than basic ballooning.

## What Was Checked

- OrbStack internals and guest kernel signals;
- Apple `Virtualization.framework` balloon behavior;
- `libkrun` / `krunvm` as a possible backend;
- attempts around `MADV_DONTNEED`-style reclaim.

## Conclusion

Classic ballooning is not enough. A viable replacement needs proactive free-page reporting or equivalent host footprint reduction.

`libkrun` is interesting because it targets lightweight workloads and virtio devices, but the experiment did not prove OrbStack-like proactive footprint drop.

## Keep In Mind

- CoW clone speed is solved by several approaches.
- The hard problem is many idle agents without linear RAM growth.
- Any future VM backend must be judged by host memory footprint after guest memory is freed, not just by boot speed.

