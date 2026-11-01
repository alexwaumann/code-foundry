import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationView } from "@/api/dictation";

vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));
// Send: what the draft held when the thread's send ran.
const sent = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("@/stores/threadActions", async (orig) => {
  const mod = await orig<typeof import("@/stores/threadActions")>();
  return {
    ...mod,
    sendThreadDraft: async (threadId: string) => {
      // Imported here: the compose store imports this module.
      const { useComposeStore } = await import("@/stores/compose");
      sent.texts.push(useComposeStore.getState().drafts[mod.threadDraftKey(threadId)]?.text ?? "");
      return true;
    },
  };
});

const { fakeDictation, dictationSnap } = await import("@/test/dictation");
const { useSettingsStore } = await import("@/stores/settings");
const { useComposeStore } = await import("@/stores/compose");
const { resetDictationForTests, useDictationStore } = await import("@/stores/dictation");
const { ThreadComposer } = await import("./ThreadComposer");

const ENGINE_FAILED = "the engine exited 3 times in a row: signal: killed";

async function publish(s: DictationView): Promise<void> {
  await act(async () => {
    fakeDictation.publish(s);
    await vi.waitFor(() => {
      expect(useDictationStore.getState().snapshot).toBe(s);
    });
  });
}

/** The thread's composer with dictation on and the daemon at `s`; resolves once the snapshot is in. */
async function mount(s: DictationView): Promise<void> {
  fakeDictation.publish(s);
  render(<ThreadComposer threadId="s-3" pending={[]} busy={false} />);
  await vi.waitFor(() => {
    expect(useDictationStore.getState().snapshot).toBe(s);
  });
}

const mic = () => screen.getByTestId("dictation-mic");
const pill = () => screen.findByTestId("dictation-pill");

beforeEach(() => {
  sent.texts = [];
  useSettingsStore.setState({ snapshot: { values: { "dictation.enabled": "true" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
});
afterEach(() => {
  cleanup();
  resetDictationForTests();
  fakeDictation.reset();
  useComposeStore.setState({ drafts: {} });
});

describe("the thread composer's dictation", () => {
  it("the placeholder says Listening… in an empty prompt", async () => {
    await mount(dictationSnap());
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).not.toBe("Listening…");
    fireEvent.click(mic());
    await pill();
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).toBe("Listening…");
  });

  it("Send while listening stops with flush, waits for the last phrase, then sends", async () => {
    fakeDictation.setFlushPhrase("Ship it.");
    await mount(dictationSnap());
    fireEvent.click(mic());
    await pill();
    // Empty prompt: Send is on while listening (the flush may bring text).
    const send = screen.getByTestId("thread-send");
    expect(send).toHaveProperty("disabled", false);
    fireEvent.click(send);
    await vi.waitFor(() => {
      expect(sent.texts).toEqual(["Ship it."]);
    });
    expect(screen.getByTestId("dictation-mic")).not.toBeNull();
    expect(fakeDictation.calls.at(-1)).toMatch(/^stop dict-\d+ true$/);
  });

  it("Send is off in an empty prompt while not listening", async () => {
    await mount(dictationSnap());
    expect(screen.getByTestId("thread-send")).toHaveProperty("disabled", true);
  });

  it("a model that unloaded: Loading model… first, then listening", async () => {
    const release = fakeDictation.holdStart();
    await mount(dictationSnap({ state: "unloaded" }));
    fireEvent.click(mic());
    expect((await screen.findByTestId("dictation-loading")).textContent).toBe("Loading model…");
    expect(screen.queryByTestId("dictation-pill")).toBeNull();
    act(() => {
      release();
    });
    await pill();
    expect(screen.queryByTestId("dictation-loading")).toBeNull();
  });

  it("the engine's failure: the mic is disabled with the failure in its label", async () => {
    await mount(dictationSnap({ state: "error", error: ENGINE_FAILED }));
    expect(mic()).toHaveProperty("disabled", true);
    expect(mic().getAttribute("aria-label")).toMatch(/Dictation failed: the engine exited 3 times/);
  });

  it("microphone denied: the line under the composer that pressed, with the System Settings link", async () => {
    await mount(dictationSnap());
    fireEvent.click(mic());
    await pill();
    // The host reports macOS refused: the session ends and the composer says why.
    await publish(dictationSnap({ state: "listening", micDenied: true, session: { id: fakeDictation.sessionId, clientId: "x", startedAtMs: 1 } }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("dictation-mic")).not.toBeNull();
    });
    const note = screen.getByTestId("dictation-denied");
    expect(note.textContent).toBe("Code Foundry can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.");
    expect(screen.getByTestId("dictation-denied-link")).not.toBeNull();
    expect(fakeDictation.calls.at(-1)).toMatch(/^stop dict-\d+ false$/);
  });

  it("a session held elsewhere (the CLI) gives way to this composer", async () => {
    await mount(dictationSnap({ state: "listening", session: { id: "dict-cli", clientId: "cli", startedAtMs: 1 } }));
    fireEvent.click(mic());
    await pill();
    expect(fakeDictation.calls[0]).toBe("stop dict-cli true");
    expect(fakeDictation.calls[1]).toMatch(/^start thread:s-3@/);
  });
});

describe("the thread composer's placeholders (composer-polish.spec.ts)", () => {
  it("idle: reply or ask, Send off in an empty prompt; busy: steer the agent", async () => {
    await mount(dictationSnap());
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).toBe("Reply or ask anything. @ files and threads, / skills and commands");
    expect(screen.getByTestId("thread-send")).toHaveProperty("disabled", true);
    cleanup();
    render(<ThreadComposer threadId="s-3" pending={[]} busy />);
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).toBe("Steer the agent mid-turn. @ files and threads, / skills and commands");
  });
});

