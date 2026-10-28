import { describe, expect, it } from "vitest";
import type { ThreadItemView, TurnEndView } from "@/api/thread";
import { citeLink, citeToken, type CitationBody } from "./citation";
import { apiErrorDetail, appendToDraft, draftOfSent, failedPrompt, sentAttachmentNames, type FailedPromptInput } from "./failedPrompt";

const T0 = Date.UTC(2026, 9, 28, 10, 0, 0);

let n = 0;
function base(o: { parent?: string; at?: number } = {}) {
  n++;
  return { id: `i${String(n)}`, ordinal: n, parentToolUseId: o.parent ?? "", createdAtMs: o.at ?? T0 + n * 1000, updatedAtMs: null, streaming: false };
}

const user = (text = "Fix the badge", o: { wake?: boolean; queued?: boolean } = {}): ThreadItemView => ({
  ...base(),
  kind: "user",
  text,
  attachments: [],
  composerText: "",
  ...(o.wake ? { wake: { title: "Thread is idle", json: "{}" } } : {}),
  ...(o.queued ? { queued: true as const } : {}),
});
const text = (t: string, parent = ""): ThreadItemView => ({ ...base({ parent }), kind: "text", text: t });
const error = (t: string): ThreadItemView => ({ ...base(), kind: "error", text: t });
/** Claude Code's synthetic API-error message (docs/notes/api-error-reply-flag.md). */
const apiError = (t: string): ThreadItemView => ({ ...base(), kind: "text", text: t, apiError: true });
const tool = (): ThreadItemView => ({ ...base(), kind: "tool", toolUseId: "toolu_1", name: "Bash", inputJson: "{}", status: "done", output: "", isError: false, resultJson: "" });
const commandOutput = (t: string): ThreadItemView => ({ ...base(), kind: "commandOutput", text: t });
const note = (t: string): ThreadItemView => ({ ...base(), kind: "note", text: t, createdBy: "" });

function turnEnd(o: Partial<TurnEndView> = {}): ThreadItemView {
  return {
    ...base(),
    kind: "turnEnd",
    subtype: "success",
    isError: false,
    interrupted: false,
    stopReason: "",
    terminalReason: "",
    durationMs: 0,
    numTurns: 1,
    costUsd: 0,
    turnCostUsd: null,
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: [],
    ...o,
  };
}

/** The input for items in order; the thread stopped and idle unless `o` says otherwise. */
function input(items: ThreadItemView[], o: Partial<FailedPromptInput> = {}): FailedPromptInput {
  return {
    order: items.map((it) => it.id),
    byId: Object.fromEntries(items.map((it) => [it.id, it])),
    state: "disconnected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    pending: 0,
    transcriptMissing: false,
    ...o,
  };
}

const DID_NOT_START = "Claude did not start, so your message was not sent.";
const STOPPED = "Claude stopped before replying, so your message was not sent.";
const FALLBACK = "Your message didn't go through.";
const LATER = T0 + 1_000_000;

