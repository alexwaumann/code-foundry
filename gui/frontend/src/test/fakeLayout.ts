/**
 * A fake layout daemon for component tests of surfaces and the code that opens them: the mock
 * daemon's own layout (mock/layout.ts MockLayout, the ops the e2e mock runs, with its placement)
 * behind LayoutService.Apply, its events fed to the layout slice as the event source would. The
 * classic side panel's store played this part until it went (docs/notes/shell-21-remove-classic.md).
 *
 * Use: mock `@/api/layout` with `fakeLayoutApi` (the real module, Apply replaced), then
 * `await resetFakeLayout(seed)` in beforeEach. Store-free at import (the slice and the API are
 * imported when an op runs), so a vi.mock factory may import it:
 *
 *   vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
 */
import { create } from "@bufbuild/protobuf";
import type { LayoutApplyView, LayoutOpView, LayoutTabView } from "@/api/layout";
import { LayoutEventSchema } from "@/gen/codefoundry/v1/layout_pb";
import { MockLayout, SEEDS, opFromProto, seqIds, type LayoutEventInit, type State, type Tab } from "../../mock/layout";

export type { State as FakeLayoutState };

let events: LayoutEventInit[] = [];
let layout = new MockLayout({ publish: (ev) => events.push(ev), ids: seqIds() });
/** Every op Apply received, in order (the view model the window sent). */
export const appliedOps: LayoutOpView[] = [];

type LayoutApi = typeof import("@/api/layout");

/** The real `@/api/layout` with Apply answered by the fake. */
export function fakeLayoutApi(real: LayoutApi): LayoutApi {
  return { ...real, applyLayoutOp: (op: LayoutOpView) => fakeApply(op) };
}

async function flush(): Promise<void> {
  const [{ toLayoutEventView }, { applyLayoutEvent }] = await Promise.all([import("@/api/layout"), import("@/stores/layout")]);
  for (const ev of events.splice(0)) {
    const view = toLayoutEventView(create(LayoutEventSchema, ev));
    if (view) applyLayoutEvent(view);
  }
}

function tabView(t: Tab): LayoutTabView {
  return { id: t.id, kind: t.kind, thread: t.thread ?? "", key: t.key ?? "", params: t.params ?? {}, title: t.title ?? "", name: t.name ?? "" };
}

const inflight = new Set<Promise<unknown>>();

/** Resolves once every op sent so far (and any it led to) has been answered and its event applied. */
export async function layoutSettled(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (inflight.size === 0) return;
    await Promise.allSettled([...inflight]);
  }
}

function fakeApply(op: LayoutOpView): Promise<LayoutApplyView> {
  const p = applyNow(op);
  inflight.add(p);
  void p.finally(() => inflight.delete(p)).catch(() => undefined);
  return p;
}

async function applyNow(op: LayoutOpView): Promise<LayoutApplyView> {
  appliedOps.push(op);
  const { toLayoutOpMessage } = await import("@/api/layout");
  // A refusal (the tab went) rejects, as the daemon's does.
  const { rev, result } = layout.apply(opFromProto(toLayoutOpMessage(op)));
  await flush();
  return {
    rev,
    spaceId: result.space ?? "",
    paneId: result.pane ?? "",
    tabId: result.tab ?? "",
    existing: result.existing ?? false,
    closed: (result.closed ?? []).map(tabView),
    rule: result.rule ?? "",
    kept: [],
    ended: [],
    backTabIds: [],
    placedTabIds: [],
    freshTabIds: [],
    swappedPaneIds: [],
    draftId: result.draft ?? "",
  };
}

/**
 * A new fake with this layout (a mock seed's name, or a state in internal/layout's JSON), sent to
 * the slice as a snapshot. Default: one space whose pane holds thread s-1's tab.
 */
export async function resetFakeLayout(seed: State | string = "one-thread"): Promise<void> {
  // An op of the previous test still on its way would flush into the new layout: let it land first.
  await Promise.allSettled([...inflight]);
  const { resetLayout } = await import("@/stores/layout");
  resetLayout();
  events = [];
  appliedOps.length = 0;
  layout = new MockLayout({ publish: (ev) => events.push(ev), ids: seqIds() });
  layout.seed(seed);
  events = [layout.snapshotEvent()];
  await flush();
}

/** The fake's layout now (internal/layout's JSON). */
export function fakeLayoutState(): State {
  return layout.state();
}

/** One space with one pane holding a thread's tab (`thread`), focused: a mock seed's shape for any thread id. */
export function threadSeed(thread: string): State {
  const st = SEEDS["one-thread"]?.() as State;
  const root = st.spaces[0]?.root;
  if (root?.tabs?.[0]) root.tabs[0] = { id: `t-${thread}`, kind: "thread", thread };
  if (root) root.active = `t-${thread}`;
  if (st.spaces[0]) st.spaces[0].mru = [`t-${thread}`];
  return st;
}
