# Эксперимент: Incus внутри apple/container (mutable golden + fast clone)

Дата: 2026-06-19. Хост: macOS 15.6.1, M4 Pro 24GB, container 1.0.0.

## Мотивация

OCI-модель (golden-as-image, пересборка через `container build`) неудобна:
запекать pg data / deps слоями и тянуть FROM-цепочку — больно. Хочется
сохранить нынешнюю OrbStack-модель: **мутабельный golden + быстрый CoW clone**.

Incus это умеет нативно: `incus snapshot` + `incus copy` живой машины,
профили, storage pools. План — поставить Incus ВНУТРЬ бесплатной
apple/container outer-VM и проверить, даёт ли он fleet-примитивы.

```diagram
macOS (apple/container)
  └─ outer machine: fleet-main  (ubuntu + incus + btrfs pool)
       └─ Incus
            ├─ agent-base  (mutable golden, system container)
            ├─ agent-1     (incus copy от base — CoW)
            └─ agent-N
```

## Риски в порядке убывания (что валидируем)

1. **btrfs (или иной CoW backend) в kata-ядре.** Без CoW `incus copy` =
   полный rsync → теряем «быстрый clone». Это ГЛАВНЫЙ вопрос.
2. **Incus вообще стартует в kata-ядре** (user namespaces, cgroup v2,
   AppArmor может отсутствовать — терпимо, unconfined).
3. **Мутабельный golden → clone workflow:** create base → мутировать
   («golden refresh») → snapshot → copy в agent-N. Замерить время + диск.
4. **Nested docker внутри incus-контейнера** (compose-in-vm требует docker
   у агента). Тройная вложенность: docker в LXC в kata-VM.
5. **exec + interactive** (`incus exec`) — маппинг на codex pty.
6. **Сеть** host macOS → outer machine → incus container (на macOS 15
   ограниченно; полноценно на 26).

## Маппинг на control-plane (что заменит orbctl)

| control-plane | OrbStack | Incus-вариант |
|---|---|---|
| list | orbctl list -f json | incus list --format json |
| clone | orbctl clone base N | incus copy base N (CoW snapshot) |
| start/stop | orbctl start/stop | incus start/stop |
| delete | orbctl delete | incus delete -f |
| exec | orb -m M bash -lc | incus exec M -- bash -lc |
| pty | pty.spawn(orb,…) | pty.spawn(container,[machine,run,…,incus,exec,…]) |
| golden refresh | мутировать base VM | мутировать base container (как сейчас!) |

## Шаги

1. Build outer image `local/incus-machine` (ubuntu 24.04 + systemd + incus + btrfs-progs).
2. `container machine create` → fleet-main, проверить incus daemon жив.
3. `incus admin init` с btrfs pool на loop-файле — проверить CoW доступен.
4. `incus launch images:ubuntu/24.04 agent-base` — system container поднялся.
5. Мутировать agent-base (apt install), snapshot, `incus copy` → agent-1.
   Замерить время copy + реальный диск (CoW или full?).
6. Nested docker: внутри agent-1 (security.nesting=true) `docker run hello-world`.
7. exec/interactive проверка.
8. (опц.) сеть host→outer→agent.

## Результаты (2026-06-19, прогон выполнен)

Окружение: macOS 15.6.1, container 1.0.0, образ `local/incus-machine`
(ubuntu 24.04 + systemd + incus 6.0.0 + btrfs-progs), outer machine
`fleet-main` (4 cpu / 8G / home-mount none).

### Что РАБОТАЕТ (зелёное)

- **Incus стартует в apple/container.** Daemon 6.0.0 живой (через
  `sudo`, юзер не в incus-admin группе — мелочь). `incus admin init
  --minimal` отработал: пул `default` + бридж `incusbr0` 10.218.150.1/24.
- **System container.** `incus launch images:ubuntu/24.04 agent-base` —
  RUNNING, получил IP, `incus exec` работает. (launch ~30s, из них ~26s —
  скачивание образа; повторные из локального кэша будут быстрее.)
- **Nested docker (ТРОЙНАЯ вложенность).** docker → incus LXC → kata-VM:
  `security.nesting=true`, `apt install docker.io`, dockerd active,
  storage driver **overlayfs**, `docker run hello-world` = "Hello from
  Docker!". Реальный сервис `redis:7 -p 6379` → `redis-cli ping` = PONG.
  Bridge-сеть docker0 (172.17) видна рядом с eth0. **compose-in-vm внутри
  Incus реально работает.**
