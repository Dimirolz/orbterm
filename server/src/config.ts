export const PORT = Number(process.env.PORT ?? 7070)
export const PREFIX = "shilo-agent-"
export const BASE_MACHINE = "shilo-agent-base"
export const REPO_DIR = process.env.REPO_DIR ?? "~/projects/shilo-ai-mono"
export const VSCODE_REMOTE_USER = process.env.VSCODE_REMOTE_USER ?? "dmitrijilin"
export const VSCODE_REPO_DIR = REPO_DIR.replace(/^~(?=\/)/, `/home/${VSCODE_REMOTE_USER}`)

export const machineFor = (n: number) => `${PREFIX}${n}`
export const MACHINE_RE = new RegExp(`^${PREFIX}(\\d+)(?:-[a-z0-9][a-z0-9-]*)?$`)

export const HASURA_SERVICES = (process.env.ORB_HASURA_SERVICES ?? "postgres graphql-engine")
  .split(/\s+/)
  .filter(Boolean)

export const BACKEND_DEP_SERVICES = (process.env.ORB_BACKEND_DEP_SERVICES ?? "redis-queue redis-cache temporal")
  .split(/\s+/)
  .filter(Boolean)
