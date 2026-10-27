import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const archiveThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const removeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), archiveThread, removeThread }));

const { TranscriptDeletedChip, TranscriptDeletedNote } = await import("./TranscriptDeleted");
const { useThreadsStore } = await import("@/stores/threads");

function put(o: Partial<ThreadView>): void {
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", archivedAtMs: null, ...o } as ThreadView }, order: ["s-1"] });
}

beforeEach(() => {
  archiveThread.mockClear();
  removeThread.mockClear();
});

afterEach(cleanup);

// docs/notes/transcript-deleted.md
describe("TranscriptDeleted", () => {
  it("shows nothing for a thread that can continue", () => {
    put({});
    render(
      <>
        <TranscriptDeletedChip id="s-1" />
        <TranscriptDeletedNote threadId="s-1" />
      </>,
    );
    expect(screen.queryByTestId("thread-transcript-deleted")).toBeNull();
    expect(screen.queryByTestId("thread-transcript-note")).toBeNull();
  });

  it("the header chip: amber, a trash icon, the words", () => {
    put({ transcriptMissing: true });
    render(<TranscriptDeletedChip id="s-1" />);
    const chip = screen.getByTestId("thread-transcript-deleted");
    expect(chip.textContent).toBe("Transcript deleted");
    expect(chip.className).toContain("text-cf-warning-text");
    expect(chip.querySelector("svg")?.getAttribute("class")).toContain("lucide-trash-2");
  });

  it("the note says why and offers only Archive and Remove, which run the thread actions", () => {
    put({ transcriptMissing: true });
    render(<TranscriptDeletedNote threadId="s-1" />);
    const note = screen.getByTestId("thread-transcript-note");
    expect(note.textContent).toContain("This thread can't continue.");
    expect(note.textContent).toContain("Claude Code deleted its transcript, so Claude no longer has this conversation.");
    expect(note.textContent).toContain("cleanupPeriodDays (30 days by default), a Claude Code setting in ~/.claude/settings.json, not a Code Foundry one.");
    expect(note.querySelectorAll("button")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("thread-transcript-archive"));
    expect(archiveThread).toHaveBeenCalledWith("s-1", true);
    fireEvent.click(screen.getByTestId("thread-transcript-remove"));
    expect(removeThread).toHaveBeenCalledWith("s-1");
  });

  it("an archived thread: Remove only", () => {
    put({ transcriptMissing: true, archivedAtMs: 1 });
    render(<TranscriptDeletedNote threadId="s-1" />);
    expect(screen.queryByTestId("thread-transcript-archive")).toBeNull();
    expect(screen.getByTestId("thread-transcript-remove")).toBeTruthy();
  });
});