- **incus list --format json** — чистый структурированный вывод, маппится
  1:1 на `Machines.list`. exec — clean argv маппится на `runInRepo`.
- **Память эффективна.** Guest used = 367 MB при incus + 2 контейнера +
  docker + redis (3.6G — reclaimable buff/cache). Модель «один outer VM на
  ВСЕ агенты» = ближе всего к shared-engine экономике OrbStack.

### Что НЕ РАБОТАЕТ / главное ограничение (красное)

- **НЕТ CoW storage backend.** Kata/apple-ядро (6.18.15) НЕ содержит
  btrfs/zfs, `/lib/modules` отсутствует → модули не подгрузить, dm/lvm-thin
  тоже нет (`/dev/mapper` нет). Доступны только: ext4, xfs, overlay, fuse,
  9p, erofs, virtiofs. Incus инициализирован на **dir** backend.
- **Следствие: `incus copy` = полная побайтовая копия, блоки НЕ шарятся.**
  Замер: copy base→agent-1 = 1.77s, но это с НУЛЕВЫМ blob (ужался в sparse
  при rsync — agent-1 показал 595M против 1.7G у base). Для реальных
  (несжимаемых) deps/pg-data каждый клон копирует все N GB и занимает N GB
  диска. Это убивает киллер-фичу OrbStack (CoW clone 0.07–0.38s, ~181M
  реального диска на клон).
- **НЕТ nested virt** (`/dev/kvm` отсутствует) → incus VM-mode недоступен,
  только system containers. Для fleet это ок (нам и нужны контейнеры).

### Вывод по mutable golden

Хорошая новость: **мутабельный golden сохраняется** — `agent-base` это
живой контейнер, его можно мутировать (`incus exec ... apt/git pull/
migrate`), снапшотить (`incus snapshot`), и клонировать (`incus copy`).
Петля «обнови base на месте → клонируй агентов» работает как сейчас в
OrbStack, БЕЗ запекания в OCI. Это ровно то, что хотелось.

Плохая новость: **клон не дешёвый по диску** из-за отсутствия CoW.
Функционально fleet-примитивы есть; экономика клона хуже OrbStack.

### Способы вернуть CoW (для следующего шага, если продолжать)

1. **btrfs/zfs в guest-ядре.** Требует своё ядро для apple/container с
   вкомпилированным btrfs (или модулями). Apple-ядро закрытое/фиксированное
   — здесь рычага нет без кастомного kernel. Малореалистично.
2. **Incus на overlay?** У Incus нет overlay-драйвера для инстансов
   (overlay только для образов в lxd/lxc отдельных кейсах) — не вариант.
3. **Загнать btrfs-loop в guest невозможно** без btrfs в ядре.
4. **Альтернатива outer-слою:** запускать Incus не в apple/container, а в
   ЛЮБОЙ Linux VM, где ядро под нашим контролем (напр. собственная
   Virtualization.framework VM с кастомным ядром + btrfs, или Lima/QEMU).
   Тогда CoW Incus возвращается полностью. Это смещает сложность в
   «свой outer VM», но снимает потолок apple-ядра.

### Маппинг на control-plane — подтверждён

| Machines.* | команда |
|---|---|
| list | `incus list --format json` ✅ |
| clone | `incus copy base agentN` ✅ (но full copy) |
| start/stop/delete | `incus start/stop/delete -f` ✅ |
| runInRepo | `incus exec agentN -- …` ✅ (argv, без пайпов) |
| pty (codex) | `incus exec -t agentN -- codex-start` — обернуть запуск
  в запечённый скрипт, т.к. apple `machine run` коверкает кавычки/&&/пайпы |

Поверхность замены — тот же ~1 интерфейс `Machines`, что и для OrbStack.

## Прогон 2 (2026-06-19): можно ли вернуть CoW дёшево?

Проверяли две гипотезы Codex: (2) xfs reflink и (1) custom kernel.

### xfs reflink РАБОТАЕТ на уровне FS — но incus copy его НЕ использует

- Текущее apple-ядро 6.18.15 содержит xfs (хотя в референс-конфиге
  containerization 0.5.0 `CONFIG_XFS_FS is not set` — Apple добавили сверх).
- `mkfs.xfs -m reflink=1` на loop-файле + `cp --reflink=always` 200MB
  random → диск НЕ вырос (330→330 MB). **CoW через reflink доступен уже
  сейчас, без кастомного ядра.**
