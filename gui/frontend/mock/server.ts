/**
 * Mock code-foundry daemon for frontend development and e2e tests.
 *
 *   pnpm run mock            # http://127.0.0.1:7788, token "dev-mock-token"
 *   MOCK_PORT=7799 MOCK_TOKEN=secret pnpm run mock
 *
 * Serves Health, Terminal, Repo, Session, Command, Ui and Event over Connect (HTTP/1.1,
 * like the real daemon's loopback listener for browsers), with bearer auth and
 * permissive CORS. Non-RPC control endpoints for tests live under /__mock/:
 *
 *   GET  /__mock/invocations | writes | resizes | sessions | streams
 *   POST /__mock/reset
 *   POST /__mock/session/attention?id=s-1
 *   POST /__mock/session/status?id=s-1&status=busy|idle|attention
 *   POST /__mock/session/disconnect?id=s-1&reason=crashed&code=139
 *   POST /__mock/session/focus?id=s-3     (FocusSession intent)
 *   POST /__mock/sessions-service?enabled=false   (simulate a daemon without SessionService)
 *   POST /__mock/gitops?fail=git.push&delay=800   (next git.push fails; ops take 800ms)
 *   GET  /__mock/gitops
 *   GET  /__mock/settings                          ({ raw, values } of the settings "file")
 *   POST /__mock/settings/external?appearance.font_size=18   (a hand edit; "" deletes a key)
 *   POST /__mock/settings/external?loadError=…               (the file stops parsing)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Code, ConnectError, cors as connectCors, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { CommandService, ConfirmationRequiredSchema } from "../src/gen/codefoundry/v1/command_pb";
import { SettingsService, SettingsValidationErrorsSchema } from "../src/gen/codefoundry/v1/settings_pb";
import { EventService, EventSource } from "../src/gen/codefoundry/v1/events_pb";
import { HealthService } from "../src/gen/codefoundry/v1/health_pb";
import { RepoService } from "../src/gen/codefoundry/v1/repo_pb";
import { SessionService, SessionState, SessionStatus } from "../src/gen/codefoundry/v1/session_pb";
import { TerminalService, TerminalState, type AttachEventSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { UiService } from "../src/gen/codefoundry/v1/ui_pb";
import { groups as settingsGroups, SettingsValidation } from "./settings";
import { CommandError, ConfirmNeeded, World, type EventInit } from "./world";

type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;

const port = Number(process.env.MOCK_PORT ?? 7788);
const token = process.env.MOCK_TOKEN ?? "dev-mock-token";
const world = new World();
/** False simulates a pre-Phase-2a daemon (see POST /__mock/sessions-service). */
let sessionsEnabled = true;

function rpcError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  if (err instanceof ConfirmNeeded) {
    return new ConnectError(err.message, Code.FailedPrecondition, undefined, [
      { desc: ConfirmationRequiredSchema, value: { command: err.command, title: err.title, message: err.message } },
    ]);
  }
  if (err instanceof SettingsValidation) {
    return new ConnectError(err.message, Code.InvalidArgument, undefined, [{ desc: SettingsValidationErrorsSchema, value: { errors: err.issues } }]);
  }
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

