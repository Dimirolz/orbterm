# Orb Agent Handoff 6 — путь к day-to-day использованию

Continues from `docs/handoffs/05-control-plane-mvp.md` (control plane MVP) and
`docs/handoffs/04-vertical-slice.md` (validated shell steps for the hasura stack).
Handoff 05's web UI work is **DONE**; this file is the plan for what remains
before the control plane is usable for daily work.

## Что сделано в сессии 2026-06-12 (пункты 1+2 плана — DONE)

```text
server/src/Sh.ts       NEW — shell-раннер + CommandFailed (выделен из Machines)
server/src/Hasura.ts   NEW — ensureGolden / up / halt / down / statusAll / envFor
server/src/Machines.ts теперь использует Sh
server/src/Agents.ts   агент = единая сущность: create/start поднимают VM+стек+
                       .env, stop гасит VM+стек (данные сохраняются), remove
                       удаляет всё; БЕЗ backend boot; doctor проверяет агентские
                       порты 154NN/163NN/180NN/7233 + :8010
server/src/main.ts     POST /api/agents/:n/stack/up (ремонт); HostEnvMissing->500
server/src/config.ts   pgPort/redisPort/hasuraPort, GOLDEN_VOLUME,
                       HOST_BACKEND_ENV (default ~/projects/shilo-ai-mono/
                       apps/backend/.env, переопределяется env-варом)
web                    stack-бейдж в строке агента (tooltip pg/redis/hasura),
                       кнопка «fix stack» при неполном стеке, api.stackUp
```

Детали и результаты проверок — в пунктах 1 и 2 плана ниже (помечены DONE).

## Что сделано в этой сессии (поверх handoff 05)

```text
web/src/App.tsx        DONE — React UI: sidebar (state dot, codex badge
                       idle/work-pulse), poll /api/agents каждые 2s, actions
                       new/start/stop/doctor/rm, doctor output в overlay <pre>,
                       error toast (не alert), main pane = CodexTerminal для
                       running агента / notice+start для stopped
web/src/App.css        DONE — тёмная тема с янтарным акцентом
web/src/index.css      DONE — reset + overflow:hidden (см. фикс ниже)
web/src/main.tsx       DONE — StrictMode убран (двойной ws connect в dev)
web/index.html         title "keen.fleet — codex agents"
DELETE /api/agents/:n  exercised, работает (kill pty -> stop -> delete)
```

### Важный фикс: скачущая страница (fit ↔ ResizeObserver loop)

Симптом: на определённой высоте окна страница бешено скакала.
Причина — двойная петля обратной связи:

1. `fit.fit()` в ResizeObserver меняет DOM xterm'а → снова триггерит
   ResizeObserver → снова fit. На «неудачной» высоте rows прыгает N↔N+1,
   каждый раз шлётся `{type:resize}` → SIGWINCH → codex перерисовывает TUI.
2. Терминал на пару px переполнял body → скроллбар появлялся/исчезал →
   менялась ширина → опять ResizeObserver.

Фикс (`web/src/CodexTerminal.tsx`): ResizeObserver дебаунсится через
requestAnimationFrame и перед fit вызывается `fit.proposeDimensions()` —
если cols×rows не изменились, не делаем ничего. Плюс `overflow: hidden` на
html/body/#root/#main/.termwrap. **Не убирать этот guard.**

## Текущее живое состояние

```text
machines:    shilo-agent-base (stopped, golden VM)
             shilo-agent-1 (running, свежая, стек поднят)
server:      :7070 (nohup tsx src/main.ts, лог /tmp/orb-cp.log;
             kill: lsof -ti :7070|xargs kill)
web dev:     :5180 (vite; :5173 занят ЧУЖИМ проектом пользователя — не трогать)
             запуск: (nohup node_modules/.bin/vite --port 5180 --strictPort \
                      </dev/null >/tmp/orb-web.log 2>&1 &) в control-plane/web
docker:      orb-pg-1 :15401, orb-redis-1 :16301, orb-hasura-1 :18001
volume:      orb_pg (/golden пересоздан из shilo-postgres-1, /agent_1)
```

## План (по приоритету)

### 1. HasuraService — per-agent стек приложения [DONE]

Портировано в Effect: `control-plane/server/src/Hasura.ts` (+ `Sh.ts` —
общий shell-раннер, выделен из Machines) + роуты + кнопка/бейдж в UI.

