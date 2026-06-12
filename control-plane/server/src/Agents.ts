import { Data, Effect } from "effect"
import * as Codex from "./Codex.js"
import { BASE_MACHINE, MACHINE_RE, machineFor } from "./config.js"
import { Machines } from "./Machines.js"
import { VmStack, type StackStatus } from "./VmStack.js"

export class MachineNotFound extends Data.TaggedError("MachineNotFound")<{
  readonly machine: string
}> {}

export interface AgentInfo {
  readonly n: number
  readonly name: string
  readonly state: string
  readonly codex: boolean
  readonly working: boolean
  readonly stack: StackStatus
}

const NO_STACK: StackStatus = { pg: false, redis: false, hasura: false }

/** Agent lifecycle. State is always derived live from orbctl + docker + pty sessions. */
export class Agents extends Effect.Service<Agents>()("Agents", {
  dependencies: [Machines.Default, VmStack.Default],
  effect: Effect.gen(function* () {
    const machines = yield* Machines
    const stack = yield* VmStack

    const list: Effect.Effect<Array<AgentInfo>, never, never> = machines.list.pipe(
      Effect.flatMap((all) =>
        Effect.all(
          all.flatMap((m) => {
            const match = MACHINE_RE.exec(m.name)
            if (!match) return []
            const n = Number(match[1])
            const status = m.state === "running" ? stack.status(n) : Effect.succeed(NO_STACK)
            return status.pipe(
              Effect.map((stackStatus) => ({
                n,
                name: m.name,
                state: m.state,
                stack: stackStatus,
                ...Codex.sessionStatus(m.name),
              })),
            )
          }),
          { concurrency: 4 },
        ),
      ),
      Effect.map((agents) => agents.sort((a, b) => a.n - b.n)),
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

      /** Clone base -> next free number, start it, bring up VM-local compose deps. */
      create: Effect.gen(function* () {
        const agents = yield* list
        const used = new Set(agents.map((a) => a.n))
        let n = 1
        while (used.has(n)) n++
        const machine = machineFor(n)
        yield* machines.clone(BASE_MACHINE, machine)
        yield* machines.start(machine)
        yield* stack.up(n)
        return { n, name: machine }
      }),

      /** Start the whole agent: VM + VM-local compose deps. */
      start: (n: number) =>
        requireAgent(n).pipe(
          Effect.zipRight(machines.start(machineFor(n))),
          Effect.zipRight(stack.up(n)),
        ),

      /** Stop the whole agent: codex + VM. Containers/data live inside the VM. */
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

      /** Repair: rerun compose inside the VM. */
      stackUp: (n: number) => requireAgent(n).pipe(Effect.zipRight(stack.up(n))),

      doctor: (n: number) => requireAgent(n).pipe(Effect.zipRight(stack.doctor(n))),
    }
  }),
}) {}
