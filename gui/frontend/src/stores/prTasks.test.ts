import { describe, expect, it } from "vitest";
import { parseTaskResult, taskToast } from "./prTasks";

describe("parseTaskResult", () => {
  it.each([
    ['{"threadId":"s-3","sent":true,"ordinal":4}', { threadId: "s-3", sent: true }],
    ['{"threadId":"s-9","sent":false,"cloned":true}', { threadId: "s-9", sent: false }],
    ['{"sent":false}', { threadId: "", sent: false }],
    ["", { threadId: "", sent: false }],
    ["not json", { threadId: "", sent: false }],
  ])("%s", (json, want) => {
    expect(parseTaskResult(json)).toEqual(want);
  });
});

describe("taskToast", () => {
  it.each([
    ["Sent to Fix resize race (s-3) (#60); wait with: code-foundry thread wait s-3 --after 60", true, "Sent to Fix resize race (s-3) (#60)"],
    ["Sent to x (s-3) (#2); you are subscribed (wake on settled): end your turn", true, "Sent to x (s-3) (#2)"],
    ["Sent to a; b (s-3) (#5); wait with: code-foundry thread wait s-3 --after 5", true, "Sent to a; b (s-3) (#5)"],
    ["Started thread Fix it (s-9) for PR #7", false, "Started thread Fix it (s-9) for PR #7"],
    ["Cloned o/r and started thread a; b (s-9) for PR #7", false, "Cloned o/r and started thread a; b (s-9) for PR #7"],
  ])("%s", (message, sent, want) => {
    expect(taskToast(message, sent)).toBe(want);
  });
});
