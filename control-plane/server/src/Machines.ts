import { Command, CommandExecutor } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Data, Effect, Schema, Stream } from "effect"
import { REPO_DIR } from "./config.js"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}> {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode}: ${this.stderr || this.stdout}`
  }
}

const MachineInfo = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
})
const MachineList = Schema.parseJson(Schema.Array(MachineInfo))
export type MachineInfo = typeof MachineInfo.Type

/** Typed wrapper over the host `orbctl` / `orb` CLIs. */
export class Machines extends Effect.Service<Machines>()("Machines", {
  dependencies: [NodeContext.layer],
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const run = (cmd: string, ...args: Array<string>) =>
      Effect.gen(function* () {
        const process = yield* executor.start(Command.make(cmd, ...args))
        const collect = (stream: typeof process.stdout) =>
          stream.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b))
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [process.exitCode, collect(process.stdout), collect(process.stderr)],
          { concurrency: 3 },
        )
        if (exitCode !== 0) {
          return yield* new CommandFailed({
            command: [cmd, ...args].join(" "),
            exitCode,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
          })
        }
        return stdout
      }).pipe(
        Effect.scoped,
        // PlatformError (spawn/stream failures) is a defect; CommandFailed is the domain error
        Effect.catchAll((e) => (e._tag === "CommandFailed" ? Effect.fail(e) : Effect.die(e))),
      )

    return {
      list: run("orbctl", "list", "-f", "json").pipe(
        Effect.flatMap(Schema.decode(MachineList)),
        Effect.orDie,
      ),
      clone: (from: string, to: string) => run("orbctl", "clone", from, to),
      start: (machine: string) => run("orbctl", "start", machine),
      stop: (machine: string) => run("orbctl", "stop", machine),
      delete: (machine: string) => run("orbctl", "delete", machine),
      /** Run a command inside the VM's repo checkout with asdf on PATH. */
      runInRepo: (machine: string, script: string) =>
        run("orb", "-m", machine, "bash", "-lc", `. ~/.asdf/asdf.sh && cd ${REPO_DIR} && ${script}`),
    }
  }),
}) {}
