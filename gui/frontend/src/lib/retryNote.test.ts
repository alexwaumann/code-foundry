import { describe, expect, it } from "vitest";
import type { ApiRetryView } from "@/api/session";
import { fmtRetryIn, retryCause, retryNote, type RetryNoteInput } from "./retryNote";

const DUE = Date.UTC(2026, 9, 13, 10, 0, 0);

function retry(o: Partial<ApiRetryView> = {}): ApiRetryView {
  return { attempt: 3, maxRetries: 10, retryAtMs: DUE, errorStatus: 429, error: "rate_limit", ...o };
}

function input(o: Partial<RetryNoteInput> = {}): RetryNoteInput {
  return { retry: retry(), nowMs: DUE - 20_000, ...o };
}

describe("retryNote", () => {
  it.each<[string, Partial<RetryNoteInput>, string | null]>([
    ["a rate limit, 20 s out", {}, "Rate limited · retrying in 20 s (attempt 3 of 10)"],
    ["a fraction of a second rounds up", { nowMs: DUE - 1 }, "Rate limited · retrying in 1 s (attempt 3 of 10)"],
    ["past due: the request is in flight", { nowMs: DUE + 5_000 }, "Rate limited · retrying now (attempt 3 of 10)"],
    ["overloaded", { retry: retry({ error: "overloaded", errorStatus: 529 }) }, "API overloaded · retrying in 20 s (attempt 3 of 10)"],
    ["a server error by status", { retry: retry({ error: "server_error", errorStatus: 500 }) }, "API error 500 · retrying in 20 s (attempt 3 of 10)"],
    ["a connection error", { retry: retry({ error: "connection", errorStatus: 0 }) }, "No response from the API · retrying in 20 s (attempt 3 of 10)"],
    ["no max", { retry: retry({ maxRetries: 0 }) }, "Rate limited · retrying in 20 s (attempt 3)"],
    ["no retry", { retry: null }, null],
  ])("%s", (_name, over, want) => {
    expect(retryNote(input(over))).toBe(want);
  });
});

describe("retryCause", () => {
  it.each<[Pick<ApiRetryView, "error" | "errorStatus">, string]>([
    [{ error: "rate_limit", errorStatus: 429 }, "Rate limited"],
    [{ error: "", errorStatus: 429 }, "Rate limited"],
    [{ error: "", errorStatus: 529 }, "API overloaded"],
    [{ error: "", errorStatus: 503 }, "API error 503"],
    [{ error: "something_new", errorStatus: 0 }, "API error (something_new)"],
    [{ error: "", errorStatus: 0 }, "API error"],
  ])("%j", (r, want) => {
    expect(retryCause(r)).toBe(want);
  });
});

describe("fmtRetryIn", () => {
  it.each<[number, string]>([
    [500, "1 s"],
    [20_000, "20 s"],
    [60_000, "1 min"],
    [65_000, "1 min 5 s"],
    [180_000, "3 min"],
  ])("%d ms", (ms, want) => {
    expect(fmtRetryIn(ms)).toBe(want);
  });
});
