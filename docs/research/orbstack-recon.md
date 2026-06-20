# OrbStack internals recon

Дата: 2026-06-19. Разведка была read-only: `orbctl list`, `ps`, `lsof`,
`file`, `strings`, `docker info`, логи `~/.orbstack/log/vmgr.log`.

## Что нашли

- OrbStack использует Apple `Virtualization.framework`, не QEMU.
- Основной процесс: `OrbStack Helper vmgr`.
- Есть privileged helper: `/Library/PrivilegedHelperTools/dev.orbstack.OrbStack.privhelper`.
- Внутри логов и публичных stack traces фигурирует собственный компонент
  `scon` / `sconrpc` / `sconssh` / `scli`.
- В bundle лежат:
  - `.../OrbStack.app/Contents/Resources/assets/release/arm64/kernel`
  - `rootfs.img`
  - `kernel.ri`
  - `rpack`
- Kernel: `7.0.11-orbstack-00360-gc9bc4d96ac70`.
- Kernel собран с Btrfs, zram, cgroup, virtio balloon.
- Старый `kernel.ri`: `6.7.11-orbstack+`.
- Общий data-диск:
  `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw`
- `data.img.raw`:
  - GPT disk image;
  - logical size ~494 GB;
  - physical usage на хосте ~26 GB;
  - внутри логи показывают Btrfs mount `/dev/vdb1`.
- `swap.img` есть, logical 1 GB, physical usage почти 0.
- `vmgr.log` показывает:
  - `BTRFS: device label user-data-fs`;
  - mount с `nodatasum`, `nodatacow`, `ssd`, `sync discard`;
  - zram swap ~12 GB;
  - отдельный swap на `/dev/vdc`;
  - NFS server/mount для host filesystem sharing;
  - собственный forwarding/container слой `scon`.
- Docker через OrbStack:
  - `OperatingSystem: OrbStack`;
  - kernel тот же `7.0.11-orbstack...`;
  - `CgroupVersion: 2`;
  - storage driver `overlay2`;
  - backing filesystem `btrfs`.

## Рабочая гипотеза

OrbStack устроен примерно так:

```text
macOS
  -> Virtualization.framework VM
     -> custom Linux kernel с btrfs/zram/virtio_balloon
     -> общий sparse data.img.raw
     -> Btrfs как основной data/storage слой
     -> scon: свой container runtime/control daemon
     -> Docker + Linux machines как containers/namespaces
     -> clone/snapshot через Btrfs/CoW
```

То есть архитектурно это похоже на наш вариант:

```text
apple/container или своя VZ outer VM
  -> custom Linux kernel с btrfs
     -> Incus
        -> agent-base
        -> agent-N через CoW clone
```

## Важный вывод

Путь `outer VM + Incus + btrfs` не выглядит экзотикой. Он, вероятно,
близок к тому, как OrbStack реализует Linux machines.

Главное отличие: OrbStack уже имеет кастомный kernel и свой polished слой
для сети, NFS, Docker socket, port forwarding, memory pressure и lifecycle.

## Что такое `scon`, вероятно

Публичных исходников нет, но в GitHub issues OrbStack всплывают Go stack
traces с путями вида:

```text
github.com/orbstack/macvirt/scon/...
github.com/orbstack/macvirt/scon/cmd/scli/...
github.com/orbstack/macvirt/scon/mdns.go
```

Локально в `~/.orbstack/run` есть сокеты:

```text
sconrpc.sock
sconrpc2.sock
sconssh.sock
sconssh-public.sock
```

Рабочая интерпретация:

```text
scon daemon
  -> запускает containers/machines через namespaces/cgroups/rootfs
  -> управляет veth/bridge/ports
  -> даёт RPC API через sconrpc
  -> даёт SSH bridge через sconssh
  -> содержит mDNS/.orb.local интеграцию
```

То есть `scon` выглядит как собственный Incus/LXC-подобный runtime,
написанный специально под OrbStack.

## Ballooning

В bundled kernel есть явные строки:

```text
virtio-balloon
virtio_balloon
drivers/virtio/virtio_balloon.c
balloon_inflate
balloon_deflate
```

Это подтверждает guest-side поддержку virtio balloon driver.

Полный ballooning требует три части:

```text
Virtualization.framework VM config
  + virtio balloon device
Linux guest kernel
  + virtio_balloon driver
vmgr
  + policy: когда inflate/deflate
```

По kernel strings видна только guest-часть. Но поведение OrbStack с памятью
и наличие `vmgr` делают вероятным, что они также добавляют balloon device
и управляют им из host-side runtime.

### Наблюдение 2026-06-19

Проверили `shilo-agent-base` через `orb`:

```text
idle guest:  /proc/meminfo Balloon: 0 kB
idle host:   vmgr Physical footprint ~1.9G, peak ~4.1G
stress:      python touched 6G anonymous memory
stress host: vmgr Physical footprint ~7.9G, peak ~8.0G
stress guest: AnonPages ~6.9G, Balloon: 0 kB
after free +5s:  host footprint ~7.6G, Balloon: 0 kB
after free +10s: host footprint ~1.6G, Balloon: 0 kB
after free +30s: host footprint ~1.5G, Balloon: 0 kB
```

Вывод: OrbStack возвращает host memory **без роста guest-visible
`/proc/meminfo Balloon`**. Это не похоже на обычный virtio balloon target
типа `VZVirtioTraditionalMemoryBalloonDevice`.

Дополнительная проверка через privileged Docker container в нижнем OrbStack VM:

