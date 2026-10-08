/**
 * Pushes a UiIntent to the mock daemon (UiService.Emit), like a CLI verb would.
 *
 *   pnpm run mock:emit focus-terminal t-top
 *   pnpm run mock:emit focus-session s-3
 *   pnpm run mock:emit focus-repo repo-cf [worktreePath]
 *   pnpm run mock:emit palette [query]
 *   pnpm run mock:emit notify [info|warning|error] <title> [body]
 *
 * MOCK_URL (default http://127.0.0.1:7788) and MOCK_TOKEN (default dev-mock-token).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { UiIntent_Notify_Level, UiService, type UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";

type Intent = MessageInitShape<typeof UiIntentSchema>;

const usage = "usage: emit focus-terminal <id> | focus-session <id> | focus-repo <repoId> [path] | palette [query] | notify [info|warning|error] <title> [body]";

export function parseIntent(argv: readonly string[]): Intent | null {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "focus-terminal":
      return rest[0] ? { intent: { case: "focusTerminal", value: { terminalId: rest[0] } } } : null;
    case "focus-repo":
      return rest[0] ? { intent: { case: "focusRepo", value: { repoId: rest[0], worktreePath: rest[1] ?? "" } } } : null;
    case "palette":
      return { intent: { case: "openPalette", value: { query: rest.join(" ") } } };
    case "notify": {
      const levels: Record<string, UiIntent_Notify_Level> = { info: UiIntent_Notify_Level.INFO, warning: UiIntent_Notify_Level.WARNING, error: UiIntent_Notify_Level.ERROR };
      const first = rest[0] ?? "";
      const level = levels[first];
      const [title, body] = level ? rest.slice(1) : rest;
      return title ? { intent: { case: "notify", value: { level: level ?? UiIntent_Notify_Level.INFO, title, body: body ?? "" } } } : null;
    }
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.MOCK_URL ?? "http://127.0.0.1:7788";
  const [verb, id] = process.argv.slice(2);
  // focus-session goes through the mock's control endpoint, which checks the id.
  if (verb === "focus-session" && id) {
    const res = await fetch(`${baseUrl}/__mock/session/focus?id=${encodeURIComponent(id)}`, { method: "POST" });
    console.log(await res.text());
    return;
  }
  const intent = parseIntent(process.argv.slice(2));
  if (!intent) {
    console.error(usage);
    process.exit(2);
  }
  const token = process.env.MOCK_TOKEN ?? "dev-mock-token";
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    interceptors: [
      (next) => (req) => {
        req.header.set("Authorization", `Bearer ${token}`);
        return next(req);
      },
    ],
  });
  const res = await createClient(UiService, transport).emit({ intent });
  console.log(`delivered to ${String(res.delivered)} watcher(s)`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
