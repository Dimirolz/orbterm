# Orb Agent Handoff 6 — путь к day-to-day использованию

Continues from `HANDOFF-5-control-plane-mvp.md` (control plane MVP) and
`HANDOFF-4-vertical-slice.md` (validated shell steps for the hasura stack).
HANDOFF-5's web UI work is **DONE**; this file is the plan for what remains
before the control plane is usable for daily work.

## Что сделано в этой сессии (поверх HANDOFF-5)

```text
web/src/App.tsx        DONE — React UI: sidebar (state dot, codex badge
                       idle/work-pulse), poll /api/agents каждые 2s, actions
                       new/start/stop/doctor/rm, doctor output в overlay <pre>,
                       error toast (не alert), main pane = CodexTerminal для
                       running агента / notice+start для stopped
web/src/App.css        DONE — тёмная тема с янтарным "orb" акцентом
web/src/index.css      DONE — reset + overflow:hidden (см. фикс ниже)
web/src/main.tsx       DONE — StrictMode убран (двойной ws connect в dev)
web/index.html         title "orb — codex agents"
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
             shilo-agent-1, shilo-agent-2 (running, свежие)
server:      :7070 (nohup, лог /tmp/orb-cp.log; kill: lsof -ti :7070|xargs kill)
web dev:     :5180 (vite; :5173 занят ЧУЖИМ проектом пользователя — не трогать)
             запуск: (nohup node_modules/.bin/vite --port 5180 --strictPort \
                      </dev/null >/tmp/orb-web.log 2>&1 &) в control-plane/web
docker:      orb-* контейнеров НЕТ, volume orb_pg УДАЛЁН (exp4 cleanup был
             выполнен) — golden pg придётся создавать заново, команды в
             HANDOFF-4 "Exact commands that worked"
```

## План (по приоритету)

### 1. HasuraService — per-agent стек приложения [главный блокер]

Сейчас агент = VM с codex и репой, но приложение в нём не работает: нет
своей pg/redis/hasura → codex не может запустить и проверить написанное.
Все команды валидированы в exp4 (HANDOFF-4), осталось портировать в Effect
(`control-plane/server/src/Hasura.ts` + роуты + кнопка в UI):

```text
golden (one-time + refresh, см. п.4):
  docker stop shilo-postgres-1
  docker volume create orb_pg
  docker run --rm -v shilo_shilo_db_data:/src:ro -v orb_pg:/dst \
    debian:stable-slim bash -c 'cp --reflink=always -a /src /dst/golden'
  docker start shilo-postgres-1

up(n):  reflink /golden -> /agent_n (~0.3s, ~0 disk)
        orb-pg-n     :154NN  postgres:15, PGDATA=/pgroot/agent_n
        orb-redis-n  :163NN  redis:7-alpine --save "" --appendonly no, 128m
        orb-hasura-n :180NN  hasura/graphql-engine:v2.40.0, 512m,
                             AUTH_HOOK -> http://shilo-agent-n.orb.local:8010/auth/hasura
        точные env-флаги hasura: HANDOFF-4, Step 4
down(n): docker rm -f orb-pg-n orb-redis-n orb-hasura-n + rm /agent_n
         (вызывать из DELETE /api/agents/:n)

per-agent .env в VM (поверх apps/backend/.env):
  HASURA_URL=http://host.docker.internal:180NN
  UPSTASH_REDIS_URL=UPSTASH_REDIS_CACHE_URL=redis://host.docker.internal:163NN
  TEMPORAL_WORKER_ENABLED=false
  + WRITE_DB/READONLY_DB -> agent pg (см. п.2!)

backend start/restart в VM:
  hard-kill старого nodemon обязателен (pkill -9 -f app.ts), убедиться что
  :8010 свободен, потом запуск; "мягкий" restart НЕ работает — старый процесс
  держит порт и старый конфиг (gotcha из exp4)

gotchas из exp4 (не переоткрывать):
  - .orb.local резолвится из docker-контейнеров ТОЛЬКО после выдачи OrbStack
    macOS local-network permission; fallback: --add-host с IP VM
  - data-connector-agent per agent НЕ нужен
  - пустой redis url в .env = ioredis лезет на 127.0.0.1 и виснет вечно;
    /graphql виснет именно из-за useResponseCache -> redis
```

### 2. Изоляция WRITE_DB/READONLY_DB [делать вместе с п.1]

Открытый вопрос exp4: dev `.env` бекенда указывает WRITE_DB/READONLY_DB на
**Neon prod**. Для day-to-day это бомба — codex может мутировать прод.
Направить на agent pg (`host.docker.internal:154NN`) и проверить схемную
совместимость (agent pg = клон shilo-postgres-1, схема может отличаться от
Neon prod). Без этого пункта панелью пользоваться нельзя.

### 3. JobService + прогресс в UI

Полный create (clone VM + pg clone + 3 контейнера + .env + backend boot) —
минуты, а не 0.14s как сейчас. Нужно:

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

1+2 → 3 → 4 → 5. После 1+2 замыкается контур «создал агента → codex пишет и
сам проверяет на живом стеке → запушил» — с этого момента панель пригодна
для ежедневной работы. 3 и 4 убирают трение, 5 — полировка.

## Как проверять (повторять при каждом шаге)

```text
pnpm --filter server check          # tsc --noEmit
curl :7070/api/agents               # REST жив
открыть :5180, выбрать running agent -> codex TUI стримит, ввод работает,
переключение агентов сохраняет scrollback (server-side replay)
после п.1: query к orb-hasura-n БЕЗ admin secret должен отдать anonymous
schema (1 field) — доказательство auth_hook round-trip, см. HANDOFF-4
```
