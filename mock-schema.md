 Да. Самый дешёвый способ: не запускать backend, а поднять tiny mock GraphQL server из уже сгенерированного SDL:

  pnpm exec tsx -e "
  import http from 'node:http';
  import { readFileSync } from 'node:fs';
  import { buildSchema, graphql, getIntrospectionQuery } from 'graphql';

  const schema = buildSchema(readFileSync('apps/backend/src/@modules/graphql/schema.gql', 'utf8'));

  http.createServer(async (req, res) => {
    if (req.method !== 'POST') return res.end('OK');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const result = await graphql({ schema, source: body.query ?? getIntrospectionQuery(), variableValues: body.variables });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  }).listen(8010, () => console.log('mock GraphQL on :8010/graphql'));
  "

  Потом:

  # reload Hasura remote schemas
  # затем
  pnpm --filter @shilo/graphql-api fetch-schema

  Важно: это годится для fetch-schema, потому что Hasura нужна только introspection schema. Реальные resolver’ы не нужны.

  Ограничение: если ты менял code-first backend GraphQL, сначала надо один раз реально сгенерить apps/backend/src/@modules/
  graphql/schema.gql.


› ооо, крайне прикольный хак... куда бы его записать чтобы запомнить


• Лучше не только в доку, а как runnable script.

  Я бы сделал так:

  1. packages/graphql-api/scripts/mock-backend-schema.ts
  2. script в packages/graphql-api/package.json:

  "serve-backend-schema": "tsx scripts/mock-backend-schema.ts"

  3. короткую заметку в docs/agents/domain.md или отдельный docs/agents/graphql-schema.md.

  Команда будет запоминаться так:

  pnpm --filter @shilo/graphql-api serve-backend-schema

  Это лучше, чем просто заметка: через месяц не надо будет заново собирать tsx -e "...".
