import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { LayoutDir, LayoutEdge, LayoutEventSchema, LayoutOpSchema } from "@/gen/codefoundry/v1/layout_pb";
import { toEventView } from "./events";
import { opFromProto } from "../../mock/layout";
import { toLayoutOpMessage } from "./layout";

const wire = (ev: ReturnType<typeof create<typeof EventSchema>>) => fromBinary(EventSchema, toBinary(EventSchema, ev));

describe("the layout source's events", () => {
  it("maps a snapshot to the layout's JSON shape, a tree the geometry reads as it is", () => {
    const layout = create(LayoutEventSchema, {
      rev: 7n,
      change: {
        case: "snapshot",
        value: {
          rev: 7n,
          currentSpaceId: "sp-a",
          defaultSpaceId: "sp-a",
          spaces: [
            {
              id: "sp-a",
              name: "Main",
              focusPaneId: "p-a",
              mruTabIds: ["t-a"],
              root: {
                node: {
                  case: "split",
                  value: {
                    id: "s-r",
                    dir: LayoutDir.COL,
                    sizes: [0.7, 0.3],
                    children: [
                      { node: { case: "pane", value: { id: "p-a", activeTabId: "t-a", tabs: [{ id: "t-a", kind: "thread", threadId: "th-a", key: "thread:th-a" }] } } },
                      { node: { case: "pane", value: { id: "p-t", activeTabId: "", collapsed: true, tabs: [{ id: "t-t", kind: "terminal", threadId: "th-a", key: "term:x", params: { terminal: "x" }, name: "build" }] } } },
                    ],
                  },
                },
              },
            },
            { id: "sp-b", name: "Empty", drafts: [{ id: "d-1", label: "Fix the build", params: { project: "pj" } }] },
          ],
          threads: [
            {
              threadId: "th-a",
              spaceId: "sp-a",
              quick: { open: true, height: 200, ran: "make dev" },
              info: false,
              rememberedPaneId: "p-a",
              remembered: [{ tab: { id: "t-d", kind: "diff", threadId: "th-a" }, paneId: "p-x", index: 1, active: true, beside: { neighbourPaneIds: ["p-a"], edge: LayoutEdge.RIGHT, frac: 0.4 } }],
            },
          ],
        },
      },
    });
    const v = toEventView(wire(create(EventSchema, { seq: 3n, event: { case: "layout", value: layout } })));
    expect(v).toEqual({
      source: "layout",
      event: {
        kind: "snapshot",
        rev: 7,
        clientId: "",
        layout: {
          rev: 7,
          currentSpaceId: "sp-a",
          defaultSpaceId: "sp-a",
          spaces: [
            {
              id: "sp-a",
              name: "Main",
              focus: "p-a",
              mru: ["t-a"],
              drafts: [],
              root: {
                t: "split",
                id: "s-r",
                dir: "col",
                sizes: [0.7, 0.3],
                kids: [
                  { t: "pane", id: "p-a", active: "t-a", tabs: [{ id: "t-a", kind: "thread", thread: "th-a", key: "thread:th-a", params: {}, title: "", name: "" }] },
                  // An unset active tab is the first; a pane the user collapsed says so (absent: open).
                  { t: "pane", id: "p-t", active: "t-t", collapsed: true, tabs: [{ id: "t-t", kind: "terminal", thread: "th-a", key: "term:x", params: { terminal: "x" }, title: "", name: "build" }] },
                ],
              },
            },
            { id: "sp-b", name: "Empty", focus: "", mru: [], root: null, drafts: [{ id: "d-1", label: "Fix the build", params: { project: "pj" } }] },
          ],
          threads: [
            {
              threadId: "th-a",
              spaceId: "sp-a",
              quick: { open: true, height: 200, ran: "make dev" },
              info: false,
              rememberedPaneId: "p-a",
              remembered: [
                {
                  tab: { id: "t-d", kind: "diff", thread: "th-a", key: "", params: {}, title: "", name: "" },
                  paneId: "p-x",
                  index: 1,
                  active: true,
                  adjacent: false,
                  beside: { neighbours: ["p-a"], edge: "right", frac: 0.4 },
                  fresh: null,
                },
              ],
            },
          ],
          legacyImported: false,
          newer: [],
        },
      },
    });
  });

  it("maps a delta with its rev and the client that made it", () => {
    const layout = create(LayoutEventSchema, {
      rev: 8n,
      clientId: "win-1",
      change: { case: "delta", value: { spaces: [{ id: "sp-b", name: "Later" }], removedSpaceIds: ["sp-c"], spaceOrder: ["sp-a", "sp-b"], currentSpaceId: "sp-a", defaultSpaceId: "sp-a", removedThreadIds: ["th-z"], legacyImported: true } },
    });
    const v = toEventView(wire(create(EventSchema, { event: { case: "layout", value: layout } })));
    expect(v).toEqual({
      source: "layout",
      event: {
        kind: "delta",
        rev: 8,
        clientId: "win-1",
        delta: {
          spaces: [{ id: "sp-b", name: "Later", root: null, focus: "", mru: [], drafts: [] }],
          removedSpaceIds: ["sp-c"],
          spaceOrder: ["sp-a", "sp-b"],
          currentSpaceId: "sp-a",
          defaultSpaceId: "sp-a",
          threads: [],
          removedThreadIds: ["th-z"],
          legacyImported: true,
        },
      },
    });
  });
});

