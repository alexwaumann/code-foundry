import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { NotificationEventSchema, NotificationLevel, NotificationSchema, NotificationStatus } from "@/gen/codefoundry/v1/notification_pb";
import { toNotificationEventView, toNotificationView } from "./notifications";

describe("toNotificationView", () => {
  it("maps every field, the times to epoch ms", () => {
    const v = toNotificationView(
      create(NotificationSchema, {
        id: "n-000000000001",
        source: "hello",
        key: "nightly-91",
        level: NotificationLevel.WARNING,
        timeSensitive: true,
        title: "Waiting to deploy",
        body: "Stage Promote",
        threadId: "s-4",
        status: NotificationStatus.SNOOZED,
        arrivedAt: timestampFromMs(1_000),
        createdAt: timestampFromMs(500),
        snoozedUntil: timestampFromMs(9_000),
        seen: true,
      }),
    );
    expect(v).toEqual({
      id: "n-000000000001",
      source: "hello",
      key: "nightly-91",
      level: "warning",
      timeSensitive: true,
      title: "Waiting to deploy",
      body: "Stage Promote",
      threadId: "s-4",
      actions: [],
      status: "snoozed",
      arrivedAtMs: 1_000,
      createdAtMs: 500,
      snoozedUntilMs: 9_000,
      seen: true,
    });
  });

  it.each([
    [NotificationLevel.INFO, "info"],
    [NotificationLevel.WARNING, "warning"],
    [NotificationLevel.ERROR, "error"],
    [NotificationLevel.UNSPECIFIED, "info"],
  ] as const)("level %s is %s", (level, want) => {
    expect(toNotificationView(create(NotificationSchema, { level })).level).toBe(want);
  });

  it.each([
    [NotificationStatus.SHOWN, "shown"],
    [NotificationStatus.SNOOZED, "snoozed"],
    [NotificationStatus.SCHEDULED, "scheduled"],
    [NotificationStatus.DISMISSED, "dismissed"],
    [NotificationStatus.WITHDRAWN, "withdrawn"],
    [NotificationStatus.RESOLVED, "resolved"],
    [NotificationStatus.UNSPECIFIED, "shown"],
    [99 as NotificationStatus, "shown"],
  ] as const)("status %s is %s", (status, want) => {
    expect(toNotificationView(create(NotificationSchema, { status })).status).toBe(want);
  });

  it("unset times are null", () => {
    const v = toNotificationView(create(NotificationSchema, {}));
    expect([v.arrivedAtMs, v.createdAtMs, v.snoozedUntilMs]).toEqual([null, null, null]);
  });

  it("maps each action kind, its label and resolves, in order; an open action keeps its URL", () => {
    const v = toNotificationView(
      create(NotificationSchema, {
        actions: [
          { label: "Continue", resolves: true, kind: { case: "command", value: { command: "continue" } } },
          { label: "Send", resolves: true, kind: { case: "send", value: { threadId: "s-1", text: "hi" } } },
          { label: "Start", resolves: false, kind: { case: "start", value: { prompt: "go" } } },
          { label: "Open", resolves: false, kind: { case: "open", value: { url: "https://example.com" } } },
          { label: "Newer" },
        ],
      }),
    );
    expect(v.actions).toEqual([
      { label: "Continue", kind: "command", resolves: true, url: "" },
      { label: "Send", kind: "send", resolves: true, url: "" },
      { label: "Start", kind: "start", resolves: false, url: "" },
      { label: "Open", kind: "open", resolves: false, url: "https://example.com" },
      { label: "Newer", kind: "unknown", resolves: false, url: "" },
    ]);
  });
});

describe("toNotificationEventView", () => {
  it("keeps the snapshot's order, its time-sensitive and unseen counts, the arrived and updated ids", () => {
    const ev = toNotificationEventView(
      create(NotificationEventSchema, {
        snapshot: { notifications: [{ id: "n-b", timeSensitive: true }, { id: "n-a" }], timeSensitive: 1, unseen: 2, version: 7n },
        arrivedIds: ["n-b"],
        updatedIds: ["n-a"],
      }),
    );
    expect(ev.snapshot.notifications.map((n) => n.id)).toEqual(["n-b", "n-a"]);
    expect(ev.snapshot.timeSensitive).toBe(1);
    expect(ev.snapshot.unseen).toBe(2);
    expect(ev.snapshot.version).toBe(7);
    expect(ev.arrivedIds).toEqual(["n-b"]);
    expect(ev.updatedIds).toEqual(["n-a"]);
  });

  it("an event without a snapshot is an empty bell", () => {
    expect(toNotificationEventView(create(NotificationEventSchema, {})).snapshot).toEqual({ notifications: [], timeSensitive: 0, unseen: 0, version: 0 });
  });
});
