# libkrun / krunvm PoC

Дата: 2026-06-19.

## Почему смотрим

Наши эксперименты показали:

- `apple/container + Incus + custom btrfs kernel` работает;
- CoW clone через Incus/btrfs работает быстро;
- blocker — memory reclaim;
- Apple `Virtualization.framework` balloon даёт classic balloon, но не
  free-page reporting;
- OrbStack решает память через `virtio_balloon` free-page reporting.

Нужен готовый VMM/backend, который умеет `VIRTIO_BALLOON_F_REPORTING`.

## Что доказали про OrbStack

OrbStack:

- использует свой `macvirt/vmgr` VMM слой;
- в VM есть `virtio_balloon`;
- feature bit `VIRTIO_BALLOON_F_REPORTING` включён;
- `dmesg`: `Free page reporting enabled`;
- после anonymous memory stress host footprint падает без роста
  `/proc/meminfo Balloon`.

Контрольный unbind-test:

```text
virtio_balloon bound:   memory reclaim works
virtio_balloon unbound: host footprint sticks at high-water
```

Итог: механизм практически доказан — free page reporting, не classic balloon.

## Почему apple/container не добить малым патчем

В patched `containerization` мы добавили:

```swift
VZVirtioTraditionalMemoryBalloonDeviceConfiguration()
```

Guest увидел balloon, target работал, но host footprint не снижался.

Сравнение feature bits:

```text
OrbStack:
  [1, 3, 5, 32, 34]
  STATS_VQ, FREE_PAGE_HINT, REPORTING, VERSION_1, RING_PACKED

Apple VZ PoC:
  [0, 2, 28, 29, 32, 34]
  MUST_TELL_HOST, DEFLATE_ON_OOM, INDIRECT_DESC, EVENT_IDX, VERSION_1,
  RING_PACKED
```

Критично: у Apple VZ нет bit 5 `REPORTING`. Kernel guest уже содержит
`CONFIG_PAGE_REPORTING` и `virtballoon_free_page_report`, но host device не
advertises feature. Поэтому guest reporting не включается.

## Почему libkrun интересен

`libkrun` — lightweight VMM library для запуска изолированных workloads.
На macOS/ARM64 использует HVF. В README прямо указано:

```text
virtio-balloon (only free-page reporting)
```

То есть это ровно тот memory mechanism, которого не хватает Apple VZ.

Связанные варианты:

- `krunvm` — CLI/VM runner поверх libkrun;
- Podman machine с LibKrun provider;
- `crun` умеет libkrun как OCI runtime.

## Цель PoC

Не заменить OrbStack сразу.

Минимальная цель:

```text
Поднять Linux workload через libkrun/krunvm на macOS
  -> подтвердить REPORTING bit
  -> touch 4-6G anonymous memory
  -> free memory
  -> увидеть падение host footprint без restart VM
```

Если это работает, libkrun — единственная реалистичная не-OrbStack ветка для
дальнейшего R&D.

## Что измеряем

Внутри guest:

```bash
uname -a
cat /proc/meminfo | grep -E 'MemAvailable|AnonPages|Balloon'
for d in /sys/bus/virtio/devices/*; do
  [ "$(cat "$d/device" 2>/dev/null)" = "0x0005" ] || continue
  echo "$d"
  cat "$d/features"
  readlink "$d/driver"
done
dmesg | grep -Ei 'Free page reporting|balloon|report'
```

На host:

```bash
PID=$(pgrep -f 'krun|krunvm|podman')
vmmap --summary "$PID" | grep 'Physical footprint'
```

Stress:

```bash
python3 - <<'PY'
import time
n = 6 * 1024 * 1024 * 1024
x = bytearray(n)
for i in range(0, n, 4096):
    x[i] = 1
print("allocated", flush=True)
time.sleep(20)
PY
```

Expected success:

```text
under stress: host footprint grows
after free:  host footprint drops within ~5-30s
guest:       Balloon remains 0 or small
guest:       REPORTING bit is present
```

## Success criteria

PoC считается успешным, если:

- guest sees virtio balloon device;
- feature bit 5 `VIRTIO_BALLOON_F_REPORTING` is present;
- host footprint drops after guest frees anonymous memory;
- no VM restart is needed;
- repeat stress still works after reclaim.

## Questions after memory PoC

Если memory works, дальше проверяем product fit:

- Можно ли получить stable long-running VM?
- Есть ли нормальный exec/PTY path?
- Можно ли шарить host filesystem достаточно быстро?
- Можно ли поднять Incus внутри libkrun VM?
- Работает ли custom kernel / btrfs?
- Как устроены network/port forwarding?
- Можно ли управлять lifecycle программно без GUI?

## Ожидаемые риски

- `krunvm` может быть неупакован/неудобен на macOS.
- Podman LibKrun provider может быть заточен под GPU/Podman, не general VM.
- Incus внутри libkrun может упереться в kernel config/cgroups/nesting.
- Даже если memory идеальна, filesystem/network/PTY могут быть хуже OrbStack.

## Предварительный вывод

`libkrun/krunvm` стоит проверить как memory-reclaim PoC.

Но это не “готовый Incus для VMM”. Это candidate backend/building block.
Главная ценность — наличие `virtio-balloon` free page reporting на macOS без
полного собственного VMM.

## Прогон 2026-06-19: krunvm memory PoC

Окружение: macOS 15.6.1, M4 Pro 24GB, `krunvm 0.2.6`,
`libkrun 1.19.0`, `libkrunfw 5.5.0`.

### Setup

