import { Effect, Schema } from "effect"
import { REPO_DIR } from "./config.js"
import { Sh } from "./Sh.js"

const MachineInfo = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
})
const MachineList = Schema.parseJson(Schema.Array(MachineInfo))
export type MachineInfo = typeof MachineInfo.Type

/** Typed wrapper over the host `orbctl` / `orb` CLIs. */
export class Machines extends Effect.Service<Machines>()("Machines", {
  dependencies: [Sh.Default],
  effect: Effect.gen(function* () {
    const { run, runWithInput } = yield* Sh

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
      /** Write an image into the VM and publish it to the VM's headless X clipboard. */
      setClipboardImage: (machine: string, path: string, contentType: string, base64: string) =>
        runWithInput(
          base64,
          "orb",
          "-m",
          machine,
          "bash",
          "-lc",
          [
            "set -e",
            "command -v Xvfb >/dev/null",
            "command -v xclip >/dev/null",
            "export DISPLAY=:77",
            "pgrep -f 'Xvfb :77' >/dev/null || (Xvfb :77 -screen 0 1024x768x24 >/tmp/keenterm-xvfb.log 2>&1 &)",
            "sleep 0.2",
            "mkdir -p /tmp/keenterm-paste",
            `base64 -d > '${path}'`,
            "pkill -x xclip >/dev/null 2>&1 || true",
            `xclip -selection clipboard -t '${contentType}' -i '${path}' >/tmp/keenterm-xclip.log 2>&1 &`,
          ].join(" && "),
        ),
    }
  }),
}) {}
