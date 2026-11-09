import { afterEach, describe, expect, it, vi } from "vitest";
import type { Field, FormNodeData } from "@/api/plugin";
import { demoView } from "@/test/pluginFixtures";
import { flatFields, formValues, liveSender, validateField, validateForm, valueString } from "./form";

const form = demoView("form").nodes.find((n) => n.form)?.form as FormNodeData;

describe("form values", () => {
  it("flattens fieldsets", () => {
    expect(flatFields(form.fields).map((f) => f.name)).toEqual(["name", "token", "project", "env", "tags", "reviewers", "notifyFail", "notifyDone"]);
  });

  it("sends the plugin's values for pristine fields and drafts for changed ones; secrets only typed and only in a submit", () => {
    expect(formValues(form, undefined, true)).toEqual({ name: "", project: "", env: "dev", tags: ["a"], reviewers: [], notifyFail: true, notifyDone: false });
    const drafts = { name: "Ada", token: "tok", tags: ["a", "c"] };
    expect(formValues(form, drafts, true)).toMatchObject({ name: "Ada", token: "tok", tags: ["a", "c"] });
    expect(formValues(form, drafts, false)).not.toHaveProperty("token");
  });

  it("joins lists for commands and change events", () => {
    expect(valueString(["a", "b"])).toBe("a,b");
    expect(valueString(true)).toBe("true");
  });
});

describe("validation", () => {
  const name = form.fields[0] as Field;
  it.each([
    ["required and empty", "", "Required"],
    ["the pattern", "Ada1", "Letters and spaces only"],
    ["too long", "A".repeat(41), "At most 40 characters"],
    ["fine", "Ada Lovelace", null],
  ])("%s", (_n, v, want) => {
    expect(validateField(name, v)).toBe(want);
  });

  it("passes a required secret that is stored, and skips patterns JavaScript cannot read", () => {
    expect(validateField({ key: "t", name: "t", required: true, input: { kind: "secret", hasValue: true } }, undefined)).toBeNull();
    expect(validateField({ key: "t", name: "t", required: true, input: { kind: "secret" } }, undefined)).toBe("Required");
    expect(validateField({ key: "p", name: "p", input: { pattern: "(?P<x>a)" } }, "b")).toBeNull();
    expect(validateField({ key: "d", name: "d", required: true, disabled: true, input: {} }, "")).toBeNull();
  });

  it("checks the whole form", () => {
    expect(validateForm(form, undefined)).toEqual({ name: "Required" });
    expect(validateForm(form, { name: "Ada" })).toEqual({});
  });
});

describe("liveSender", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A send that stays open until `finish` is called. */
  function held() {
    const sent: string[] = [];
    const open: (() => void)[] = [];
    const send = (v: string) => {
      sent.push(v);
      return new Promise<void>((resolve) => open.push(resolve));
    };
    return { sent, send, finish: () => open.shift()?.() };
  }

  it("waits for a pause and sends only the latest text", () => {
    vi.useFakeTimers();
    const { sent, send } = held();
    const live = liveSender(send, 300);
    live.push("a");
    vi.advanceTimersByTime(200);
    live.push("ab");
    vi.advanceTimersByTime(299);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["ab"]);
  });

  it("sends one at a time, the latest last", async () => {
    vi.useFakeTimers();
    const { sent, send, finish } = held();
    const live = liveSender(send, 300);
    live.push("a");
    vi.advanceTimersByTime(300);
    live.push("ab");
    vi.advanceTimersByTime(300);
    live.push("abc");
    vi.advanceTimersByTime(300);
    expect(sent).toEqual(["a"]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["a", "abc"]);
  });

  it("sends the same text twice running once, and a change back again", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const live = liveSender((v) => {
      sent.push(v);
      return Promise.resolve();
    }, 300);
    for (const v of ["a", "a", "", "a"]) {
      live.push(v);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(sent).toEqual(["a", "", "a"]);
  });

  it("flushes at once and cancels what waits", () => {
    vi.useFakeTimers();
    const { sent, send } = held();
    const live = liveSender(send, 300);
    live.push("a");
    live.flush();
    expect(sent).toEqual(["a"]);
    const other = held();
    const gone = liveSender(other.send, 300);
    gone.push("b");
    gone.cancel();
    vi.advanceTimersByTime(1000);
    expect(other.sent).toEqual([]);
  });
});
