# Decision: перенести docker compose внутрь агентской VM

Дата: 2026-06-12. Статус: **реализуется радикальным упрощением**.

## Контекст

Сейчас зависимости агента (pg/redis/hasura) — это per-agent контейнеры на
ХОСТЕ (`orb-pg-n :154NN`, `orb-redis-n :163NN`, `orb-hasura-n :180NN`),
оркеструемые `control-plane/server/src/Hasura.ts`. Изначальная идея была
«shared heavy infra на хосте» (экономия памяти через дедупликацию), но по
факту дедупликации нет — контейнеры всё равно per-agent.

## Проблема: худшее из обоих миров

Память платим per-agent (как платили бы и внутри VM), а издержки
«хостового» размещения остались все:

- арифметика портов 154NN/163NN/180NN;
- `Hasura.envFor` хирургически режет хостовый `.env` (в котором Neon prod
  креды) и дописывает overrides;
- AUTH_HOOK через `shilo-agent-n.orb.local` + gotcha с macOS local-network
  permission (fallback `--add-host`);
- любое изменение docker-compose в репе нужно вручную зеркалить в Hasura.ts;
- агент видит «странное» окружение: нестандартные порты, сгенерированный
  .env, не может просто `docker compose up`.

Реально шарится только: docker engine, образы, golden pg volume (reflink),
temporal :7233.

## Решение

Запечь в `shilo-agent-base`: docker engine + спуленные образы
(postgres/redis/hasura) + golden pg data dir. Клон VM через CoW шарит это
по диску почти бесплатно (clone 0.07–0.38s). Из compose репы поднимать
внутри VM только pg + hasura + redis.

Что получаем:

- агент видит обычный dev-сетап: `docker compose up`,
  localhost:5432/6379/8080, AUTH_HOOK = localhost:8010, никакого .orb.local;
- `.env` агента = обычный dev `.env` репы; хостовый .env с prod-кредами
  вообще не участвует (бомба Neon решается естественно);
- Hasura.ts почти исчезает: `up(n)` -> `orb -m agent-n docker compose up -d`,
  `statusAll` -> `orb -m ... docker ps` (через существующий Sh), либо
  поднятие стека вообще отдаётся самому агенту;
- pg-данные живут на диске VM: переживают stop/start без volume-менеджмента;
- «stop освобождает память» сохраняется: VM stop гасит контейнеры внутри.

Цена по памяти: dockerd/containerd ~100–150 MB на агента (на фоне VS Code
Remote 660 MB idle — шум). Hasura 512m + pg + redis платим per-agent уже
сегодня.

## Что теряем

1. **Golden refresh через хостовый reflink** (секунды). В новой модели
   свежие pg-данные = перезапечь base VM. Операция нечастая, и п.4 плана
   handoff 06 всё равно ещё не сделан — приемлемо.
2. Хостовый `docker ps` как единая точка статуса — заменяется на
   `orb -m ... docker ps` per agent.

## Перед миграцией проверить

- docker engine внутри OrbStack-машины: поддерживается по докам OrbStack,
  но прогнать compose из репы в клоне base живьём + замерить idle dockerd;
- e2e чеклист из handoff 06 переиспользовать как есть: auth round-trip
  (hasura без secret = anonymous schema), кэш-ключ в свой redis,
  `grep neon` по .env агента = пусто.

## Текущее направление реализации

- host-managed `Hasura.ts` удалён;
- lifecycle control-plane теперь управляет VM и запускает `docker compose`
  внутри неё;
- compose services задаются через `ORB_HASURA_SERVICES`
  (default: `postgres graphql-engine`) и
  `ORB_BACKEND_DEP_SERVICES` (default: `redis-queue redis-cache temporal`);
- Temporal запускаем по дефолту, потому backend web держит к нему соединение;
  `temporalio/admin-tools` не нужен, CLI есть в `temporalio/temporal`;
- `doctor` проверяет docker/compose/pg/redis/hasura/backend/env safety внутри VM.