- `brew tap` зависал на clone, поэтому сделали минимальный локальный tap из
  raw formula файлов.
- `brew install libkrun/krun/krunvm` прошёл из bottles.
- `krunvm` потребовал отдельный case-sensitive APFS volume.
- Создали:

```bash
diskutil apfs addVolume disk3 "Case-sensitive APFS" krunvm
```

### Что подтвердилось

Создали тестовую VM:

```bash
krunvm create --name memtest --cpus 4 --mem 8192 docker.io/library/alpine:latest
```

Guest kernel:

```text
Linux memtest 6.12.91 #1 SMP Mon Jun 1 16:28:39 CEST 2026 aarch64
```

Virtio devices:

```text
virtio0 device = 0x0005
driver = virtio_balloon
features = 0101010000000000000000000000000010000000000000000000000000000000
```

Decoded feature bits:

```text
[1, 3, 5, 32]
STATS_VQ, FREE_PAGE_HINT, REPORTING, VERSION_1
```

`dmesg`:

```text
Free page reporting enabled
```

Итог: libkrun действительно advertises `VIRTIO_BALLOON_F_REPORTING`.

### Memory stress result

Тест 1: Python `bytearray(6G)` → `del` → process живёт дальше.

```text
under allocation:
  krunvm RSS ~6.7G
  vmmap Physical footprint ~6.3G

after del + gc + ~30s:
  krunvm RSS ~6.7G
  vmmap Physical footprint ~6.3G
```

Тест 2: anonymous `mmap(6G)` → `madvise(MADV_DONTNEED)` → process живёт.

```text
after madvise:
  krunvm RSS ~6.7G
  vmmap Physical footprint ~6.3G
```

Тест 3: anonymous `mmap(6G)` → `mmap.close()` → process живёт.

```text
after close:
  krunvm RSS ~6.7G
  vmmap Physical footprint ~6.3G
```

Под дополнительным host memory pressure (`python` touched 10G):

```text
krunvm RSS dropped ~6.7G -> ~860M
vmmap Physical footprint still reported ~6.3G
swapouts: 0
```

### Вывод прогона

libkrun/krunvm имеет правильный virtio-balloon reporting bit и guest пишет
`Free page reporting enabled`, но **OrbStack-like proactive host footprint
drop мы не увидели**.

Похоже, libkrun free-page-reporting делает страницы reclaimable под pressure,
но не возвращает footprint proactively так же, как OrbStack.

Для нашей цели это пока **не замена OrbStack memory behavior**. Следующий
шаг возможен только если глубже разбирать macOS accounting/RSS/footprint и
libkrun host-side reclaim path.

## Прогон 2026-06-19: libkrun source + MADV_DONTNEED patch

Склонировали:

```text
/Users/dmitrijilin/projects/libkrun
/Users/dmitrijilin/projects/libkrun-v1.19.0
```

Нашли host-side balloon path:

```text
src/devices/src/virtio/balloon/device.rs
Balloon::process_frq()
```

libkrun делает:

```rust
#[cfg(target_os = "linux")]
let advice = libc::MADV_DONTNEED;
#[cfg(target_os = "macos")]
let advice = libc::MADV_FREE;

libc::madvise(host_addr, len, advice)
```

То есть на macOS upstream использует lazy `MADV_FREE`, что хорошо объясняет
reclaim только под pressure.

### Patch experiment

Собрали `libkrun v1.19.0` с локальным патчем:

```text
macOS: MADV_FREE -> MADV_DONTNEED
```

Также добавили временный `eprintln` в `process_frq()`.

Запускали `krunvm` с patched dylib через:

```bash
DYLD_LIBRARY_PATH=/Users/dmitrijilin/projects/libkrun-v1.19.0/target/release:\
/opt/homebrew/opt/libkrunfw/lib:\
/opt/homebrew/opt/libepoxy/lib:\
/opt/homebrew/opt/virglrenderer/lib
```

Подтвердили через `DYLD_PRINT_LIBRARIES`, что грузится patched dylib.

### Что доказал instrumentation

После guest free/unmap реально приходят free-page reports:

```text
LIBKRUN_FRQ madvise ret=0 guest_addr=... len=4194304 advice=4
```

`ret=0` = `madvise` успешен. `advice=4` = `MADV_DONTNEED`.

То есть:

```text
guest reports pages -> libkrun получает FRQ -> host madvise вызывается успешно
```

Проблема НЕ в том, что reporting bit фейковый, и НЕ в том, что guest не
шлёт reports.

### Memory result with patched MADV_DONTNEED

Тест:

```text
anonymous mmap 6G -> touch pages -> mmap.close() -> process alive 60s
```

Результат:

```text
under allocation:
  RSS ~6.7G
  Physical footprint ~6.3G

after close + 20s:
  RSS ~6.7G
  Physical footprint ~6.3G

under host pressure:
  RSS ~854M
  Physical footprint still ~6.3G
```

### Вывод

Даже `MADV_DONTNEED` в libkrun не даёт OrbStack-like proactive footprint drop.

На текущем механизме libkrun/HVF pages становятся reclaimable под macOS
pressure, но процессный `Physical footprint` остаётся high-water.

OrbStack, вероятно, делает что-то сильнее простого `madvise`:

- другой тип guest memory mapping;
- `vm_deallocate`/remap страниц;
- собственный allocator для guest RAM;
- другой macOS memory accounting path;
- или дополнительный pressure/reclaim daemon вокруг VMM memory.

Практический итог: libkrun хорош как reference VMM с `REPORTING`, но его
готовый reclaim path всё ещё не эквивалентен OrbStack.