async function* attach(id: string, signal: AbortSignal): AsyncGenerator<AttachEventInit> {
  const t = guard(() => world.term(id));
  if (t.state !== TerminalState.RUNNING) {
    yield world.snapshot(t);
    yield { event: { case: "exited", value: { exitCode: t.exitCode } } };
    return;
  }
  // Subscribe before taking the snapshot so no output falls between them.
  const live = t.attach.subscribe(signal);
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
    attach: (req, ctx) => tracked("TerminalService/Attach", attach(req.id, ctx.signal)),
    write: (req) => guard(() => (world.write(req.id, req.data), {})),
    resize: (req) => guard(() => (world.resize(req.id, req.cols, req.rows), {})),
    kill: (req) => guard(() => (world.kill(req.id), {})),
    remove: (req) => guard(() => (world.remove(req.id), {})),
    watch: (_req, ctx) => tracked("TerminalService/Watch", world.termEvents.subscribe(ctx.signal)),
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
    watch: (_req, ctx) => tracked("RepoService/Watch", world.repoEvents.subscribe(ctx.signal)),
  });

  router.service(CommandService, {
    list: (req) => ({ commands: world.listCommands(req.context, req.includeUnavailable) }),
    // Git operations resolve when the fake op finishes (mock/gitops.ts), like the daemon.
    invoke: async (req) => {
      try {
        const out = await world.invoke(req.name, req.context, req.args, req.confirmed);
        return typeof out === "string" ? { message: out, resultJson: "" } : out;
      } catch (err) {
        throw rpcError(err);
      }
    },
  });

  router.service(SettingsService, {
    getSchema: () => ({ groups: settingsGroups, fields: world.settings.fields() }),
    get: () => ({ settings: world.settings.snapshot() }),
    update: (req) => {
      try {
        return { settings: world.settings.update(req.values) };
      } catch (err) {
        if (err instanceof SettingsValidation) throw rpcError(err);
        throw new ConnectError((err as Error).message, Code.FailedPrecondition);
      }
    },
    watch: async function* (_req, ctx) {
      yield { event: { case: "snapshot" as const, value: world.settings.snapshot() } };
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.SETTINGS && event.event?.case === "settings") yield event.event.value;
      }
    },
  });

  router.service(UiService, {
    watchIntents: (_req, ctx) => tracked("UiService/WatchIntents", world.intents.subscribe(ctx.signal)),
    emit: (req) => ({ delivered: req.intent ? world.emit(req.intent) : 0 }),
  });

  router.service(SessionService, {
    list: () => ({ sessions: [...world.sessions.values()].map((s) => world.sessionMsg(s)) }),
    get: (req) => guard(() => ({ session: world.sessionMsg(world.session(req.id)) })),
    create: () => {
      throw new ConnectError("use the session.new command in the mock", Code.Unimplemented);
    },
    fork: () => {
      throw new ConnectError("fork is not mocked", Code.Unimplemented);
    },
    rename: () => {
      throw new ConnectError("use the session.rename command in the mock", Code.Unimplemented);
    },
    close: () => {
      throw new ConnectError("use the session.close command in the mock", Code.Unimplemented);
    },
    reconnect: () => {
      throw new ConnectError("use the session.reconnect command in the mock", Code.Unimplemented);
    },
    remove: () => {
      throw new ConnectError("use the session.remove command in the mock", Code.Unimplemented);
    },
    watch: (_req, ctx) => tracked("SessionService/Watch", world.sessionEvents.subscribe(ctx.signal, [world.sessionSnapshot()])),
  });

  router.service(EventService, {
    // Snapshots first in the order events.proto promises (repo, terminal, session, gh,
    // gitops, settings), then everything published, filtered by `sources`.
    watch: (req, ctx) => {
      const want = new Set(
        req.sources.length > 0
          ? req.sources
          : [EventSource.REPO, EventSource.TERMINAL, EventSource.SESSION, EventSource.GH, EventSource.GITOPS, EventSource.SETTINGS, EventSource.UI],
      );
      if (!sessionsEnabled) want.delete(EventSource.SESSION);
      const initial: { source: EventSource; event: EventInit }[] = [
        { source: EventSource.REPO, event: { event: { case: "repo", value: { event: { case: "snapshot", value: { repos: [...world.repos.values()].map((r) => world.repoMsg(r)) } } } } } },
        ...[...world.terms.values()].map((t) => ({ source: EventSource.TERMINAL, event: { event: { case: "terminal" as const, value: { event: { case: "updated" as const, value: world.terminalMsg(t) } } } } })),
        { source: EventSource.SESSION, event: { event: { case: "session", value: world.sessionSnapshot() } } },
        { source: EventSource.GITOPS, event: { event: { case: "gitops", value: world.gitops.snapshot() } } },
        { source: EventSource.SETTINGS, event: { event: { case: "settings", value: { event: { case: "snapshot", value: world.settings.snapshot() } } } } },
      ];
      const ui = want.has(EventSource.UI);
      return tracked("EventService/Watch", filterEvents(world.events.subscribe(ctx.signal, initial), want), () => {
        if (ui) world.uiEventWatchers++;
        return () => {
          if (ui) world.uiEventWatchers--;
        };
      });
    },
  });
}

async function* filterEvents(src: AsyncGenerator<{ source: EventSource; event: EventInit }>, want: Set<EventSource>): AsyncGenerator<EventInit> {
  for await (const { source, event } of src) if (want.has(source)) yield event;
}

/** Long-lived streams currently open, by RPC, for GET /__mock/streams (connection budget tests). */
const openStreams = new Map<string, number>();

