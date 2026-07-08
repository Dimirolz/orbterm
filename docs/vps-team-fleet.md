# VPS Team Fleet: агенты для команды на incus

Статус: идея / план PoC. Обсуждение: 2026-07-03.

Эволюция orbterm из локального инструмента в командный бекенд: админ тыкает
в элемент UI на проде, описывает задачу — изолированный агент на VPS выполняет
её и открывает draft PR с живым превью.

## Два мира

**Рабочая лошадка (бекенд):** VPS (Hetzner) + нативный incus + zfs/btrfs pool.
Мутабельный golden `base` (репо, deps, docker-стек, codex, git-креды) →
CoW-клон `task-abc-123` на задачу. Внутри — codex в интерактивной PTY-сессии.

**Фронтенды — дешёвые адаптеры.** Любой фронтенд лишь собирает fat prompt
и постит его. Agentation в проде, Linear label, TG-бот (voice→text), CLI,
orbterm web UI (наблюдение: attach, diff, маркеры статусов) — все равноправны.

```text
agentation (prod) │ TG voice │ Linear label │ CLI
        └──────────────┬──────────────┘
                       ▼
       POST /api/tasks {context, url, deploy SHA}
                       ▼
  VPS: incus copy base → task-N → codex (PTY) →
  draft PR + preview URL + комменты в Linear
```

Контракт держать микроскопическим: `createTask(context) → {taskId, attachUrl,
previewUrl}` + статус. Весь ум фронтенда — в сборке промпта, не в API.

## Ключевые решения

- **Sidequest-модель, не one-shot.** Задача = машина + живая PTY-сессия +
  fat prompt (как `createSidequest` в `server/src/Agents.ts`). Провал one-shot =
  мёртвый таск; провал сессии = «агент ждёт, подключись и дорули». `--yolo` всегда.
- **Ветку `agent/ABC-123` создаёт control plane** через `incus exec` до старта
  codex — naming не доверяем промпту. PR и push codex делает сам (`gh` в образе),
  всегда `gh pr create --draft`; «Ready for review» нажимает человек — это
  supervise-чекпоинт, перенесённый в асинхрон.
- **Lifecycle-сенсор — braille-спиннер в OSC-title** (уже написан:
  `detectStatus` в `server/src/Codex.ts`). working→idle + драфт есть →
  `review me`; идле без драфта → `needs attention` → attach из UI.
- **Linear — журнал, не фронтенд.** Любой фронтенд создаёт issue, агент
  репортит туда. Один ключ на всё: issue = имя машины = ветка = превью-домен.
- **Метаданные таска — на самой машине:** `incus config set task-N
  user.linear-issue=…`. Философия «state is derived, no database» сохраняется.
- **Supervisor вместо tmux.** Tmux — репейнтер вьюпорта, ломает append-only
  поток, на котором построен фронт (проверено, плевались). Вместо него ~100
  строк `orbterm-supervisor` внутри контейнера: node-pty спавнит codex, вывод
  append'ится в файл, unix-socket отдаёт replay + stream. Control plane —
  одноразовая линза: рестарт = re-attach ко всем живым таскам, агенты не
  замечают. Деплой = systemd restart, ~2 сек, без blue-green.
- **Превью из клона вместо Heroku (15 мин → секунды).** Клон уже содержит
  горячий контекст: deps, БД с сидами, ветку агента. Wildcard DNS
  `*.preview.…` → Caddy (TLS) → control plane как роутер: спит →
  `incus start` → health-wait → proxy. Idle-таймер тушит. Внутри — dev-режим
  (vite dev), билдить нечего. Auth перед превью обязателен (SSO/basic/VPN).
- **Клон живёт до закрытия issue,** не до PR: правки по ревью идут в ту же
  тёплую среду. Reaper по закрытым issue.
- **Секреты:** GitHub App с правами только на `agent/*` + PR; токены
  инжектятся в клон при старте, не запечены в golden. Egress ограничить
  (прод-контекст в промпте = prompt-injection surface).