- НО: `incus copy` на dir-пуле поверх такого xfs всё равно идёт через
  **rsync** (видно в ошибке "Rsync receive failed"). Incus dir-драйвер
  reflink не использует. → xfs reflink НЕ ускоряет incus clone.
- Побочно: xfs-on-loop не отдаёт POSIX ACL (`lsetxattr
  system.posix_acl_access` = Operation not supported) — rsync контейнера
  падает. Ещё один минус dir-на-xfs.

Вывод: дешёвого пути нет. Для CoW-клона Incus нужен НАСТОЯЩИЙ CoW storage
driver (btrfs/zfs/lvm-thin), а он требует поддержки в ядре.

### Custom kernel — реально поддерживается (главный следующий PoC)

- `container run -k/--kernel <path>` и системно `container system kernel
  set --binary <path>` / `--tar <url>`. Машины используют дефолтное ядро →
  установка кастомного применится и к `container machine`.
- Референс-конфиг: github.com/apple/containerization kernel/config-arm64.
  Подтверждено: `CONFIG_BTRFS_FS is not set`, нет DEVICE_MAPPER/DM_THIN,
  нет ZFS. Есть OVERLAY_FS, LOOP, EXT4.
- План PoC: собрать arm64-ядро из их config + `CONFIG_BTRFS_FS=y` (+ deps:
  LIBCRC32C, ZSTD/ZLIB — вероятно уже есть), `container system kernel set`,
  затем в fleet-main `incus admin init` с btrfs-пулом на loop → проверить,
  что `incus copy` стал CoW (диск не растёт). Сборка ядра нативно на M4
  внутри arm64 Linux-контейнера, ~полдня, риск средний.

### Fallback, если custom kernel не пробить (Codex #3)

xfs reflink на уровне FS работает → тяжёлое состояние (pg data dir, deps)
держать в ОТДЕЛЬНОМ reflink-volume и клонировать своей логикой
(`cp --reflink`), а сам incus-контейнер клонировать full (он маленький).
Слабее нативного btrfs-пула, но возвращает дешёвый клон тяжёлых данных
без кастомного ядра.

## Прогон 3 (2026-06-19): CUSTOM KERNEL + BTRFS — УСПЕХ ✅

Собрали кастомное guest-ядро и проверили incus-нативный CoW clone.

### Сборка ядра — дёшево

- container 1.0.0 → containerization **0.33.4** (Package.resolved) → ядро
  **linux-6.18.5**. Склонировали apple/containerization@0.33.4.
- В `kernel/config-arm64` одной строкой: `# CONFIG_BTRFS_FS is not set`
  → `CONFIG_BTRFS_FS=y` (select-зависимости olddefconfig подтянул сам).
- `make TARGET_ARCH=arm64` (их контейнерная сборка, ubuntu:focal build-image)
  → артефакт `kernel/vmlinux` (uncompressed arm64 Image, 30MB).
- **Время сборки: ~3.5 минуты** на M4 Pro (8 cpu/16g build-контейнер).
  Сильно дешевле ожиданий.

### Установка ядра

- `container system kernel set --arch arm64 --binary …/kernel/vmlinux --force`.
- Применяется системно → новые VM (и `container machine`) бутятся с ним.
- Revert при необходимости: `container system kernel set --recommended`.
- Пересоздали fleet-main → `uname -r` = **6.18.5-cz-9275f365dd55**,
  `grep btrfs /proc/filesystems` = **btrfs присутствует**. Boot ~6s, как и
  на стоковом ядре — регрессий нет.

### Incus btrfs pool → CoW clone (главный результат)

- `incus storage create btrfspool btrfs size=20GiB` (loop-backed) — ок.
- base на btrfs + 400MB non-zero blob = 763MiB в пуле.
- **`incus copy base cloneN` = 0.10–0.19s** (на dir было 1.77s; OrbStack
  CoW = 0.07–0.38s — СОПОСТАВИМО).
- **Диск: 4 клона контейнера 763MB → btrfs Data used 1.19GiB** (base +
  дельта одной реальной 200MB-записи). Клоны 2/3/4 добавили **0 байт**.
  Без CoW (dir) было бы ~3.2GB. CoW работает идеально.
- **Истинная изоляция**: клон видит свой `/root/blob`; запись `blob2` в
  клон НЕ появилась в base. Не хардлинки — настоящий CoW snapshot.
