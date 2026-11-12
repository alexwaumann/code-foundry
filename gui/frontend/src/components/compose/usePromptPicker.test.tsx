import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/thread", async (orig) => ({ ...(await orig<typeof import("@/api/thread")>()), ...(await import("@/test/composerFakes")).promptFakes }));

const { usePromptPicker } = await import("./usePromptHistory");

afterEach(cleanup);

const up = { key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: () => undefined } as unknown as KeyboardEvent;

function usePicker(draftKey: string, resetKey?: string) {
  return usePromptPicker({
    draftKey,
    resetKey,
    editorRef: createRef(),
    rootRef: createRef(),
    threadId: "",
    source: { projectIds: ["repo-cf"] },
    canOpen: true,
    blocked: false,
  });
}

// A window shell composer gains its draft id with the first key typed (shell/composerDrafts.ts):
// the same composer, so its open picker stays open; another composer (another project) closes it.
describe("the prompt picker across a draft key change", () => {
  it("stays open when only the draft key changes, closes when what the composer shows changes", () => {
    const { result, rerender } = renderHook(({ draft, reset }: { draft: string; reset: string }) => usePicker(draft, reset), { initialProps: { draft: "repo-cf", reset: "repo-cf" } });
    act(() => {
      result.current.onKeyDown(up, true);
    });
    expect(result.current.card.open).toBe(true);
    rerender({ draft: "draft:d-1", reset: "repo-cf" });
    expect(result.current.card.open).toBe(true);
    rerender({ draft: "draft:d-1", reset: "repo-gp" });
    expect(result.current.card.open).toBe(false);
  });

  it("without a reset key, any draft key change closes it (a thread's composer)", () => {
    const { result, rerender } = renderHook(({ draft }: { draft: string }) => usePicker(draft), { initialProps: { draft: "thread:s-1" } });
    act(() => {
      result.current.onKeyDown(up, true);
    });
    expect(result.current.card.open).toBe(true);
    rerender({ draft: "thread:s-2" });
    expect(result.current.card.open).toBe(false);
  });
});