```text
сервис Hasura:
  ensureGolden  volume orb_pg + reflink из shilo_shilo_db_data (внутри
                docker stop/start shilo-postgres-1, Effect.ensuring гарантирует
                рестарт main даже при ошибке копии); вызывается лениво из up(n)
  up(n)         reflink /golden -> /agent_n (только если dir нет — данные
                агента переживают re-up), затем 3 контейнера:
                orb-pg-n     :154NN  postgres:15, PGDATA=/pgroot/agent_n
                orb-redis-n  :163NN  redis:7-alpine --save "" --appendonly no, 128m
                orb-hasura-n :180NN  hasura/graphql-engine:v2.40.0, 512m,
                                     AUTH_HOOK -> shilo-agent-n.orb.local:8010
  halt(n)       docker rm -f всех трёх, /agent_n ОСТАЁТСЯ («стоп» стека:
                контейнеры stateless, данные живут в data dir)
  down(n)       halt + rm /agent_n (вызывается только из remove)
  statusAll     docker ps -> Map<n, {pg,redis,hasura}>; в GET /api/agents
  envFor(n)     контент .env агента (см. п.2)

Агент = ЕДИНАЯ сущность (VM + стек + данные), lifecycle всегда целиком:
  create  clone VM + start + контейнеры + .env   (~2s: golden есть, reflink ~0.3s)
  start   VM start + контейнеры + переписать .env (~1s; pg-данные реюзаются)
  stop    kill codex + VM stop + halt (контейнеры снесены, данные сохранены,
          ~550MB RAM/агента освобождается)
  rm      stop + VM delete + down (данные удалены)
  POST /api/agents/:n/stack/up — только РЕМОНТ (контейнеры упали / шаблон
  .env изменился); в UI кнопка «fix stack» видна только когда running и
  стек неполный. Отдельного /stack/down нет — это работа stop.
проверено: pg-данные переживают stop/start (маркер-таблица survived)

ВАЖНО (поправка к ранним планам): control plane НЕ запускает бекенд в VM.
Бекенд (`cd apps/backend && pnpm backend:web`) поднимает сам агент (codex),
если/когда он нужен для проверки — для многих задач он не нужен вовсе.
Gotcha про рестарт остаётся актуальной ДЛЯ САМОГО агента: «мягкий» restart
не работает, нужен hard-kill (pkill -9 -f app.ts / nodemon), убедиться что
:8010 свободен, потом запуск.

gotchas из exp4 (не переоткрывать):
  - .orb.local резолвится из docker-контейнеров ТОЛЬКО после выдачи OrbStack
    macOS local-network permission; fallback: --add-host с IP VM
  - data-connector-agent per agent НЕ нужен
  - пустой redis url в .env = ioredis лезет на 127.0.0.1 и виснет вечно;
    /graphql виснет именно из-за useResponseCache -> redis
  - `pnpm backend:web` запускать из apps/backend (в корне репы скрипта нет)
```

### 2. Изоляция WRITE_DB/READONLY_DB [DONE]

Закрыта бомба exp4: dev `.env` бекенда указывал WRITE_DB/READONLY_DB на
**Neon prod**. Теперь `.env` агента генерируется control plane'ом
(`Hasura.envFor`): берётся хостовый `apps/backend/.env` как шаблон, строки
перекрываемых ключей вырезаются, в конец дописывается блок overrides:

```text
HASURA_URL=http://host.docker.internal:180NN
UPSTASH_REDIS_URL=UPSTASH_REDIS_CACHE_URL=redis://host.docker.internal:163NN
TEMPORAL_WORKER_ENABLED=false
WRITE_DB_*/READONLY_DB_* -> host.docker.internal:154NN, db postgres,
                            user postgres (агентский pg; Neon-креды в .env
                            агента НЕ попадают вообще — grep neon = 0)
```

Схемная совместимость проверена: public-таблицы Neon prod (141) vs agent pg
(136). Разница: pg_stat_statements{,_info} (вьюхи расширения, нерелевантно)
+ org_activity_rollup, user_insight_counts_window_result,
user_roleplay_counts_multi_window_result — в коде бекенда (knex-слой) НЕ
используются, фигурируют только в сгенерированной graphql-схеме (то же
ограничение, что у обычного dev-окружения на shilo-postgres-1).

E2E провалидировано на agent 1 (бекенд поднимался вручную как разовый тест):
boot OK на :8010, /auth/hasura -> anonymous, hasura без secret = 1 поле /
с secret = 502 поля (auth round-trip), /graphql 24ms, кэш-ключ записан в
СВОЙ orb-redis-1 (dbsize=1), Neon в env/логах отсутствует.

### 3. JobService + прогресс в UI

Create стал ~2s (backend boot из create убран — см. поправку в п.1), так что
срочность ниже, чем казалось. Но долгие операции остаются: первый ensureGolden
(стоп main pg + копия), golden refresh (п.4), будущий refresh base VM. Нужно:

```text
- долгие операции = jobs: id, status, лог построчно
- GET /jobs/:id, GET /jobs/:id/logs (или ws/SSE стрим)
- UI: строка агента показывает "provisioning…" с живым логом
  (паттерн overlay уже есть — doctor)
```

### 4. Golden refresh

Данные golden протухают от живого shilo-postgres-1, репа в shilo-agent-base —
от main. Кнопка/джоба:

```text
refresh pg golden:  stop main -> reflink свежий /golden -> start main
                    (секунды даунтайма main)
refresh base VM:    git pull + install/build в shilo-agent-base
                    (поведение было в oa как RepoService — oa/ ещё в репе
                    как референс)
```

### 5. Quality-of-life (полировка)

```text
- ссылки из строки агента: app :8010, hasura console :180NN, VS Code в VM
- control plane как launchd-сервис (сейчас nohup, умрёт при перезагрузке)
- git-выход: branch/push/PR из VM (gh уже зелёный в doctor — проверить
  сценарий целиком)
```

## Порядок

~~1+2~~ → 3 → 4 → 5. Пункты 1+2 сделаны: контур «создал агента → codex пишет
и при необходимости сам поднимает бекенд и проверяет на СВОЁМ стеке →
запушил» замкнут, прод из агента недостижим. 3 и 4 убирают трение, 5 —
полировка.

## Как проверять (повторять при каждом шаге)

```text
pnpm --filter server check          # tsc --noEmit
curl :7070/api/agents               # REST жив + stack {pg,redis,hasura}
открыть :5180, выбрать running agent -> codex TUI стримит, ввод работает,
переключение агентов сохраняет scrollback (server-side replay)
стек: query к orb-hasura-n БЕЗ admin secret отдаёт anonymous schema (1 field)
— доказательство auth_hook round-trip (бекенд в VM должен быть запущен
агентом); .env агента: grep neon = пусто, WRITE_DB_PORT = 154NN
```