- **Nested docker на btrfs-клоне**: overlayfs, `docker run hello-world` =
  "Hello from Docker!" — compose-in-vm жив.
- Память: guest used 509MB (incus + 5 клонов, один с docker); host VZ
  footprint 3.6G (8G лимит, в основном reclaimable cache).

### ИТОГ направления

apple/container (бесплатный, Apache 2.0) + кастомное ядро с btrfs + Incus
даёт **полный OrbStack-эквивалент**:

```diagram
╭─ примитив ──────────╮ ╭─ статус ──────────────────────────────╮
│ mutable golden      │ │ ✅ живой base-контейнер, мутируешь на  │
│                     │ │    месте (НЕ запекаешь в OCI)          │
│ fast CoW clone      │ │ ✅ incus copy 0.1s, 0 диска на клон    │
│ snapshot            │ │ ✅ btrfs subvolume snapshots           │
│ docker / compose    │ │ ✅ nested docker overlayfs             │
│ list/exec/lifecycle │ │ ✅ маппится 1:1 на Machines.ts         │
│ память на N агентов │ │ ✅ один outer VM, агенты = LXC          │
╰─────────────────────╯ ╰─────────────────────────────────────────╯
```

Единственная новая операционная задача vs OrbStack: **поддерживать
кастомное ядро** (~3.5 мин пересборка при апгрейде container/containerization;
конфиг-дельта в один флаг хранить в репо). Это разовая автоматизируемая цена.

### Следующие шаги (если продолжать к продукту)

1. Запечь в outer-образ `local/incus-machine`: incus init с btrfs-пулом +
   bridge при first-boot (чтобы fleet-main поднимался готовым).
2. Codex pty: `incus exec -t agentN -- codex-start` (скрипт запечь в
   agent-образ, обойти mangling кавычек у `container machine run`).
3. Абстрагировать `Machines.ts`: бэкенд orbstack | incus за одним интерфейсом.
4. Golden refresh: мутировать `agent-base` → `incus copy` агентов (как
   сейчас в OrbStack, без OCI).
5. Сеть host macOS → fleet-main → agent (на macOS 26 полноценно).

## Состояние после прогона

`fleet-main` оставлен RUNNING. Содержит btrfs-пул `btrfspool` + `default`
(dir), контейнеры: `base` (golden, RUNNING), `clone1` (RUNNING, docker
установлен), `clone2..clone5` (STOPPED, CoW-копии base). buildkit-VM можно
погасить. Очистка: `container machine delete fleet-main`.

---

# HANDOFF для следующего агента (2026-06-19)

PoC доказан end-to-end (см. «Прогон 3»): apple/container + кастомное ядро с
btrfs + Incus = OrbStack-эквивалент с mutable golden и CoW clone. Storage
больше НЕ критический путь. Критический путь теперь: **control-plane
интеграция + PTY + сеть**.

## ⚠️ Состояние системы (важно знать перед стартом)

- **Дефолтное ядро apple/container ЗАМЕНЕНО** на кастомное
  `6.18.5-cz-9275f365dd55` (с btrfs). Все новые `container`/machine бутятся
  с ним. Revert: `container system kernel set --recommended`.
- `~/projects/containerization` — клон apple/containerization@0.33.4 с
  правкой `kernel/config-arm64` (есть `.bak`). Артефакт ядра:
  `~/projects/containerization/kernel/vmlinux` (arm64 Image, 30MB).
- Outer-образ `local/incus-machine` (ubuntu 24.04 + systemd + incus 6.0 +
  btrfs-progs) собран из `exp-incus/Dockerfile`.

## Как воспроизвести с нуля (reference)

```bash
# 1. ядро с btrfs (~3.5 мин)
cd ~/projects && git clone --depth 1 -b 0.33.4 \
  https://github.com/apple/containerization.git
sed -i 's/^# CONFIG_BTRFS_FS is not set/CONFIG_BTRFS_FS=y/' \
  containerization/kernel/config-arm64
cd containerization/kernel && make TARGET_ARCH=arm64    # -> kernel/vmlinux
container system kernel set --arch arm64 --binary "$PWD/vmlinux" --force

# 2. outer образ + машина
cd ~/projects/orb
container build -t local/incus-machine -f exp-incus/Dockerfile exp-incus
container machine create local/incus-machine --name fleet-main \
  --cpus 4 --memory 8G --home-mount none

# 3. incus + btrfs (внутри fleet-main)
container machine run -n fleet-main sudo systemctl start incus
container machine run -n fleet-main sudo incus admin init --minimal
container machine run -n fleet-main sudo incus storage create btrfspool btrfs size=20GiB
container machine run -n fleet-main sudo incus launch images:ubuntu/24.04 base --storage btrfspool
container machine run -n fleet-main sudo incus copy base agent-1   # CoW, ~0.1s
```

