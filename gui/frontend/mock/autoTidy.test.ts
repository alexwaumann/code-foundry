import { describe, expect, it } from "vitest";
import { ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { tidyAfterMs, tidyCard, tidyPlan, type TidyThread } from "./autoTidy";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 12);

const t = (id: string, o: Partial<TidyThread> = {}): TidyThread => ({
  id, name: id, state: ThreadState.DISCONNECTED, status: ThreadStatus.IDLE, statusReason: "at prompt", pinned: false, archivedAt: null, snoozedUntil: null, savedAt: null, snoozeEvent: null,
  lastActivityAt: new Date(NOW - 10 * DAY), returnedAt: null, owner: "", resident: "", inSidebar: true, settingUp: false, ...o,
});

describe("the mock's auto-tidy", () => {
  it("reads the settings' values as the daemon does", () => {
    expect([tidyAfterMs("off"), tidyAfterMs("1d"), tidyAfterMs("2w"), tidyAfterMs("3mo")]).toEqual([0, DAY, 14 * DAY, 90 * DAY]);
  });

  it("saves the idle threads at rest and archives the old saves, leaving the exempt ones", () => {
    const threads = [
      t("idle"),
      t("recent", { lastActivityAt: new Date(NOW - DAY) }),
      t("pinned", { pinned: true }),
      t("working", { state: ThreadState.CONNECTED, status: ThreadStatus.BUSY, statusReason: "working" }),
      t("asking", { status: ThreadStatus.NEEDS_ATTENTION, statusReason: "question: Which?" }),
      t("finished", { status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished" }),
      t("child", { inSidebar: false }),
      t("ember", { resident: "ember" }),
      t("named"),
      t("back", { returnedAt: new Date(NOW - DAY) }),
      t("timed", { snoozedUntil: new Date(NOW + DAY) }),
      t("saved", { savedAt: new Date(NOW - 8 * DAY) }),
      t("saved-recently", { savedAt: new Date(NOW - DAY) }),
      t("until-event", { savedAt: new Date(NOW - 8 * DAY), snoozeEvent: { label: "#812 merged" } }),
    ];
    expect(tidyPlan(threads, new Set(["named"]), NOW, 3 * DAY, 7 * DAY)).toEqual({ save: ["idle"], archive: ["saved"] });
    expect(tidyPlan(threads, new Set(), NOW, 0, 0)).toEqual({ save: [], archive: [] });
  });

  it("words the cards as the daemon does", () => {
    expect(tidyCard("saved", ["A", "B", "C", "D", "E"])).toMatchObject({ source: "threads", key: "auto-saved", level: "info", title: "5 idle threads were saved for later", body: "Under Snoozed: A, B, C and 2 more." });
    expect(tidyCard("archived", ["A"])).toMatchObject({ key: "auto-archived", title: "1 saved thread was archived", body: "Under Archived: A." });
  });
});
