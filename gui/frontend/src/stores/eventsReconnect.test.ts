import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventSchema, type Event, type WatchEventsRequest } from "@/gen/codefoundry/v1/events_pb";
import { GhEvent_DashboardUpdatedSchema, GhEvent_PolledSchema, GhEventSchema } from "@/gen/codefoundry/v1/gh_pb";
import { ProjectEventSchema, ProjectSchema, ProjectSnapshotSchema } from "@/gen/codefoundry/v1/project_pb";
import { TerminalEventSchema, TerminalSchema } from "@/gen/codefoundry/v1/terminal_pb";
import { ThreadListEventSchema, ThreadListSnapshotSchema, ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { WorkspaceEventSchema, WorkspaceSnapshotSchema } from "@/gen/codefoundry/v1/workspace_pb";
import type { PullRequestDetailView } from "@/api/gh";

type StreamFn = (req: Partial<WatchEventsRequest>, signal: AbortSignal) => AsyncIterable<Event>;

const env = vi.hoisted(() => ({
  requests: [] as Partial<WatchEventsRequest>[],
  stream: null as unknown as StreamFn,
  listProjects: 0,
  listTerminals: 0,
  listThreads: 0,
  loadSchema: 0,
  getBranchPrs: 0,
  getPrDetail: 0,
}));

const fakeClient = vi.hoisted(() => ({
  watch: (req: Partial<WatchEventsRequest>, opts: { signal: AbortSignal }) => {
    env.requests.push({ ...req });
    return env.stream(req, opts.signal);
  },
  setClientState: () => Promise.resolve({}),
}));

vi.mock("@/api/endpoint", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoint")>()),
  daemon: { client: () => Promise.resolve(fakeClient) },
}));
vi.mock("@/api/project", async (orig) => ({
  ...(await orig<typeof import("@/api/project")>()),
  listProjects: () => {
    env.listProjects++;
    return Promise.resolve([]);
  },
}));
vi.mock("@/api/terminal", async (orig) => ({
  ...(await orig<typeof import("@/api/terminal")>()),
  listTerminals: () => {
    env.listTerminals++;
    return Promise.resolve([]);
  },
}));
vi.mock("@/api/threads", async (orig) => ({
  ...(await orig<typeof import("@/api/threads")>()),
  listThreads: () => {
    env.listThreads++;
    return Promise.resolve([]);
  },
}));
vi.mock("./settings", async (orig) => ({
  ...(await orig<typeof import("./settings")>()),
  loadSettingsSchema: () => {
    env.loadSchema++;
    return Promise.resolve();
  },
}));
vi.mock("@/api/gh", async (orig) => ({
  ...(await orig<typeof import("@/api/gh")>()),
  getBranchPullRequests: () => {
    env.getBranchPrs++;
    return Promise.resolve({ pullRequests: [], fetchedAtMs: Date.now(), lastError: "" });
  },
  getPullRequestDetail: () => {
    env.getPrDetail++;
    return Promise.resolve({ pullRequest: { repoSlug: "acme/app", number: 7 } } as PullRequestDetailView);
  },
}));

const { startEventSync } = await import("./events");
const { branchKey, branchPullRequestsResource, pullRequestDetailResource, pullRequestKey } = await import("./gh");
const { emptyProjects, useProjectsStore } = await import("./projects");
const { emptyTerminals, useTerminalsStore } = await import("./terminals");
const { emptyThreads, useThreadsStore } = await import("./threads");

const park = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });

const projectSnap = (epoch: string, names: string[], seq = 0n) =>
  create(EventSchema, {
    epoch,
    seq,
    event: {
      case: "project",
      value: create(ProjectEventSchema, {
        event: {
          case: "snapshot",
          value: create(ProjectSnapshotSchema, { projects: names.map((n) => create(ProjectSchema, { id: n, name: n, path: `/src/${n}` })) }),
        },
      }),
    },
  });

const workspaceSnap = (epoch: string) =>
  create(EventSchema, {
    epoch,
    seq: 0n,
    event: { case: "workspace", value: create(WorkspaceEventSchema, { event: { case: "snapshot", value: create(WorkspaceSnapshotSchema, { workspaces: [] }) } }) },
  });

const terminalUpdated = (epoch: string, id: string, seq = 0n) =>
  create(EventSchema, {
    epoch,
    seq,
    event: { case: "terminal", value: create(TerminalEventSchema, { event: { case: "updated", value: create(TerminalSchema, { id, cwd: "/src/a" }) } }) },
  });

const threadSnap = (epoch: string, ids: string[]) =>
  create(EventSchema, {
    epoch,
    seq: 0n,
    event: {
      case: "threadList",
      value: create(ThreadListEventSchema, {
        event: { case: "snapshot", value: create(ThreadListSnapshotSchema, { threads: ids.map((id) => create(ThreadSchema, { id })) }) },
      }),
    },
  });

const ghSnap = (epoch: string): Event[] => [
  create(EventSchema, { epoch, seq: 0n, event: { case: "gh", value: create(GhEventSchema, { event: { case: "polled", value: create(GhEvent_PolledSchema, {}) } }) } }),
  create(EventSchema, { epoch, seq: 0n, event: { case: "gh", value: create(GhEventSchema, { event: { case: "dashboardUpdated", value: create(GhEvent_DashboardUpdatedSchema, {}) } }) } }),
];