## GOTCHAS (наступили на них в этом прогоне)

1. **`container machine run` коверкает составные команды** — пайпы, `&&`,
   `;`, кавычки, `bash -c '...'` ломаются молча (видели: docker install
   «прошёл» с exit 1; `time ...` вернул 0.000s). Передавать ТОЛЬКО чистый
   argv: `... run -n fleet-main sudo incus exec X -- apt-get install -y pkg`.
   Для составной логики — запекать скрипт в образ и звать одним токеном.
2. **incus требует root**: юзер (uid 501, `dmitrijilin`) НЕ в группе
   incus-admin. Все команды через `sudo incus …`. Для control-plane: либо
   добавить юзера в incus-admin в образе, либо ходить через sudo.
3. **dir-драйвер incus копирует через rsync, НЕ reflink** — даже на
   xfs-reflink FS. CoW даёт только btrfs/zfs/lvm-thin пул (отсюда ядро).
4. **xfs-on-loop не отдаёт POSIX ACL** — incus rsync на нём падает. Не
   использовать xfs для incus pool; btrfs работает.
5. **nesting для docker**: `incus config set <c> security.nesting=true` +
   restart, иначе docker внутри не стартует.
6. **boot не мгновенный**: после `machine create` ~6s до
   `systemd is-system-running=running`; до этого `machine run` может
   отвечать «Operation not supported by device». Control-plane должен поллить.
7. **btrfs «space used» ленивый** — для точных замеров `sync` +
   `btrfs filesystem df <pool-path>`.

## Маппинг Machines.ts (OrbStack -> Incus), подтверждён

| текущий вызов | OrbStack | Incus |
|---|---|---|
| `list` | `orbctl list -f json` | `incus list --format json` |
| `clone(from,to)` | `orbctl clone` | `incus copy <from> <to>` |
| `start/stop` | `orbctl start/stop` | `incus start/stop` |
| `delete` | `orbctl delete` | `incus delete -f` |
| `runInRepo` | `orb -m M bash -lc` | `incus exec M -- <argv>` |
| codex pty | `pty.spawn("orb",[-m,M,…])` | `pty.spawn("container",["machine","run","-n","fleet-main","sudo","incus","exec","-t",M,"--","codex-start"])` |

Все incus-вызовы из control-plane идут через обёртку
`container machine run -n fleet-main sudo incus …` ИЛИ напрямую к incus API
(unix-socket/https) из fleet-main — выбрать на шаге 3.

## Следующие шаги (план codex)

1. **[готово частично] Зафиксировать kernel build** — команды выше; можно
   вынести в `exp-incus/build-kernel.sh` (обернуть клон+sed+make+set).
2. **First-boot init fleet-main**: запечь в `local/incus-machine` systemd
   unit, который при первом старте делает `incus admin init` + создаёт
   btrfs-пул + bridge (idempotent). Чтобы `machine create` давал готовый
   fleet-main без ручных шагов. Файлы: `exp-incus/Dockerfile` +
   `exp-incus/firstboot-incus.sh`.
3. **MachinesIncus.ts** рядом с
   `control-plane/server/src/Machines.ts`: тот же интерфейс (`list/clone/
   start/stop/delete/runInRepo`), бэкенд через `container machine run …
   sudo incus …`. Выбор бэкенда — env (напр. `ORB_MACHINE_BACKEND`).
   Учесть: имена агентов = incus-контейнеры внутри fleet-main, не отдельные
   VM; `machineFor(n)` остаётся, меняется только исполнитель.