```text
/sys/bus/virtio/devices/virtio0/device = 0x0005
/sys/bus/virtio/devices/virtio0/driver -> virtio_balloon
dmesg: Free page reporting enabled
/proc/kallsyms: report_free_page_func, virtballoon_free_page_report,
                page_reporting_register
```

Более точный вывод: OrbStack использует virtio-balloon **free page
reporting**, а не classic balloon inflation. Поэтому `Balloon: 0 kB`, но
host memory возвращается после освобождения anonymous pages.

Это объясняет провал apple/container PoC: `VZVirtioTraditionalMemoryBalloon`
дал classic balloon target, но не дал working free-page-reporting reclaim.

### Unbind-test (2026-06-19)

Проверили причинность:

```text
baseline: virtio0 bound to virtio_balloon, host footprint ~1.6G
unbind:   echo virtio0 > /sys/bus/virtio/drivers/virtio_balloon/unbind
stress:   touch 6G anonymous memory
stress host: ~7.7G
after free +5s:  ~7.6G
after free +10s: ~7.7G
after free +20s: ~7.6G
after free +30s: ~7.6G
```

При этом guest memory была свободна (`MemAvailable ~11G`, `Balloon: 0`).
То есть без `virtio_balloon`/free-page-reporting OrbStack превращается в тот
же high-water behavior, что apple/container.

Rebind без reboot не восстановил reclaim для уже накопленного high-water.
После `orbctl stop`/`orbctl start --all`:

```text
dmesg: Free page reporting enabled
virtio0 -> virtio_balloon
sanity stress 2G:
  +5s  host ~4.8G
  +10s host ~2.8G
  +20s host ~2.4G
```

Итог: механизм практически доказан — **virtio-balloon free page reporting**,
а не classic balloon size target.

## Следующий read-only/low-risk тест

Запустить одну OrbStack machine и внутри проверить:

```bash
uname -a
findmnt
cat /proc/1/cgroup
systemd-detect-virt
cat /proc/filesystems
ls /dev
```

Цель: понять, OrbStack machine является отдельной VM или system container
внутри общего OrbStack kernel. По текущим признакам больше похоже на
system container.

## VMM fingerprint (2026-06-19)

Read-only проверки `OrbStack Helper vmgr`:

```text
otool -L:
  links Hypervisor.framework
  links Virtualization.framework
  links vmnet.framework

sample:
  Thread: VMM main loop
  Hypervisor Hv::Vcpu::run / hv_trap

strings:
  src/vmm/src/macos/vstate.rs
  src/vmm/src/builder.rs
  src/devices/src/virtio/mmio.rs
  src/devices/src/virtio/fs/macos/passthrough.rs
  devices::virtio::balloon::device::Balloon
  devices::virtio::net::device::Net
  devices::virtio::vsock::device::Vsock
  devices::virtio::fs::device::Fs
  devices::legacy::gic::hvf_gic
  hvf::memory
  hvf::aarch64::vm
  github.com/orbstack/macvirt/vmgr/...
```

Вывод: это не выглядит как bundled QEMU/libkrun/crosvm/firecracker.
Похоже на собственный Rust VMM/device stack поверх Apple
Hypervisor.framework, с использованием частей Virtualization.framework/vmnet
рядом для отдельных функций/интеграций.

То есть OrbStack, вероятно, не “один человек написал всё с нуля”, но точно
имеет свой `macvirt` VMM слой и свои virtio devices. Это и объясняет контроль
над `VIRTIO_BALLOON_F_REPORTING`.

## Memory mapping / reclaim fingerprint (2026-06-19)

После libkrun PoC проверили, чем OrbStack отличается на macOS side.

### vmmap в idle после reclaim

`vmgr`:

```text
Physical footprint:         697.6M
Physical footprint (peak):  6.2G
Writable regions: Total=13.6G resident=30.0M unallocated=13.5G
Memory Tag 250: 14.0G resident=112K count=3073
```

Детальный `vmmap` показывает тысячи регионов:

```text
Memory Tag 250 ... [4096K ...] rw-/rwx SM=SHM
```

То есть guest RAM выглядит не как один большой mmap, а как много 4MB
shared-memory chunks под `Memory Tag 250`.

### Live stress/reclaim

Stress 6G anonymous memory внутри OrbStack machine:

```text
under stress:
  Physical footprint: 10.1G
  RSS:                ~11.4G
  Memory Tag 250:     14.0G resident=1.1G

after guest free:
  Physical footprint: 2.9G -> 1.6G
  RSS:                ~4.6G
  Memory Tag 250:     352K -> ~11M
```

То есть OrbStack действительно drops host footprint after free, без restart.

### sample during reclaim

`sample vmgr` в reclaim window поймал отдельный thread:

```text
Thread: VMA 2
  mach_vm_remap
    _kernelrpc_mach_vm_remap
```

Также в stress sample всплывали:

```text
mach_vm_remap
hv_vm_map
Hv::Vm::map_space
```

### Вывод

Это сильно поддерживает гипотезу:

```text
OrbStack не просто делает madvise на guest RAM.
Он управляет guest memory как набором 4MB VMA/shared-memory chunks
и на reclaim/remap path использует mach_vm_remap / hv_vm_map.
```

Это объясняет отличие от libkrun:

```text
libkrun:
  FRQ arrives -> madvise(MADV_FREE/DONTNEED) ret=0
  RSS drops only under pressure, footprint sticks

OrbStack:
  FRQ arrives -> VMA/remap machinery
  footprint drops proactively
```

Практический смысл: “один bit balloon” был только guest/device protocol.
Трудная часть — macOS host memory manager вокруг guest RAM mappings.
