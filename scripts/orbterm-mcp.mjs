#!/usr/bin/env node

const host = process.env.ORBTERM_HOST ?? "http://host.orb.internal:7070"
let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function reject(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

async function spawnSidequest(prompt) {
  const response = await fetch(`${host}/api/sidequests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`)
  return text
}

async function handle(message) {
  if (!("id" in message)) return

  if (message.method === "initialize") {
    return respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "orbterm", version: "0.0.0" },
    })
  }

  if (message.method === "tools/list") {
    return respond(message.id, {
      tools: [
        {
          name: "spawn_sidequest",
          description: "Create a new orbterm agent VM and send Codex an initial prompt.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Initial prompt to submit to the new Codex agent." },
            },
            required: ["prompt"],
            additionalProperties: false,
          },
        },
      ],
    })
  }

  if (message.method === "tools/call") {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name !== "spawn_sidequest") return reject(message.id, -32602, `unknown tool: ${name}`)
    if (typeof args.prompt !== "string" || !args.prompt.trim()) {
      return reject(message.id, -32602, "prompt must be a non-empty string")
    }
    try {
      const result = await spawnSidequest(args.prompt)
      return respond(message.id, { content: [{ type: "text", text: result }] })
    } catch (error) {
      return reject(message.id, -32000, error instanceof Error ? error.message : String(error))
    }
  }

  if (message.method === "ping") return respond(message.id, {})
  reject(message.id, -32601, `unknown method: ${message.method}`)
}

function readFrames() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString("utf8")
    const match = /^Content-Length: (\d+)$/im.exec(header)
    if (!match) throw new Error("missing Content-Length")
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) return
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8")
    buffer = buffer.subarray(bodyEnd)
    void handle(JSON.parse(body))
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  readFrames()
})