4. **Codex PTY**: проверить `incus exec -t` через `node-pty` в обёртке
   `container machine run`. Риск — mangling (gotcha #1): обязательно
   запечь `codex-start` скрипт в agent-образ и звать одним токеном.
   Проверить: спиннер-детект (OSC title) доходит, resize работает.
5. **Реальный shilo golden refresh + clone**: создать agent-base из репо
   shilo (git clone + deps + pg golden), мутировать на месте (pull/migrate),
   `incus copy` агента, поднять compose-in-vm внутри клона, прогнать e2e
   чеклист из HANDOFF-6.
6. **Сеть / VS Code polish** (после macOS 26): host → fleet-main → agent
   порты; SSH для VS Code Remote; DNS-имена агентов.

Критический путь: шаги 3–4 (control-plane + PTY). Storage/CoW — решён.

## Память — главный оставшийся риск (замерено 2026-06-19)

Storage решён, но **память — теперь главный реальный риск** и его надо
проверить stress-тестом до миграции на 5-10 агентов.

### Факты (эмпирика, не теория)

- **Balloon-устройства НЕТ.** Apple VZ для `container machine` создаёт
  virtio net/console/blk(×2)/fs/vsock/rng, но **не balloon** (device-id
  0x0005 отсутствует). Драйвер в ядре есть (`CONFIG_VIRTIO_BALLOON=y`,
  `BALLOON_COMPACTION=y`), но без устройства он не работает.
- **Footprint залипает (high-water mark) — доказано.** Сбросили page cache
  в guest (`sysctl vm.drop_caches=3`): кэш 3193MB → 287MB (освободилось
  ~2.9GB логически), а **host VZ footprint остался 3.8G — не упал**. Что
  guest однажды тронул (pull образов, build, btrfs, docker), хост держит
  резидентно до рестарта VM.
- Reset памяти только через `container machine stop`/restart (VZ-процесс
  умирает → 0). `incus stop` idle-агента снижает давление ВНУТРИ guest, но
  host footprint НЕ уменьшает.

### Нюанс в нашу пользу

Модель = **один общий outer VM на весь флот**, не VM-на-агента. Налог
памяти — ОДИН high-water mark на всех, с жёстким потолком от `--memory`.
Чище, чем apple/container-per-agent (там у каждого свой high-water).
Сравнение с OrbStack не катастрофично: OrbStack тоже держит тёплый VM и
отдаёт лениво/не до нуля (дрейф 3151→2474→2210 в EXPERIMENT-apple-container).
Разница: OrbStack медленно дрейфует вниз, apple/container стоит на
high-water до рестарта.

### Митигации без форка

1. **Жёсткий потолок**: `container machine create --memory 6G` (не дефолт
   «половина хоста» = 12G на 24GB). Footprint физически не превысит лимит.
2. **Per-agent cgroup**: `incus config set agent-N limits.memory 2GiB`.
3. Лимиты docker/pg/hasura внутри агента (уже в DECISION-compose-in-vm).
4. **Periodic restart fleet-main** при раздувании — единственный честный
   reset.

### R&D-путь (если налог станет больно)

Форк Containerization: добавить
`VZVirtioTraditionalMemoryBalloonDeviceConfiguration` + host-side policy
(периодически надувать balloon → guest отдаёт страницы → сдувать). Даёт
**ручной** balloon, НЕ эластичный авто-reclaim как у OrbStack (VZ
free-page-reporting не поддерживает). Реально, но это форк апстрима.
В custom kernel virtio_balloon уже включён — не хватает только host-стороны.

### TODO до продакшена

Отдельный **memory stress test**: 5-10 агентов с реальным compose-стеком
(pg+redis+hasura+backend), измерить host footprint флота под нагрузкой и
после idle, проверить что `--memory` потолок + per-agent limits держат
систему в рамках 24GB. Сделать ДО миграции.

### Balloon PoC (2026-06-19, Codex)

Сделан dirty fork `containerization` + локальный `container` staging:

- добавили `VZVirtioTraditionalMemoryBalloonDeviceConfiguration`;
- добавили debug control: `/tmp/containerization-balloon-target-bytes`;
- запустили `fleet-main` через patched runtime.

Результат:

- guest видит balloon: `/proc/meminfo` показывает `Balloon`;
- target 2G надул balloon до ~6.4G внутри guest;
- target 1G надул balloon до ~7.1G;
- но host `Virtualization.VirtualMachine.xpc` footprint **не упал**:
  после 5G stress вырос ~610M → ~5.6G и остался ~5.6G после balloon.

Вывод: простого “добавить VZ balloon device” недостаточно для OrbStack-like
reclaim. Нужен либо другой VZ механизм/режим, либо OrbStack делает более
глубокий reclaim, чем обычный virtio balloon в Apple VZ на текущем SDK.
