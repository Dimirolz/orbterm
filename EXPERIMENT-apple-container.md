# Experiment: apple/container вместо OrbStack

Дата заметки: 2026-06-12. Статус: **тесты 1–3 пройдены** (на macOS
15.6.1!). Оба главных риска сняты: docker compose работает внутри
machine, create из жирного образа <1s при ~181M диска на machine.
Обсуждение: https://ampcode.com/threads/T-019ebd37-899f-75da-8660-40f2022e6c8d

## Мотивация

Не зависеть от платного закрытого OrbStack. Apple выпустила
`container machine` (https://github.com/apple/container, склонирован в
`~/projects/container`) — полноценное Linux-окружение в лёгкой VM,
создаваемое из OCI-образа, с init-системой (systemd работает).

## Почему это маппится на наш UX почти 1:1

- `machine create/run/stop/rm/ls/inspect` ≈ `orbctl` — в control-plane
  затронет только `Machines.ts` (32 строки) + `Sh.ts`/`Codex.ts` (PTY через
  `container machine run -n <name>`).
- Замороженная `shilo-agent-base` VM → **Dockerfile/OCI-образ**: лучше —
  воспроизводимо, версионируется, шарится через registry.
- Решение compose-in-vm (см. DECISION-compose-in-vm.md) упрощает миграцию:
  внутри machine нужен только docker engine, без `.orb.local` /
  `host.docker.internal` магии.
- Apache 2.0, бесплатно.

## Риски (по убыванию)

1. **Docker engine внутри machine не проверен.** Apple шипует минимальное
   ядро — могут отсутствовать модули (overlayfs, iptables/nftables).
   На этом висит всё решение compose-in-vm.
2. **Нет `clone`.** Замена — `machine create` из образа. Скорость создания
   из жирного образа (repo+deps, ~гигабайты) неизвестна. Orb CoW clone =
   0.07–0.38s — это бенчмарк для сравнения. Reflink-трюк с golden pg
   volume не переносится; pg data dir можно запечь слоем образа.
3. **macOS 26 нужна для полной сети.** На macOS 15 работает, но:
   контейнеры изолированы друг от друга, нет `container network`,
   возможны проблемы с subnet (см. их troubleshooting.md). Для нас
   терпимо — compose живёт внутри machine.
4. **Память.** Дефолт machine — половина памяти хоста; поведение при 5–10
   агентах неизвестно. У OrbStack — ballooning. Хост: M4 Pro, 24 GB.
5. **Зрелость**: фиче `machine` дни от роду.
6. **Time-to-ready хуже orb.** У orb: clone → codex за ~3–4s. Здесь
   `create` = 0.8s, но boot до готовности ~15–30s (не мерено точно;
   включает first-boot провижининг юзера). Митигации:
   - **warm pool** в control-plane: держать 1–2 забутившиеся machines
     в запасе, clone выдаёт готовую мгновенно (~20 строк в Agents.ts);
   - срезать first-boot: запечь юзера (uid 501) в образ + no-op
     `/etc/machine/create-user.sh`, замаскировать лишние systemd-юниты —
     голый systemd бутится за 2–5s;
   - правильная метрика для теста: **time-to-codex**, не time-to-create.

## План экспериментов

Можно начинать на текущей macOS 15.6.1 (тесты 1–3 не зависят от хостовой
сети). Тест 4 валиден только после апгрейда на macOS 26 (Tahoe 26.5.1
доступна, M4 Pro поддерживается; перед апгрейдом — `orbctl stop` всем VM).

1. **Smoke — ПРОЙДЕН** (2026-06-12, container 1.0.0, macOS 15.6.1):
   - установлен пакет 1.0.0 + kata-ядро 3.28 (569 MB, один раз);
   - alpine:latest из их quickstart НЕ работает как machine (нет openrc);
   - `container build` ubuntu 24.04 + systemd (Dockerfile из
     docs/container-machine.md → exp-apple-container/Dockerfile) — ок;
   - `container machine create local/ubuntu-machine --name dev
     --home-mount none` (изоляцию держим, ~/projects не монтируем);
   - systemd `is-system-running` = running, user auto-provisioned,
     passwordless sudo работает, machine получила IP 192.168.64.4;
   - gotcha: `machine run -n dev -- sh -c "..."` падает с "Operation not
     supported by device", одиночные команды работают.