let stop: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  env.requests.length = 0;
  env.listProjects = 0;
  env.listTerminals = 0;
  env.listThreads = 0;
  env.loadSchema = 0;
  env.getBranchPrs = 0;
  env.getPrDetail = 0;
  useProjectsStore.setState({ ...emptyProjects, loaded: false });
  useTerminalsStore.setState({ ...emptyTerminals, loaded: false });
  useThreadsStore.setState({ ...emptyThreads, loaded: false, error: null, epoch: 0 });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("EventService.Watch connect and reconnect", () => {
  it("populates stores from connect snapshots with zero redundant List RPCs (including zero terminals)", async () => {
    env.stream = (_req, signal) =>
      (async function* () {
        yield projectSnap("ep-1", ["app"]);
        yield workspaceSnap("ep-1");
        yield threadSnap("ep-1", ["th-1"]);
        await park(signal);
      })();

    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.listProjects).toBe(0);
    expect(env.listTerminals).toBe(0);
    expect(env.listThreads).toBe(0);
    expect(env.loadSchema).toBe(1);
    expect(useProjectsStore.getState().loaded).toBe(true);
    expect(useProjectsStore.getState().order).toEqual(["app"]);
    expect(useTerminalsStore.getState().loaded).toBe(true);
    expect(useThreadsStore.getState().loaded).toBe(true);
    expect(useThreadsStore.getState().order).toEqual(["th-1"]);
  });

  it("sends sinceSeq and sinceEpoch on reconnect and replays incrementally without invalidating watched gh details", async () => {
    const releaseBranch = branchPullRequestsResource.watch(branchKey("acme/app", "feat"));
    const releaseDetail = pullRequestDetailResource.watch(pullRequestKey("acme/app", 7));
    await vi.advanceTimersByTimeAsync(0);
    env.getBranchPrs = 0;
    env.getPrDetail = 0;

    let attempt = 0;
    env.stream = (req, signal) =>
      (async function* () {
        attempt++;
        if (attempt === 1) {
          yield projectSnap("ep-1", ["a"]);
          yield workspaceSnap("ep-1");
          yield threadSnap("ep-1", []);
          for (const e of ghSnap("ep-1")) yield e;
          yield projectSnap("ep-1", ["a", "b"], 5n);
          throw new TypeError("socket dropped");
        }
        if (req.sinceSeq === 5n && req.sinceEpoch === "ep-1") {
          yield projectSnap("ep-1", ["a", "b", "c"], 6n);
        }
        await park(signal);
      })();

    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(2000);
    releaseBranch();
    releaseDetail();

    expect(env.requests).toHaveLength(2);
    expect(env.requests[0]?.sinceSeq).toBeUndefined();
    expect(env.requests[1]?.sinceSeq).toBe(5n);
    expect(env.requests[1]?.sinceEpoch).toBe("ep-1");
    expect(useProjectsStore.getState().order).toEqual(["a", "b", "c"]);
    // Incremental replay did not trigger gh reconnect invalidations or settings reload.
    expect(env.getBranchPrs).toBe(0);
    expect(env.getPrDetail).toBe(0);
    expect(env.loadSchema).toBe(1);
    expect(env.listProjects + env.listTerminals + env.listThreads).toBe(0);
  });

  it("on daemon restart snapshot fallback, resets seq, prunes removed terminals, reloads schema, and invalidates watched gh caches once", async () => {
    const releaseBranch = branchPullRequestsResource.watch(branchKey("acme/app", "feat"));
    const releaseDetail = pullRequestDetailResource.watch(pullRequestKey("acme/app", 7));
    await vi.advanceTimersByTimeAsync(0);
    env.getBranchPrs = 0;
    env.getPrDetail = 0;

    let attempt = 0;
    env.stream = (_req, signal) =>
      (async function* () {
        attempt++;
        if (attempt === 1) {
          yield projectSnap("ep-1", ["a"]);
          yield workspaceSnap("ep-1");
          yield terminalUpdated("ep-1", "term-alive");
          yield terminalUpdated("ep-1", "term-gone");
          yield threadSnap("ep-1", []);
          for (const e of ghSnap("ep-1")) yield e;
          yield terminalUpdated("ep-1", "term-alive", 10n);
          throw new TypeError("daemon restarted");
        }
        if (attempt === 2) {
          // New epoch: daemon fell back to full snapshots, term-gone is no longer present.
          yield projectSnap("ep-2", ["a"]);
          yield workspaceSnap("ep-2");
          yield terminalUpdated("ep-2", "term-alive");
          yield threadSnap("ep-2", []);
          for (const e of ghSnap("ep-2")) yield e;
          throw new TypeError("drop before any live event on ep-2");
        }
        await park(signal);
      })();

    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(5000);
    releaseBranch();
    releaseDetail();

    // Terminal that exited while disconnected was pruned from the snapshot burst without listTerminals.
    expect(useTerminalsStore.getState().order).toEqual(["term-alive"]);
    expect(env.listTerminals).toBe(0);
    // Schema reloaded once on initial connect and once on epoch change.
    expect(env.loadSchema).toBe(2);
    // Watched branch list & PR detail were invalidated on the reconnect gh snapshot.
    expect(env.getBranchPrs).toBe(1);
    expect(env.getPrDetail).toBe(1);
    // Third connect after snapshot-only ep-2 sends no stale seq 10n from ep-1.
    expect(env.requests[2]?.sinceSeq).toBeUndefined();
  });
});
