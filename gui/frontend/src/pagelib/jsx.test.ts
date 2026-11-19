import { describe, expect, it } from "vitest";

/*
 * /cf/jsx.js's error box for an uncaught error. In a frame of an opaque origin (a page no
 * thread owns) WebKit hands the error event of an error React reports from /cf/ modules as
 * "Script error." with no error: the loader keeps what window.reportError was handed.
 */

/** reportError as WebKit behaves for a script of another origin: the event carries no error. */
function hidingReportError(error: unknown): void {
  void error;
  window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", error: null }));
}

const box = () => document.querySelector("[data-cf-jsx-error]")?.textContent ?? "";

describe("jsx.js error box", () => {
  it("shows the message of an error handed to reportError, and says what to look for when the browser hid one", async () => {
    window.reportError = hidingReportError;
    await import("./jsx");
    window.reportError(new TypeError("null is not an object (evaluating 'cf.thread.id')"));
    expect(box()).toContain("null is not an object (evaluating 'cf.thread.id')");
    expect(box()).not.toContain("Script error.");
    // An error event with nothing behind it (thrown straight from another origin's script).
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", error: null }));
    expect(box()).toMatch(/Script error\. The browser hid this error's message: .*cf\.thread is null on a page no thread owns/);
  });
});