2. **Главный тест — docker внутри machine — ПРОЙДЕН** (2026-06-12):
   - docker-ce запечён в образ (см. exp-apple-container/Dockerfile:
     официальный apt-репо + `systemctl enable docker`);
   - внутри machine: docker 29.5.3, storage driver **overlayfs**,
     cgroup v2 — kata-ядро 3.28 всё тянет;
   - `docker compose up` (postgres:15 + redis:7 + hasura v2.40.0) — все
     поднялись, bridge-сеть и DNS между контейнерами работают,
     hasura `/healthz` = OK, pg accepting connections;
   - **бонус, сеть работает уже на macOS 15**: host → machine
     (`curl 192.168.64.7:8080/healthz` = OK) и machine → host gateway
     (ping 192.168.64.1) — т.е. бо́льшая часть теста 4 уже зелёная;
   - gotchas: `machine run` коверкает составные команды (sh -c, кавычки,
     `--format` с пробелами) — control-plane'у передавать команды
     одиночными argv или скриптами, запечёнными в образ;
     hasura упал на первом старте (гонка с pg) — в реальном compose
     нужен healthcheck/depends_on condition, у нас в репе он есть.
3. **Скорость create из жирного образа — ПРОЙДЕН** (2026-06-12):
   - `machine create` = **0.65–0.8s** независимо от размера образа
     (тестировано на +3GB слое поверх ubuntu+docker);
   - слои образа распаковываются один раз в shared snapshots
     (~/Library/Application Support/com.apple.container/snapshots),
     rootfs каждой machine — APFS CoW: **~181M реального диска на
     machine** при guest-visible 3.9G;
   - сопоставимо с orb clone 0.07–0.38s — разница не имеет значения;
   - нюанс: boot до готовности (first-boot user provisioning) ~15–30s,
     в это время `machine run` отвечает "Operation not supported by
     device" — control-plane должен поллить готовность;
   - итого осталось только №4: добить host→machine порты для auth hook
     и machine→host temporal :7233 (ping gateway уже работает).
4. **Сеть (после macOS 26)**: host → machine (auth hook, codex pty),
   machine → host gateway (temporal :7233).

## Golden refresh: как обновлять base (обсуждение 2026-06-13)

Вопрос: сейчас golden refresh = открыть `shilo-agent-base`, прогнать
`git pull dev` / pg migrations / hasura metadata apply / deps install /
package build / graphql generate — и от свежего base клонировать агентов.
Как это лечь на apple/container?

### Ключевой факт: нет ни `clone`, ни `commit`

Команды machine: `create` (из OCI-образа), `run`, `stop`, `delete`,
`inspect`, `list`, `logs`, `set`, `set-default`. **Нет** `machine clone`,
**нет** `machine commit`/`export`. `container export` (rootfs в tar) есть,
но работает над *container*, не над *machine*.

Это ломает петлю, на которой стоит нынешний golden refresh в OrbStack:
там golden = мутабельная VM (refresh на месте) + CoW-clone VM. В
apple/container машину нельзя ни склонировать, ни снять с неё образ.
Источник агентов — ТОЛЬКО OCI-образ:

```text
OrbStack:  base(VM) --refresh in place--> свежий base --CoW clone--> agent-N
apple/container:  golden image --machine create (0.65-0.8s, APFS CoW)--> agent-N
                  (мутировать machine можно, но клонировать/коммитить нельзя)
```

Вывод: golden-состояние обязано жить **в OCI-образе**, golden refresh =
**пересборка образа** (`container build`), а не мутация VM на месте.
Согласуется с DECISION-compose-in-vm (golden pg data запекать слоем образа).

### Дельта-миграции при пересборке: ДА, переносится

Боль: 480+ миграций, прогон начисто очень долгий. Прелесть текущего base —
накатить только дельту со вчера. В apple/container это решается не
buildkit-кэшем, а **цепочкой образов**: `FROM golden:day-(N-1)`.

