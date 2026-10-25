import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import SOURCES_MD from "../../../../internal/skills/files/code-foundry-pages/reference/sources.md?raw";
import { BRIDGE_SOURCES } from "@/lib/bridge";
import { ActionRunSchema, ActionSchema } from "@/gen/codefoundry/v1/action_pb";
import { EmberBoardSchema } from "@/gen/codefoundry/v1/ember_pb";
import { CheckRollupSchema, GetDashboardResponseSchema, PullRequestSchema } from "@/gen/codefoundry/v1/gh_pb";
import { PluginSchema } from "@/gen/codefoundry/v1/plugin_pb";
import { GitStatusSchema, ProjectSchema, WorktreeSchema } from "@/gen/codefoundry/v1/project_pb";
import { SettingIssueSchema, SettingsSnapshotSchema } from "@/gen/codefoundry/v1/settings_pb";
import { TerminalSchema } from "@/gen/codefoundry/v1/terminal_pb";
import { LinkedPullRequestSchema, ThreadReportStatus, ThreadSchema, UsageBucketSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { ThreadEventSchema } from "@/gen/codefoundry/v1/thread_pb";
import { UiIntentSchema, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";
import { UpdateStatusSchema } from "@/gen/codefoundry/v1/update_pb";
import { WorkspaceSchema } from "@/gen/codefoundry/v1/workspace_pb";
import { toActionRunView, toActionView } from "./actions";
import { toEmberBoardView } from "./ember";
import type { DaemonConnection } from "./endpoint";
import { getDashboard } from "./gh";
import { toPluginView } from "./plugin";
import { toProjectView } from "./project";
import { toSettingsSnapshotView } from "./settings";
import { toTerminalView } from "./terminal";
import { toThreadEventView } from "./thread";
import { toThreadView } from "./threads";
import { toUiIntentView } from "./ui";
import { toUpdateStatusView } from "./update";
import { toWorkspaceView } from "./workspace";

/*
 * The pages skill's reference/sources.md (internal/skills/files/code-foundry-pages) tells
 * the model the fields `cf.on(source, fn)` sends. It must match what the bridge host
 * forwards (stores/bridgeSources.ts): these view models, passed through JSON. One sample
 * per source, built by the view models' own mappers from fully nested messages; every
 * backticked name in the source's section must be a key somewhere in its sample
 * (docs/notes/bridge-fix-c-daemon.md).
 */

/** What the host posts: the view model through JSON (undefined keys go, dates become strings). */
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const thread = () =>
  toThreadView(
    create(ThreadSchema, {
      usage: [create(UsageBucketSchema)],
      linkedPullRequests: [create(LinkedPullRequestSchema)],
      reportStatus: ThreadReportStatus.DONE,
    }),
  );

const pr = create(PullRequestSchema, { checks: create(CheckRollupSchema) });

const intents: UiIntent["intent"][] = [
  { case: "notify", value: { title: "t" } as never },
  { case: "focusThread", value: { threadId: "s" } as never },
  { case: "showView", value: { name: "panel.file", threadId: "s", params: { path: "a" } } as never },
  { case: "focusTerminal", value: {} as never },
  { case: "focusProject", value: {} as never },
  { case: "openPalette", value: {} as never },
  { case: "playAlertSound", value: {} as never },
  { case: "showAgentRun", value: {} as never },
];

async function samples(): Promise<Record<string, unknown>> {
  const conn = {
    client: () =>
      Promise.resolve({
        getDashboard: () =>
          Promise.resolve(
            create(GetDashboardResponseSchema, {
              viewer: {},
              authored: [pr],
              reviewRequested: [pr],
              reviewed: [pr],
              recentlyMerged: [pr],
            }),
          ),
      }),
  } as unknown as DaemonConnection;
  const snapshot = toThreadEventView(
    create(ThreadEventSchema, { event: { case: "snapshot", value: { pending: [{ requestId: "r" }] } as never } }),
  );
  return {
    "thread-list": [thread()],
    thread: { thread: thread(), pending: snapshot?.kind === "snapshot" ? snapshot.pending : [] },
    gh: await getDashboard(false, conn),
    action: { actions: [toActionView(create(ActionSchema))], runs: [toActionRunView(create(ActionRunSchema))] },
    plugin: [toPluginView(create(PluginSchema, { commands: [{}], surfaces: [{}] }))],
    terminal: [toTerminalView(create(TerminalSchema))],
    project: [toProjectView(create(ProjectSchema, { worktrees: [create(WorktreeSchema, { status: create(GitStatusSchema) })] }))],
    workspace: [toWorkspaceView(create(WorkspaceSchema, { members: [{}] }))],
    settings: toSettingsSnapshotView(create(SettingsSnapshotSchema, { issues: [create(SettingIssueSchema)] })),
    update: toUpdateStatusView(create(UpdateStatusSchema)),
    ember: toEmberBoardView(create(EmberBoardSchema, { status: { counts: {} }, tasks: [{ thread: {} }], timers: [{}] })),
    ui: intents.map((intent) => toUiIntentView(create(UiIntentSchema, { intent }))),
  };
}

/** Every key at any depth of v (through arrays). */
function keys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keys(x, out);
    }
  }
  return out;
}

/** The file's "## <source>" sections. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.split(/^## (\S+)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i] ?? "", parts[i + 1] ?? "");
  return out;
}

/** The backticked names in a section: `id`, `checks.state`. Code (`cf.on(…)`) is not a name. */
function names(section: string): string[] {
  return [...section.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)`/g)].map((m) => m[1] ?? "");
}

describe("the pages skill's reference/sources.md", () => {
  it("has a section for every bridge source and no other", () => {
    expect([...sections(SOURCES_MD).keys()].sort()).toEqual([...BRIDGE_SOURCES].sort());
  });

  it("names only fields the source's view model has", async () => {
    const all = await samples();
    expect(Object.keys(all).sort()).toEqual([...BRIDGE_SOURCES].sort());
    for (const [source, body] of sections(SOURCES_MD)) {
      const have = keys(json(all[source]));
      const listed = names(body);
      expect(listed.length, `${source}: no fields listed`).toBeGreaterThan(0);
      const missing = listed.filter((n) => n.split(".").some((seg) => !have.has(seg)));
      expect(missing, `${source}: names its view model lacks`).toEqual([]);
    }
  });

  it("says which times are not milliseconds", () => {
    // A field ending in "At" is no epoch ms: the doc must call each one out by name.
    for (const [source, body] of sections(SOURCES_MD)) {
      for (const n of names(body)) {
        if (/At$/.test(n)) expect(body, `${source}: ${n}`).toMatch(new RegExp("`" + n + "`[^.]*ISO string"));
      }
    }
  });
});
