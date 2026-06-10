import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  Socket,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Runtime } from "effect"
import { createServer } from "node:http"
import { Agents } from "./Agents.js"
import * as Codex from "./Codex.js"
import { MACHINE_RE, PORT } from "./config.js"

// ---- helpers ------------------------------------------------------------------

const agentNumber = HttpRouter.params.pipe(
  Effect.map((params) => Number(params.n)),
)

const errorResponses = {
  CommandFailed: (e: { message: string }) =>
    HttpServerResponse.json({ error: e.message }, { status: 500 }).pipe(Effect.orDie),
  MachineNotFound: (e: { machine: string }) =>
    HttpServerResponse.json({ error: `${e.machine} does not exist` }, { status: 404 }).pipe(Effect.orDie),
  ParseError: () =>
    HttpServerResponse.json({ error: "bad orbctl output" }, { status: 500 }).pipe(Effect.orDie),
} as const

const ok = <A>(body: A) => HttpServerResponse.json(body).pipe(Effect.orDie)

// ---- routes -------------------------------------------------------------------

const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/api/agents",
    Effect.gen(function* () {
      const agents = yield* Agents
      return yield* ok(yield* agents.list)
    }),
  ),
  HttpRouter.post(
    "/api/agents",
    Effect.gen(function* () {
      const agents = yield* Agents
      return yield* ok(yield* agents.create)
    }),
  ),
  HttpRouter.del(
    "/api/agents/:n",
    Effect.gen(function* () {
      const agents = yield* Agents
      yield* agents.remove(yield* agentNumber)
      return yield* ok({ ok: true })
    }),
  ),
  HttpRouter.post(
    "/api/agents/:n/start",
    Effect.gen(function* () {
      const agents = yield* Agents
      yield* agents.start(yield* agentNumber)
      return yield* ok({ ok: true })
    }),
  ),
  HttpRouter.post(
    "/api/agents/:n/stop",
    Effect.gen(function* () {
      const agents = yield* Agents
      yield* agents.stop(yield* agentNumber)
      return yield* ok({ ok: true })
    }),
  ),
  HttpRouter.post(
    "/api/agents/:n/codex/stop",
    Effect.gen(function* () {
      const agents = yield* Agents
      yield* agents.stopCodex(yield* agentNumber)
      return yield* ok({ ok: true })
    }),
  ),
  HttpRouter.post(
    "/api/agents/:n/doctor",
    Effect.gen(function* () {
      const agents = yield* Agents
      return yield* ok({ output: yield* agents.doctor(yield* agentNumber) })
    }),
  ),
  // Interactive Codex terminal: websocket upgrade, raw stdio passthrough.
  HttpRouter.get(
    "/term",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const machine = new URL(request.url, "http://localhost").searchParams.get("machine") ?? ""
      if (!MACHINE_RE.test(machine)) {
        return yield* HttpServerResponse.json({ error: "invalid machine" }, { status: 400 }).pipe(Effect.orDie)
      }

      const socket = yield* request.upgrade
      const write = yield* socket.writer
      const runFork = Runtime.runFork(yield* Effect.runtime())
      const client: Codex.TermClient = {
        send: (data) => void runFork(write(data)),
        close: () => void runFork(write(new Socket.CloseEvent())),
      }
      const handle = Codex.attach(machine, client)

      // blocks until the websocket closes
      yield* socket
        .runRaw((data) => {
          if (typeof data === "string") handle.onMessage(data)
        })
        .pipe(
          Effect.ensuring(Effect.sync(handle.detach)),
          Effect.catchAll(() => Effect.void), // client gone is not an error
        )
      return HttpServerResponse.empty()
    }),
  ),
  HttpRouter.catchTags(errorResponses),
)

// ---- server ---------------------------------------------------------------------

const Main = HttpServer.serve(router, HttpMiddleware.logger).pipe(
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
  Layer.provide(Agents.Default),
)

NodeRuntime.runMain(Layer.launch(Main))