Новый образ наследует все слои вчерашнего, включая запечённый pg data dir
со всеми уже применёнными миграциями. Один `RUN`: поднять pg → migrate →
погасить. Тулинг миграций смотрит в `schema_migrations` (внутри
унаследованного data dir) и накатывает **только дельту** — ровно как сейчас.

```text
golden:day-(N-1)  ← ubuntu+docker+deps + pg data (480 миграций)
   │ FROM golden:day-(N-1); RUN start pg -> migrate(+3 новых) -> codegen -> stop
   ▼
golden:day-N      ← те же слои + НОВЫЙ слой с diff (3 миграции, codegen)
```

Дельта именно за счёт `FROM`-цепочки, НЕ за счёт buildkit-кэша: шаг
`migrate` гоняется каждый день (не кэшируем), но быстрый — БД уже содержит
вчерашнее состояние.

Нюансы:
- **Рост слоёв**: каждый день +слой с diff pg data dir (чуть больше чистой
  дельты — postgres трогает vacuum/WAL/vm). Периодически (раз в нед/мес)
  делать baseline: сборка начисто всех миграций → новый `golden:base`,
  дальше снова дельта поверх. Тяжёлый полный прогон = редкая фоновая опер.
- Приватный `git pull` в build — `container build --secret id=...`
  (секрет не оседает в слоях).
- pull/deps/package build — обычные слои с кэшем.

### Открытые вопросы для PoC (если вернёмся)

1. Реально ли поднять pg+hasura **внутри build-шага** (`RUN` стартует pg в
   фоне, migrate/metadata apply/codegen, стоп) — codegen требует живую
   hasura. Сборка идёт в их builder-VM/buildkit.
2. pg data dir, запечённый слоем, валиден ли как golden при бутстрапе
   machine из образа (не пустой/битый PGDATA).
3. Замер: время дневной пересборки и размер дневного слоя.

### Чего точно НЕ будет: clone существующего агента в нового

OrbStack умеет склонировать *уже работающего* агента (со всем его текущим
состоянием) в нового. В apple/container так не выйдет: машину нельзя
склонировать. Новый агент всегда рождается из образа, а не из живой
машины. Насколько эта функция важна — неясно (возможно, и не нужна), но
ограничение надо держать в голове.

## Альтернативная мысль: apple/container только как outer machine, Incus внутри

Не обязательно пытаться «повторить OrbStack» средствами самого
`apple/container`. Возможно, правильнее использовать его только как бесплатную
надёжную outer Linux VM:

```text
macOS
  └─ container machine: fleet-main
       └─ Incus
            ├─ agent-1  (system container)
            ├─ agent-2  (system container)
            └─ agent-N  (system container)
```

Тогда удобство уровня OrbStack делаем уже внутри `fleet-main` через Incus:
system containers вместо полноценных nested VM, snapshots/clones, профили,
storage pools, per-agent rootfs, отдельные сети и понятный API.

Почему это интересно:

- возвращает модель «один общий Linux engine, много лёгких окружений»;
- `agent-N` снова может быть machine-like dev box, а не один Docker-процесс;
- clone/snapshot можно получить от Incus/storage backend, не от
  `container machine`;
- golden refresh может снова быть мутабельным: обновили base container →
  snapshot/clone новых агентов;
- общий image/cache/storage живёт внутри одной outer machine;
- меньше зависимости от отсутствующих `machine clone` / `machine commit`.

Риски и вопросы:

- изоляция слабее, чем отдельная VM на агента: общий kernel внутри
  `fleet-main`;
- Docker-in-Incus потребует nesting/privileged-настроек, надо проверить;
- нужен нормальный storage backend внутри outer machine: btrfs/zfs/dir +
  фактический CoW/disk growth;
- сеть host macOS ↔ outer machine ↔ Incus agents потребует явного дизайна;
- Incus VM mode не нужен на старте: это снова nested virtualization.

Каких «плюшек OrbStack» будет не хватать или придётся писать самим:

