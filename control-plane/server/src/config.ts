export const PORT = Number(process.env.PORT ?? 7070)
export const PREFIX = "shilo-agent-"
export const BASE_MACHINE = "shilo-agent-base"
export const REPO_DIR = process.env.REPO_DIR ?? "~/projects/shilo-ai-mono"

export const machineFor = (n: number) => `${PREFIX}${n}`
export const MACHINE_RE = new RegExp(`^${PREFIX}(\\d+)$`)