describe("ops as the daemon reads them", () => {
  const roundTrip = (op: Parameters<typeof toLayoutOpMessage>[0]) => fromBinary(LayoutOpSchema, toBinary(LayoutOpSchema, toLayoutOpMessage(op))).op;

  it("names each op's case and carries its fields", () => {
    expect(roundTrip({ op: "focus_tab", tab: "t-1" })).toMatchObject({ case: "focusTab", value: { tabId: "t-1" } });
    expect(roundTrip({ op: "split_pane", pane: "p-1", edge: "bottom", tab: { kind: "terminal", thread: "th", params: { terminal: "x" } }, frac: 0.3 })).toMatchObject({
      case: "splitPane",
      value: { paneId: "p-1", edge: LayoutEdge.BOTTOM, frac: 0.3, tab: { kind: "terminal", threadId: "th", params: { terminal: "x" } } },
    });
    expect(roundTrip({ op: "new_space", switch: true })).toMatchObject({ case: "newSpace", value: { name: "", makeCurrent: true } });
  });

  it("keeps an index of 0 and leaves an absent one unset", () => {
    const at0 = roundTrip({ op: "add_tab", tab: { kind: "prs" }, index: 0 });
    const none = roundTrip({ op: "add_tab", tab: { kind: "prs" } });
    expect(at0.case === "addTab" && at0.value.index).toBe(0);
    expect(none.case === "addTab" && none.value.index).toBeUndefined();
  });

  it("are read by the mock daemon as the op they name", () => {
    const sent: Parameters<typeof toLayoutOpMessage>[0][] = [
      { op: "add_tab", pane: "p-1", tab: { kind: "prs" }, index: 1, focus: true },
      { op: "split_pane", pane: "p-1", edge: "right", tab: { kind: "file", thread: "s-1", params: { path: "/a" } }, frac: 0.3 },
      { op: "move_tab", tab: "t-1", pane: "p-2", edge: "bottom" },
      { op: "set_tab_params", tab: "t-1", params: { path: "/b" }, title: "b" },
      { op: "new_space", name: "Review", switch: true },
      { op: "set_sizes", split: "s-1", sizes: [0.3, 0.7] },
      { op: "new_thread", pane: "p-1", params: { project: "pj" }, focus: true },
      { op: "start_draft", tab: "t-1", draft: "d-mine", label: "Fix it" },
      { op: "open_draft", draft: "d-mine", focus: true },
      { op: "open_thread", thread: "s-1", compose: "t-1", focus: true },
      { op: "open_surface", tab: { kind: "prs" }, space: "sp-b" },
    ];
    for (const op of sent) {
      const msg = fromBinary(LayoutOpSchema, toBinary(LayoutOpSchema, toLayoutOpMessage(op)));
      const back = opFromProto(msg);
      expect(Object.fromEntries(Object.entries(back).filter(([, v]) => v !== "" && v !== undefined && v !== false && v !== 0))).toEqual(
        Object.fromEntries(Object.entries(op).map(([k, v]) => [k, k === "tab" && typeof v === "object" ? { id: "", ...v } : v])),
      );
    }
  });
});
