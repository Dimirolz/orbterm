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
          const hasuraAppServices = HASURA_SERVICES.filter((s) => s !== "postgres")
          return [
            "cd hasura",
            "docker compose up -d postgres",
            hasuraAppServices.length ? `docker compose up -d --no-deps ${hasuraAppServices.join(" ")}` : ":",
            "docker update --memory 512m --memory-swap 512m shilo-graphql-engine-1 >/dev/null 2>&1 || true",
            `cd ../apps/backend && docker compose up -d ${BACKEND_DEP_SERVICES.join(" ")}`,
          ].join(" && ")
        })(),
      )

    const doctor = (n: number) =>
      machines.runInRepo(
        machineFor(n),
        `
        echo "node:   $(node --version)"
        echo "pnpm:   $(pnpm --version)"
        echo "codex:  $(codex --version)"
        echo "gh:     $(gh api user --jq .login 2>/dev/null || echo NOT-AUTHED)"
        echo "repo:   $(git branch --show-current)"
        echo "--- docker ---"
        docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}' 2>/dev/null || echo "docker FAIL"
        echo "--- compose ---"
        (cd hasura && docker compose ps) 2>/dev/null || echo "hasura compose unavailable"
        (cd apps/backend && docker compose ps) 2>/dev/null || echo "backend compose unavailable"
        echo "--- services ---"
        for p in 5432:postgres 16379:redis-queue 26379:redis-cache 8080:hasura; do
          port=\${p%%:*}; name=\${p##*:}
          (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && echo "$name :$port OK" || echo "$name :$port down"
        done
        echo "--- temporal optional ---"
        docker image inspect temporalio/temporal >/dev/null 2>&1 && echo "temporal image OK" || echo "temporal image missing"
        (exec 3<>/dev/tcp/127.0.0.1/7233) 2>/dev/null && echo "temporal :7233 UP" || echo "temporal stopped"
        echo "--- backend ---"
        (exec 3<>/dev/tcp/127.0.0.1/8010) 2>/dev/null && echo "backend :8010 UP" || echo "backend :8010 down"
        echo "--- env safety ---"
        if test -f apps/backend/.env; then
          grep -Eiq 'neon|prod' apps/backend/.env && echo "env WARNING: neon/prod marker found" || echo "env OK"
        else
          echo "apps/backend/.env missing"
        fi
        `,
      )

    return { up, status, doctor }
  }),
}) {}