- **Agentation, не react-grab, для прод-аннотаций.** React-grab силён source
  locations из React fiber — но это dev-only (в прод-бандле вырезано).
  Agentation — DOM-селектор + текст + styles + заметка, живёт в прод-DOM;
  путь к исходнику агенту не нужен, у него весь репозиторий. Гейтить по
  admin-флагу + lazy-load; кнопка «→ task» вместо copy-paste. React-grab —
  для локального dev inner loop, другой слой.
- **MUI-прод и emotion labels.** Emotion-хэши (`css-1a2b3c`) не грепаются, но
  якоря агента — текст, aria, URL и статичные `MuiButton-root`-классы.
  Усилитель: `@emotion/babel-plugin` c `autoLabel: 'always'` вшивает имя
  компонента в класс **и в проде** — `css-1a2b3c-CheckoutButton`. Одна строка
  конфига, копеечный bundle-cost, agentation-вывод получает имена компонентов
  без dev-сборки. Fallback, если не хватит: вечная превью-машина
  `agentic.domain` с dev-сборкой main (та же механика M3: incus + Caddy + SSO
  + cron git pull) — там работает react-grab с путями к файлам. Открытый
  вопрос fallback'а: данные (read-only прокси к прод-API vs staging).
- **Ребут хоста — деградация, не катастрофа.** Диск (пул, клоны, ветки,
  uncommitted-файлы), incus-конфиги и сессии codex (`~/.codex/sessions`
  в клоне) переживают. Умирает только живой процесс. Рецепт:
  `boot.autostart=true` на task-машинах; control plane при старте поднимает
  supervisor c `codex resume --last` для каждой живой task-машины — контекст
  разговора восстанавливается, теряется максимум незавершённый ход. Плановый
  ребут: дождаться idle всех тасков (сенсор есть) → reboot.

## План: каждый этап — демо

- **M1. Ядро руками.** VPS + incus + golden `base` (`security.nesting=true`).
  Скрипт `task.sh "промпт"`: copy → codex → push → draft PR. Демо: команда → PR.
- **M2. Control plane.** Порт orbterm-server: incus-драйвер в `Machines.ts`
  (маппинг готов в `experiments/incus/PLAN.md`), `POST /api/tasks`,
  supervisor, `working` в `GET /api/agents`. Демо: живой агент из браузера.
- **M3. Превью.** Wildcard DNS + Caddy + wake-on-request в control plane.
  Демо: ссылка из PR просыпается за ~5 сек.
- **M4. Linear + agentation.** Сначала лёгкая половина: создание issue +
  комменты через API. Webhook-триггер — потом. Agentation на staging.
  Демо полного цикла: ткнул → issue → агент → draft PR + превью.

## Риски: что закрыто, что осталось

Закрыто: incus + nested docker проверены на Hetzner (нужен свежий incus);
CoW-клоны — штатный режим нативного incus; codex показывает себя хорошо
в orbterm (с supervise — отсюда draft PR).

Осталось: качество one-shot'ов без человека рядом (хеджируется attach +
draft PR — деградация в «полуавтомат», не тупик); RAM VPS при N параллельных
проснувшихся превью (лечится idle-таймером); tmux-эксперимент можно
зафиксировать письменно в `experiments/`, чтобы не переигрывать.

## Мини-эксперименты перед M2

1. **supervisor** (пара часов, go/no-go): node-pty + unix-socket + файл внутри
   incus-контейнера; kill control plane посреди работы codex → reconnect →
   история цела, ввод работает.
2. **tmux post-mortem** (30 мин, опционально): задокументировать в
   `experiments/`, почему нет — alt-screen, copy-mode скролл, пустой
   scrollback, проглатывание OSC-title.
3. **MUI-контекст: agentation vs react-grab** (вечер, на рабочем проекте).
   5 типовых задач × 3 режима: (a) agentation на prod-сборке как есть,
   (b) prod + emotion `autoLabel: 'always'`, (c) react-grab на dev-сборке.
   Метрика: codex в клоне нашёл правильный файл с первого грепа / после
   блужданий / не нашёл. Если (a) или (b) дают 4/5 «с первого» —
   dev-домен не нужен.
