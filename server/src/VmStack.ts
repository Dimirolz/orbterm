import { Effect } from "effect"
import { BACKEND_DEP_SERVICES, HASURA_SERVICES, machineFor } from "./config.js"
import { Machines } from "./Machines.js"

export interface StackStatus {
  readonly pg: boolean
  readonly redis: boolean
  readonly hasura: boolean
}

export const stackUp = (s: StackStatus) => s.pg && s.redis && s.hasura

const NO_STACK: StackStatus = { pg: false, redis: false, hasura: false }

const detect = (out: string): StackStatus => {
  const text = out.toLowerCase()
  return {
    pg: text.includes("postgres"),
    redis: text.includes("redis"),
    hasura: text.includes("hasura") || text.includes("graphql-engine"),
  }
}

const startBackendSchemaMock = [
  "if test -f /tmp/orb-backend-schema-mock.pid; then kill $(cat /tmp/orb-backend-schema-mock.pid) >/dev/null 2>&1 || true; rm -f /tmp/orb-backend-schema-mock.pid; fi",
  "test -f apps/backend/src/@modules/graphql/schema.gql",
  `(
    pnpm --filter @shilo/graphql-api exec tsx -e '
      import http from "node:http";
      import { readFileSync } from "node:fs";
      import { buildSchema, graphql } from "graphql";

      process.title = "orb-backend-schema-mock";

      const schema = buildSchema(readFileSync("../../apps/backend/src/@modules/graphql/schema.gql", "utf8"));
      const server = http.createServer(async (req, res) => {
        if (req.method !== "POST") {
          res.end("OK");
          return;
        }

        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const result = await graphql({
          schema,
          source: body.query,
          variableValues: body.variables,
          operationName: body.operationName,
        });

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      });

      server.listen(8010, "0.0.0.0", () => console.log("mock backend schema on :8010"));
      setTimeout(() => process.exit(2), 120000);
    ' >/tmp/orb-backend-schema-mock.log 2>&1 &
    echo $! >/tmp/orb-backend-schema-mock.pid
  )`,
  `ready=0
  for i in $(seq 1 60); do
    if curl -fsS http://localhost:8010/graphql >/dev/null; then
      ready=1
      break
    fi
    sleep 0.25
  done
  test "$ready" = 1`,
].join(" && ")

const stopBackendSchemaMock =
  "if test -f /tmp/orb-backend-schema-mock.pid; then kill $(cat /tmp/orb-backend-schema-mock.pid) >/dev/null 2>&1 || true; rm -f /tmp/orb-backend-schema-mock.pid; fi"

const waitHasuraConsistent = [
  `ready=0
  for i in $(seq 1 120); do
    if curl -fsS \
      -H "x-hasura-admin-secret: hasura_graphql_admin_secret" \
      -H "content-type: application/json" \
      http://localhost:8080/v1/metadata \
      -d '{"type":"get_inconsistent_metadata","args":{}}' \
      | grep -q '"is_consistent":true'; then
      ready=1
      break
    fi
    sleep 0.5
  done
  test "$ready" = 1`,
  stopBackendSchemaMock,
].join(" && ")

const configureBrowserHasuraEnv = (machine: string) => [
  `hasura_url="http://${machine}.orb.local:8080"`,
  `for file in apps/web/.env.development.local apps/fub-app/.env; do
    test -f "$file" || continue
    perl -0pi -e 's#^REACT_APP_HASURA_URL=.*$#REACT_APP_HASURA_URL="'$hasura_url'"#mg' "$file"
  done`,
].join(" && ")

export class VmStack extends Effect.Service<VmStack>()("VmStack", {
  dependencies: [Machines.Default],
  effect: Effect.gen(function* () {
    const machines = yield* Machines

    const status = (n: number) =>
      machines
        .runInRepo(machineFor(n), `docker ps --format '{{.Names}} {{.Image}}'`)
        .pipe(Effect.map(detect), Effect.catchAll(() => Effect.succeed(NO_STACK)))

    const up = (n: number) =>
      machines.runInRepo(
        machineFor(n),
        (() => {
          const machine = machineFor(n)
          const hasuraAppServices = HASURA_SERVICES.filter((s) => s !== "postgres")
          return [
            configureBrowserHasuraEnv(machine),
            `${startBackendSchemaMock} || true`,
            "cd hasura",
            "docker compose up -d postgres",
            hasuraAppServices.length ? `docker compose up -d --no-deps ${hasuraAppServices.join(" ")}` : ":",
            "docker update --memory 712m --memory-swap 712m shilo-graphql-engine-1 >/dev/null 2>&1 || true",
            waitHasuraConsistent,
            `cd ../apps/backend && docker compose up -d ${BACKEND_DEP_SERVICES.join(" ")}`,
          ].join(" && ")
        })(),
      )

    return { up, status }
  }),
}) {}