describe("failedPrompt", () => {
  it.each<[string, () => FailedPromptInput, string | null]>([
    [
      "did not start: the daemon's error item and process_ended turn end",
      () => input([user(), error("Claude did not start: exit code 1: error: unknown option '--bogus'"), turnEnd({ subtype: "process_ended", interrupted: true })]),
      DID_NOT_START,
    ],
    ["did not start: the status alone (its item not here yet)", () => input([user()], { status: "error", statusReason: "did not start", statusChangedAtMs: LATER }), DID_NOT_START],
    ["an older failure's status does not count for a prompt sent after it", () => input([user()], { status: "error", statusReason: "did not start", statusChangedAtMs: T0 }), null],
    ["status changed at an unknown time: not counted", () => input([user()], { status: "error", statusReason: "did not start" }), null],
    ["a crash mid-turn", () => input([user(), tool(), error("Claude stopped unexpectedly (exit code 139)"), turnEnd({ subtype: "process_ended", interrupted: true })]), STOPPED],
    ["a lost run: status error interrupted, no error item", () => input([user(), tool(), turnEnd({ subtype: "process_ended", interrupted: true })], { status: "error", statusReason: "interrupted", statusChangedAtMs: LATER }), STOPPED],
    [
      "the turn ended in error with no final text",
      () => input([user(), tool(), turnEnd({ subtype: "error_during_execution", isError: true })]),
      "The request failed (error during execution), so your message was not sent.",
    ],
    ["an error subtype without is_error", () => input([user(), turnEnd({ subtype: "error_max_turns" })]), "The request failed (error max turns), so your message was not sent."],
    ["is_error with subtype success: no subtype shown", () => input([user(), turnEnd({ subtype: "success", isError: true })]), "The request failed, so your message was not sent."],
    ["another error item", () => input([user(), error("Claude did not get this message: broken pipe")]), FALLBACK],
    ["did not start wins over a failed turn end", () => input([user(), turnEnd({ subtype: "error_during_execution", isError: true }), error("Claude did not start: killed")]), DID_NOT_START],
    ["Claude replied", () => input([user(), text("Looking now."), turnEnd({ subtype: "error_during_execution", isError: true })]), null],
    ["Claude replied, then crashed", () => input([user(), text("Looking now."), error("Claude stopped unexpectedly (killed)")]), null],
    ["an empty text item is no reply", () => input([user(), text("  "), error("Claude did not start: killed")]), DID_NOT_START],
    ["a subagent's text is no reply", () => input([user(), text("sub answer", "toolu_agent"), turnEnd({ subtype: "error_during_execution", isError: true })]), "The request failed (error during execution), so your message was not sent."],
    ["a local command's output is a reply", () => input([user("/cost"), commandOutput("Total cost: $0.10"), turnEnd({ subtype: "error_during_execution", isError: true })]), null],
    ["a successful turn without text", () => input([user(), tool(), turnEnd()]), null],
    ["a user interrupt", () => input([user(), tool(), turnEnd({ subtype: "error_during_execution", isError: true, interrupted: true })]), null],
    ["a close of a busy thread: process_ended, no error", () => input([user(), tool(), turnEnd({ subtype: "process_ended", interrupted: true })]), null],
    ["only the last prompt counts", () => input([user("one"), error("Claude did not start: killed"), user("two"), text("Done."), turnEnd()]), null],
    ["the daemon's notes after the failure do not matter", () => input([user(), error("Claude did not start: killed"), note("Set effort to high")]), DID_NOT_START],
    ["no prompt at all", () => input([error("Claude did not start: killed")]), null],
    ["a wake message is not the user's", () => input([user("wake", { wake: true }), error("Claude did not start: killed")]), null],
    ["a queued message is still waiting", () => input([user("later", { queued: true }), error("Claude did not start: killed")]), null],
    ["working: Claude starting again", () => input([user(), error("Claude did not start: killed")], { state: "starting" }), null],
    ["working: busy", () => input([user(), error("Claude did not start: killed")], { state: "connected", status: "busy" }), null],
    ["a busy status from a process that is gone means nothing", () => input([user(), error("Claude did not start: killed")], { state: "disconnected", status: "busy" }), DID_NOT_START],
    ["prompts docked", () => input([user(), error("Claude did not start: killed")], { pending: 1 }), null],
    ["the transcript is gone", () => input([user(), error("Claude did not start: killed")], { transcriptMissing: true }), null],
    [
      "an API error in place of a reply (captured: invalid key)",
      () => input([user(), apiError("Invalid API key · Fix external API key"), turnEnd({ subtype: "success", isError: true, terminalReason: "api_error" })]),
      "The request failed (invalid API key), so your message was not sent.",
    ],
    ["an API error before its turn end arrives", () => input([user(), apiError("API Error: Request timed out.")]), "The request failed (request timed out), so your message was not sent."],
    ["an API error after work", () => input([user(), tool(), apiError("Rate limit reached"), turnEnd({ isError: true })]), "The request failed (rate limit reached), so your message was not sent."],
    ["a reply before the API error counts", () => input([user(), text("Looking now."), tool(), apiError("API Error: Connection error."), turnEnd({ isError: true })]), null],
    ["did not start wins over an API error", () => input([user(), apiError("Invalid API key"), error("Claude did not start: killed")]), DID_NOT_START],
    ["an API error while working", () => input([user(), apiError("Rate limit reached")], { state: "connected", status: "busy" }), null],
    ["an older prompt's API error does not count", () => input([user("one"), apiError("Invalid API key"), turnEnd({ isError: true }), user("two"), text("Done."), turnEnd()]), null],
  ])("%s", (_name, make, want) => {
    expect(failedPrompt(make())?.line ?? null).toBe(want);
  });

  it("names the prompt", () => {
    const u = user();
    expect(failedPrompt(input([text("earlier"), u, error("Claude did not start: killed")]))).toEqual({ itemId: u.id, ordinal: u.ordinal, line: DID_NOT_START });
  });
});

