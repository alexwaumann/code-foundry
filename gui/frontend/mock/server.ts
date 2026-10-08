/**
 * Mock code-foundry daemon for frontend development and e2e tests.
 *
 *   pnpm run mock            # http://127.0.0.1:7788, token "dev-mock-token"
 *   MOCK_PORT=7799 MOCK_TOKEN=secret pnpm run mock
 *
 * Serves Health, Terminal, Repo, Command and Ui over Connect (HTTP/1.1, like the real
 * daemon's loopback listener for browsers), with bearer auth and permissive CORS.
 * Non-RPC control endpoints for tests live under /__mock/.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Code, ConnectError, cors as connectCors, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { CommandService } from "../src/gen/codefoundry/v1/command_pb";
import { HealthService } from "../src/gen/codefoundry/v1/health_pb";
import { RepoService } from "../src/gen/codefoundry/v1/repo_pb";
import { TerminalService, TerminalState } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiService } from "../src/gen/codefoundry/v1/ui_pb";
import { CommandError, World } from "./world";

const port = Number(process.env.MOCK_PORT ?? 7788);
const token = process.env.MOCK_TOKEN ?? "dev-mock-token";
const world = new World();

function rpcError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  if (err instanceof CommandError) {
    const code = { unavailable: Code.FailedPrecondition, invalid: Code.InvalidArgument, notfound: Code.NotFound }[err.kind];
    return new ConnectError(err.message, code);
  }
  return ConnectError.from(err);
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw rpcError(err);
  }
}

function routes(router: ConnectRouter): void {
  router.service(HealthService, {
    ping: () => ({ pid: process.pid, version: "mock", uptime: durationFromMs(Date.now() - world.startedAt) }),
    version: () => ({ version: "mock", commit: "", goVersion: "" }),
  });

  router.service(TerminalService, {
    list: () => ({ terminals: [...world.terms.values()].map((t) => world.terminalMsg(t)) }),
    get: (req) => guard(() => ({ terminal: world.terminalMsg(world.term(req.id)) })),
    create: (req) =>
      guard(() => {
        const t = world.create(req.argv.length ? req.argv : ["/bin/zsh"], req.cwd || "/tmp", req.labels, "shell");
        return { terminal: world.terminalMsg(t) };
      }),
    async *attach(req, ctx) {
      const t = guard(() => world.term(req.id));
      if (t.state !== TerminalState.RUNNING) {
        yield world.snapshot(t);
        yield { event: { case: "exited", value: { exitCode: t.exitCode } } };
        return;
      }
      // Subscribe before taking the snapshot so no output falls between them.
      const live = t.attach.subscribe(ctx.signal);
      const first = live.next();
      try {
        yield world.snapshot(t);
        for (let r = await first; !r.done; r = await live.next()) {
          if (r.value === "end") return;
          yield r.value;
        }
      } finally {
        void live.return(undefined);
      }
    },
    write: (req) => guard(() => (world.write(req.id, req.data), {})),
    resize: (req) => guard(() => (world.resize(req.id, req.cols, req.rows), {})),
    kill: (req) => guard(() => (world.kill(req.id), {})),
    remove: (req) => guard(() => (world.remove(req.id), {})),
    watch: (_req, ctx) => world.termEvents.subscribe(ctx.signal),
  });

  router.service(RepoService, {
    list: () => ({ repos: [...world.repos.values()].map((r) => world.repoMsg(r)) }),
    get: (req) => {
      const r = world.repos.get(req.id);
      if (!r) throw new ConnectError(`repo ${req.id} not found`, Code.NotFound);
      return { repo: world.repoMsg(r) };
    },
    register: () => {
      throw new ConnectError("use the repo.register command in the mock", Code.Unimplemented);
    },
    unregister: () => {
      throw new ConnectError("use the repo.unregister command in the mock", Code.Unimplemented);
    },
    createWorktree: () => {
      throw new ConnectError("use the worktree.create command in the mock", Code.Unimplemented);
    },
    removeWorktree: () => {
      throw new ConnectError("use the worktree.remove command in the mock", Code.Unimplemented);
    },
    refresh: () => ({}),
    watch: (_req, ctx) => world.repoEvents.subscribe(ctx.signal),
  });

  router.service(CommandService, {
    list: (req) => ({ commands: world.listCommands(req.context, req.includeUnavailable) }),
    invoke: (req) => guard(() => ({ message: world.invoke(req.name, req.context, req.args), resultJson: "" })),
  });

  router.service(UiService, {
    watchIntents: (_req, ctx) => world.intents.subscribe(ctx.signal),
    emit: (req) => ({ delivered: req.intent ? world.intents.publish(req.intent) : 0 }),
  });
}

const rpc = connectNodeAdapter({ routes });

const allowHeaders = [...connectCors.allowedHeaders, "Authorization"].join(", ");
const exposeHeaders = connectCors.exposedHeaders.join(", ");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, null, 2));
}

function control(req: IncomingMessage, res: ServerResponse, path: string): void {
  switch (`${req.method ?? ""} ${path}`) {
    case "GET /__mock/invocations":
      json(res, 200, world.invocations);
      break;
    case "GET /__mock/writes":
      json(res, 200, world.writes);
      break;
    case "GET /__mock/resizes":
      json(res, 200, world.resizes);
      break;
    case "POST /__mock/reset":
      world.reset();
      json(res, 200, { ok: true });
      break;
    default:
      json(res, 404, { error: "unknown control endpoint" });
  }
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", exposeHeaders);
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": connectCors.allowedMethods.join(", "),
      "Access-Control-Allow-Headers": allowHeaders,
      "Access-Control-Max-Age": "7200",
    });
    res.end();
    return;
  }
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path.startsWith("/__mock/")) {
    control(req, res, path);
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "unauthenticated", message: "missing or bad bearer token" }));
    return;
  }
  rpc(req, res);
});

// Streams are long-lived: no request timeout (Node's default would cut them at 5 min).
server.requestTimeout = 0;
server.keepAliveTimeout = 60_000;

server.listen(port, "127.0.0.1", () => {
  world.start();
  const url = `http://127.0.0.1:${String(port)}`;
  console.log(`mock daemon listening on ${url}`);
  console.log(`token: ${token}`);
  console.log(`browser: http://127.0.0.1:9245/?daemon=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`);
});

function shutdown(): void {
  world.stop();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