- macOS-интеграции: DNS имён машин, localhost/port forwarding, SSH aliases;
- гладкий host filesystem sharing и быстрый доступ редактора к файлам;
- memory ballooning/pressure UX и аккуратная амортизация общего engine;
- удобный CLI/GUI слой вокруг list/start/stop/clone/delete;
- готовая интеграция Docker Desktop-compatible socket/contexts;
- polished lifecycle: sleep/wake, автозапуск, graceful cleanup, logs;
- security defaults, чтобы UI/control-plane не стал дырой в host shell.

Вывод: это перспективнее, чем пытаться ждать от `apple/container machine`
полного OrbStack-клона. `apple/container` даёт нам outer VM и macOS bridge,
Incus внутри может дать именно fleet primitives: clone/snapshot/profiles.

### Статус решения (2026-06-13)

OrbStack пока устраивает для дальнейшего прогресса — остаёмся на нём.
Направление apple/container интересное (бесплатно, воспроизводимо,
golden-as-image с дельта-миграциями через FROM-цепочку работает на бумаге),
но не блокирует и не приоритет сейчас. Вернуться при необходимости уйти от
платного закрытого OrbStack или при апгрейде на macOS 26 (полная сеть).

## Замер памяти: apple/container vs OrbStack (2026-06-13)

Меряли overhead одной idle ubuntu-machine (та же ubuntu noble, M4 Pro 24GB).

**Метрика важна.** Сначала мерили `ps rss` — он ЗАВЫШАЕТ (считает шаренные
страницы). Правильная цифра, та что в Activity Monitor («Memory») —
**`Physical footprint`** (`vmmap --summary <pid> | grep "Physical footprint"`).
Ниже — footprint; rss приведён в скобках для справки.

### apple/container (отдельный VZ-процесс на machine)

Образ `local/ubuntu-machine` (ubuntu 24.04 + systemd + docker), `--memory 2G`:

| Метрика | footprint | (rss) |
|---|---|---|
| Хост: `Virtualization.VirtualMachine.xpc` | 589 MB | (823) |
| Хост: helper `container-runtime-linux` | 18 MB | (31) |
| **Итого на запущенную machine** | **~607 MB** | (~855) |
| Гость: used (idle, systemd+docker) | ~159 MB | |
| После `machine stop` | процесс умирает → **0** | |

Зависит от `--memory` (ставили 2G — с меньшим лимитом меньше).

### OrbStack (один общий движок на ВСЕ machine)

| Метрика | footprint | (rss) |
|---|---|---|
| Baseline, всё stopped + 0 контейнеров | **~845 MB** | (~2.2 GB) |
| С 1 запущенной ubuntu | **~1.3 GB** | |
| → инкремент на machine | **~+455 MB** | (~200 rss) |
| Гость: used | ~1.2 GB | |
| После `stop` | падает **лениво и не до нуля** | |

OrbStack держит «тёплый» общий Linux-VM резидентно, пока приложение
открыто; память отдаёт, но медленно. Наблюдали дрейф rss-пола после
гашения контейнеров: 3151 → 2474 → 2210 MB (footprint в тот момент ~914).

### Вывод

```text
apple/container:  cost ≈ 0.6 GB × N          (нет общего baseline, чистый stop → 0)
OrbStack:         cost ≈ ~0.85 GB пол + 0.45 GB × N  (общий движок)
```

Точка пересечения ≈ **6 агентов** (`0.85 + 0.45N = 0.6N` → N≈5.7).

- **< ~6 агентов одновременно** — apple/container ест МЕНЬШЕ footprint
  (нет постоянного ~0.85 GB налога). 1 агент: ~0.6 GB против ~1.3 GB.
- **> ~6 агентов** — OrbStack выигрывает: движок амортизируется.
- `stop`: apple/container честно возвращает память сразу; OrbStack —
  лениво.

Для типичного сценария (единицы агентов на M4 Pro) по голому VM-overhead
**apple/container экономнее**. Реальный потолок всё равно задаст стек
внутри (hasura 512m + pg + redis ≈ ещё ~0.8–1 GB на агента) — он платится
в обеих моделях.

## Критерий успеха

Агент внутри `container machine` видит тот же dev-сетап, что и в orb VM:
`docker compose up`, localhost:5432/6379/8080, codex работает через PTY,
создание нового агента — секунды, не минуты.
