import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { BrowserEventSchema, BrowserPhase, BrowserStateSchema } from "@/gen/codefoundry/v1/browser_pb";
import { BROWSER_STARTING, toBrowserEvent, toBrowserState } from "./browser";

describe("toBrowserState", () => {
  it("reads every phase", () => {
    const phase = (p: BrowserPhase) => toBrowserState(create(BrowserStateSchema, { phase: p })).phase;
    expect(phase(BrowserPhase.UNSPECIFIED)).toBe("starting");
    expect(phase(BrowserPhase.STARTING)).toBe("starting");
    expect(phase(BrowserPhase.READY)).toBe("ready");
    expect(phase(BrowserPhase.UNAVAILABLE)).toBe("unavailable");
    expect(phase(BrowserPhase.CRASHED)).toBe("crashed");
  });

  it("maps what a page asks", () => {
    const v = toBrowserState(
      create(BrowserStateSchema, {
        phase: BrowserPhase.READY,
        url: "https://example.com/",
        copied: 2n,
        site: "example.com",
        security: "insecure",
        dialog: { id: "1", kind: "prompt", message: "name?", defaultPrompt: "Ada", origin: "https://example.com", site: "example.com" },
        fileChooser: { id: "2", multiple: true, origin: "https://example.com", site: "example.com" },
        select: { id: "3", options: [{ label: "one", disabled: true }], selected: 0, x: 1, y: 2, width: 3 },
        downloads: [{ id: "g", name: "a.txt", state: "completed", site: "example.com" }],
        downloadsBlocked: 4,
      }),
    );
    expect(v.copied).toBe(2);
    expect(v.site).toBe("example.com");
    expect(v.security).toBe("insecure");
    expect(v.downloadsBlocked).toBe(4);
    expect(v.dialog).toEqual({ id: "1", kind: "prompt", message: "name?", defaultPrompt: "Ada", origin: "https://example.com", site: "example.com" });
    expect(v.fileChooser).toEqual({ id: "2", multiple: true, origin: "https://example.com", site: "example.com" });
    expect(v.select).toEqual({ id: "3", options: [{ label: "one", disabled: true }], selected: 0, x: 1, y: 2, width: 3 });
    expect(v.downloads).toEqual([{ id: "g", name: "a.txt", state: "completed", site: "example.com" }]);
  });

  it("reads a security word it does not know as nothing", () => {
    expect(toBrowserState(create(BrowserStateSchema, { security: "cert" })).security).toBe("cert");
    expect(toBrowserState(create(BrowserStateSchema, { security: "later" })).security).toBe("");
  });

  it("is the starting state with nothing set", () => {
    expect(toBrowserState(create(BrowserStateSchema, {}))).toEqual(BROWSER_STARTING);
  });
});

describe("toBrowserEvent", () => {
  it("maps a frame and a state, and nothing else", () => {
    const jpeg = new Uint8Array([1, 2]);
    expect(toBrowserEvent(create(BrowserEventSchema, { event: { case: "frame", value: { jpeg, width: 3, height: 4 } } }))).toEqual({ kind: "frame", frame: { jpeg, width: 3, height: 4 } });
    expect(toBrowserEvent(create(BrowserEventSchema, { event: { case: "state", value: {} } }))?.kind).toBe("state");
    expect(toBrowserEvent(create(BrowserEventSchema, { event: { case: "heartbeat", value: {} } }))).toBeNull();
  });
});
