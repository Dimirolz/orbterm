import { Command, CommandExecutor } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Data, Effect, Stream } from "effect"

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

/** Run host commands, capturing stdout. CommandFailed on nonzero exit. */
export class Sh extends Effect.Service<Sh>()("Sh", {
  dependencies: [NodeContext.layer],
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const runCommand = (label: string, command: Command.Command) =>
      Effect.gen(function* () {
        const process = yield* executor.start(command)
        const collect = (stream: typeof process.stdout) =>
          stream.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b))
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [process.exitCode, collect(process.stdout), collect(process.stderr)],
          { concurrency: 3 },
        )
        if (exitCode !== 0) {
          return yield* new CommandFailed({
            command: label,
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

    const run = (cmd: string, ...args: Array<string>) =>
      runCommand([cmd, ...args].join(" "), Command.make(cmd, ...args))

    /** Like `run`, but feeds `input` to the command's stdin (UTF-8). */
    const runWithInput = (input: string, cmd: string, ...args: Array<string>) =>
      runCommand([cmd, ...args].join(" "), Command.make(cmd, ...args).pipe(Command.feed(input)))

    return { run, runWithInput }
  }),
}) {}