function bump(name: string, by: number): void {
  const n = (openStreams.get(name) ?? 0) + by;
  if (n > 0) openStreams.set(name, n);
  else openStreams.delete(name);
}

async function* tracked<T>(name: string, src: AsyncIterable<T>, onOpen?: () => () => void): AsyncGenerator<T> {
  bump(name, 1);
  const onClose = onOpen?.();
  try {
    yield* src;
  } finally {
    onClose?.();
    bump(name, -1);
  }
}

const rpc = connectNodeAdapter({ routes });

const allowHeaders = [...connectCors.allowedHeaders, "Authorization"].join(", ");
const exposeHeaders = connectCors.exposedHeaders.join(", ");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, null, 2));
}

/** JSON-safe session summary (proto timestamps carry bigints). */
function sessionSummary(id: string): Record<string, unknown> {
  const s = world.session(id);
  return { id: s.id, name: s.name, state: SessionState[s.state], status: SessionStatus[s.status], terminalId: s.terminalId };
}

const statusNames: Record<string, SessionStatus> = { busy: SessionStatus.BUSY, idle: SessionStatus.IDLE, attention: SessionStatus.NEEDS_ATTENTION };

/** Session controls: POST /__mock/session/{attention|status|disconnect|focus}?id=…[&status=…][&reason=…&code=…] */
function sessionControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const id = q.get("id") ?? "";
  try {
    switch (action) {
      case "attention":
        world.setSessionStatus(id, SessionStatus.NEEDS_ATTENTION);
        break;
      case "status": {
        const status = statusNames[q.get("status") ?? ""];
        if (status === undefined) throw new CommandError("invalid", "status must be busy, idle or attention");
        world.setSessionStatus(id, status);
        break;
      }
      case "disconnect":
        world.disconnectSession(id, q.get("reason") ?? "crashed", Number(q.get("code") ?? 1));
        break;
      case "focus":
        json(res, 200, { delivered: world.focusSession(id) });
        return;
      default:
        json(res, 404, { error: "unknown session action" });
        return;
    }
    json(res, 200, sessionSummary(id));
  } catch (err) {
    json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function control(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): void {
  const session = /^\/__mock\/session\/([a-z]+)$/.exec(path);
  if (req.method === "POST" && session?.[1]) {
    sessionControl(res, session[1], q);
    return;
  }
  switch (`${req.method ?? ""} ${path}`) {
    case "POST /__mock/sessions-service":
      // enabled=false simulates a daemon without Phase 2a: SessionService 404s and the
      // events stream carries no session source. Reset turns it back on.
      sessionsEnabled = q.get("enabled") !== "false";
      json(res, 200, { enabled: sessionsEnabled });
      break;
    case "POST /__mock/gitops":
      // fail=git.push makes that command's next op fail; delay=ms sets how long ops run.
      for (const name of q.getAll("fail")) world.gitops.failNext.add(name);
      if (q.has("delay")) world.gitops.delayMs = Number(q.get("delay"));
      json(res, 200, { fail: [...world.gitops.failNext], delayMs: world.gitops.delayMs });
      break;
    case "GET /__mock/gitops":
      json(res, 200, world.gitops.summaries());
      break;
    case "GET /__mock/streams":
      json(res, 200, Object.fromEntries(openStreams));
      break;
    case "GET /__mock/sessions":
      json(res, 200, [...world.sessions.keys()].map(sessionSummary));
      break;
    case "GET /__mock/invocations":
      json(res, 200, world.invocations);
      break;
    case "GET /__mock/settings":
      json(res, 200, { raw: world.settings.raw, values: world.settings.values(), loadError: world.settings.loadError });
      break;
    case "POST /__mock/settings/external": {
      const values = Object.fromEntries([...q.entries()].filter(([k]) => k !== "loadError"));
      world.settings.external(values, q.get("loadError"));
      json(res, 200, { raw: world.settings.raw });
      break;
    }
    case "GET /__mock/writes":
      json(res, 200, world.writes);
      break;
    case "GET /__mock/resizes":
      json(res, 200, world.resizes);
      break;
    case "POST /__mock/reset":
      sessionsEnabled = true;
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
  const url = new URL(req.url ?? "/", "http://mock");
  if (url.pathname.startsWith("/__mock/")) {
    control(req, res, url.pathname, url.searchParams);
    return;
  }
  if (!sessionsEnabled && url.pathname.startsWith("/codefoundry.v1.SessionService/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 page not found\n");
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