describe("apiErrorDetail", () => {
  it.each<[string, string]>([
    ["Invalid API key · Fix external API key", "invalid API key"],
    ["Invalid API key · Please run /login", "invalid API key"],
    ["API Error: Request timed out.", "request timed out"],
    ["Credit balance is too low", "credit balance is too low"],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
    ['API Error: 500 {"type":"error"', '500 {"type":"error"'],
    ["Claude AI usage limit reached", "Claude AI usage limit reached"],
    ["OAuth token has expired · Please run /login", "OAuth token has expired"],
    ["API Error: first line\nsecond line", "first line"],
    ["   ", ""],
    ["A".repeat(80), `${"A".repeat(59)}…`],
  ])("%s", (raw, want) => {
    expect(apiErrorDetail(raw)).toBe(want);
  });
});

const CITE: CitationBody = { threadId: "s-1", itemId: "it-9", text: "the fingerprint", comment: "why?", start: 4, end: 19, prefix: "Now ", suffix: " misses" };

describe("draftOfSent", () => {
  const ids = (map: Record<number, string>) => (i: number) => map[i];
  let c = 0;
  const newId = () => `c${String(++c)}`;

  it.each<[string, { text: string; composerText: string; attachments: string[] }, Record<number, string>, string]>([
    ["plain text (sent from the CLI)", { text: "Fix it", composerText: "", attachments: [] }, {}, "Fix it"],
    [
      "tags stay; the image chip points at its draft attachment",
      {
        text: "see [Image: a.png; ref=/s/0.png] and @cf-file://p/x.go",
        composerText: "see ![a.png](cf-attachment://0) and [x.go](cf-file://p/x.go) with [/tdd](cf-skill://~/tdd)",
        attachments: ["/s/0.png"],
      },
      { 0: "a7" },
      "see ![a.png](cf-attachment://a7) and [x.go](cf-file://p/x.go) with [/tdd](cf-skill://~/tdd)",
    ],
    ["a chip whose attachment is not put back goes", { text: "", composerText: "see ![a.png](cf-attachment://0) now", attachments: ["/s/0.png"] }, {}, "see  now"],
    ["a chip that lost its attachment before sending goes", { text: "", composerText: "see ![a.png](cf-attachment://x)", attachments: [] }, {}, "see"],
    ["lines are kept", { text: "a\n\nb", composerText: "", attachments: [] }, {}, "a\n\nb"],
  ])("%s", (_name, m, map, want) => {
    expect(draftOfSent(m, ids(map), newId).text).toBe(want);
  });

  it("turns citation links back into draft citations", () => {
    const got = draftOfSent({ text: `Look ${citeLink(CITE)} here`, composerText: "", attachments: [] }, () => undefined, () => "cnew");
    expect(got.text).toBe(`Look ${citeToken("cnew")} here`);
    expect(got.citations).toEqual([{ ...CITE, id: "cnew" }]);
  });
});

describe("sentAttachmentNames", () => {
  it("takes each chip's label, else the staged file's name", () => {
    expect(sentAttachmentNames({ text: "", composerText: "![shot.png](cf-attachment://1) ![](cf-attachment://0)", attachments: ["/s/aa.png", "/s/bb.png", "/s/cc.pdf"] })).toEqual(["aa.png", "shot.png", "cc.pdf"]);
  });
});

describe("appendToDraft", () => {
  it.each<[string, string, string]>([
    ["", "Fix it", "Fix it"],
    ["  \n", "Fix it", "Fix it"],
    ["My draft", "Fix it", "My draft\n\nFix it"],
    ["My draft\n\n", "Fix it", "My draft\n\nFix it"],
  ])("%j + %j", (draft, added, want) => {
    expect(appendToDraft(draft, added)).toBe(want);
  });
});
