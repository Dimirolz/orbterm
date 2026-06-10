import { Data, Effect } from "effect"
import * as Codex from "./Codex.js"
import { BASE_MACHINE, MACHINE_RE, machineFor } from "./config.js"
import { Machines } from "./Machines.js"

export class MachineNotFound extends Data.TaggedError("MachineNotFound")<{
  readonly machine: string
}> {}

export interface AgentInfo {
  readonly n: number
  readonly name: string
  readonly state: string
  readonly codex: boolean
  readonly working: boolean
}

/** Agent lifecycle. State is always derived live from orbctl + pty sessions. */
export class Agents extends Effect.Service<Agents>()("Agents", {
  dependencies: [Machines.Default],
  effect: Effect.gen(function* () {
    const machines = yield* Machines

    const list: Effect.Effect<Array<AgentInfo>, never, never> = machines.list.pipe(
      Effect.map((all) =>
        all
          .flatMap((m) => {
            const match = MACHINE_RE.exec(m.name)
            if (!match) return []
            return [{ n: Number(match[1]), name: m.name, state: m.state, ...Codex.sessionStatus(m.name) }]
          })
          .sort((a, b) => a.n - b.n),
      ),
      Effect.orDie,
    )

    const requireAgent = (n: number) =>
      list.pipe(
        Effect.flatMap((agents) => {
          const agent = agents.find((a) => a.n === n)
          return agent ? Effect.succeed(agent) : Effect.fail(new MachineNotFound({ machine: machineFor(n) }))
        }),
      )

    return {
      list,

      /** Clone base -> next free number, start it. */
      create: Effect.gen(function* () {
        const agents = yield* list
        const used = new Set(agents.map((a) => a.n))
        let n = 1
        while (used.has(n)) n++
        const machine = machineFor(n)
        yield* machines.clone(BASE_MACHINE, machine)
        yield* machines.start(machine)
        return { n, name: machine }
      }),

      start: (n: number) =>
        requireAgent(n).pipe(Effect.zipRight(machines.start(machineFor(n)))),

      stop: (n: number) =>
        requireAgent(n).pipe(
          Effect.tap(() => Effect.sync(() => Codex.killSession(machineFor(n)))),
          Effect.zipRight(machines.stop(machineFor(n))),
        ),

      remove: (n: number) =>
        requireAgent(n).pipe(
          Effect.tap(() => Effect.sync(() => Codex.killSession(machineFor(n)))),
          Effect.zipRight(machines.stop(machineFor(n)).pipe(Effect.ignore)),
          Effect.zipRight(machines.delete(machineFor(n))),
        ),

      stopCodex: (n: number) => Effect.sync(() => Codex.killSession(machineFor(n))),

      doctor: (n: number) =>
        requireAgent(n).pipe(
          Effect.zipRight(
            machines.runInRepo(
              machineFor(n),
              `
              echo "node:  $(node --version)"
              echo "pnpm:  $(pnpm --version)"
              echo "codex: $(codex --version)"
              echo "gh:    $(gh api user --jq .login 2>/dev/null || echo NOT-AUTHED)"
              echo "repo:  $(git branch --show-current)"
              echo "--- host infra ---"
              for p in 5432 6379 8080 7233; do
                (exec 3<>/dev/tcp/host.docker.internal/$p) 2>/dev/null && echo "$p OK" || echo "$p FAIL"
              done
              `,
            ),
          ),
        ),
    }
  }),
}) {}