describe("the mic's availability and the session's end (dictation.spec.ts)", () => {
  const setEnabled = (on: boolean) => {
    act(() => {
      useSettingsStore.setState({ snapshot: { values: { "dictation.enabled": on ? "true" : "false" }, path: "", revision: 2, loadError: "", issues: [], restartPending: [] } });
    });
  };

  it("no mic while dictation is off or has no model; once ready, left of attach; turned off, none again", async () => {
    setEnabled(false);
    render(<ThreadComposer threadId="s-3" pending={[]} busy={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("thread-attach")).not.toBeNull();
    expect(screen.queryByTestId("dictation-mic")).toBeNull();
    setEnabled(true);
    await publish(dictationSnap({ model: { downloaded: false } }));
    expect(screen.queryByTestId("dictation-mic")).toBeNull();
    await publish(dictationSnap());
    // Left of attach: before it in the row.
    expect(mic().compareDocumentPosition(screen.getByTestId("thread-attach")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    setEnabled(false);
    await vi.waitFor(() => {
      expect(screen.queryByTestId("dictation-mic")).toBeNull();
    });
  });

  it("an auto-stop (the daemon's end) returns to the mic without a failure; turning dictation off ends it", async () => {
    await mount(dictationSnap());
    fireEvent.click(mic());
    await pill();
    act(() => {
      fakeDictation.end("silence");
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("dictation-mic")).not.toBeNull();
    });
    expect(screen.queryByTestId("dictation-failure")).toBeNull();

    fireEvent.click(mic());
    await pill();
    // Turned off in Settings: the daemon ends the session and says it is off.
    act(() => {
      fakeDictation.end("disabled");
    });
    await publish(dictationSnap({ enabled: false }));
    setEnabled(false);
    await vi.waitFor(() => {
      expect(screen.queryByTestId("dictation-pill")).toBeNull();
      expect(screen.queryByTestId("dictation-mic")).toBeNull();
    });
  });

  it("one composer at a time: the dictating composer unmounting stops it; another composer starts its own", async () => {
    await mount(dictationSnap());
    fireEvent.click(mic());
    await pill();
    cleanup();
    await vi.waitFor(() => {
      expect(fakeDictation.calls.filter((c) => c.startsWith("stop "))).toHaveLength(1);
    });
    render(<ThreadComposer threadId="s-4" pending={[]} busy={false} />);
    fireEvent.click(await screen.findByTestId("dictation-mic"));
    await pill();
    const starts = fakeDictation.calls.filter((c) => c.startsWith("start "));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatch(/^start thread:s-4@/);
  });
});
