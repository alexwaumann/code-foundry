import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";

vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

// The dictation.* commands go to the daemon; dictation.remove asks first, as the daemon's does.
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
const REMOVE_CONFIRM = "Remove the dictation model? Dictation stops until you download it again (about 0.9 GB).";
const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  listCommands: () => Promise.resolve([]),
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
const saveSettings = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true as const })));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings }));

const { fakeDictation, dictationSnap } = await import("@/test/dictation");
const { useSettingsStore } = await import("@/stores/settings");
const { resetDictationForTests, useDictationStore } = await import("@/stores/dictation");
const { SettingsSection } = await import("./SectionCard");
const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");

// The daemon's schema for General › Dictation (internal/store/settings/schema.go).
const field: SettingFieldView = {
  key: "dictation.enabled",
  title: "Dictation",
  type: "bool",
  description: "Adds a microphone button to every composer and the ⇧⌘M shortcut.",
  group: "dictation",
  enumValues: [],
  enumLabels: [],
  defaultValue: "false",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "general",
  section: "dictation",
  unit: "",
  dependsOn: "",
  row: "",
};
const section = { id: "dictation", title: "Dictation", description: "Speak into any composer. Transcribed on this Mac with Whisper; audio never leaves it." };
const schema: SettingsSchemaView = { groups: [], fields: [field], pages: [{ id: "general", title: "General", description: "", sections: [section] }] };

const M1 = { chip: "Apple M1 Pro", memoryBytes: 16 * 2 ** 30, m1Family: true };
const NO_MODEL = { downloaded: false, sizeBytes: 874_188_075 };

function setEnabled(on: boolean): void {
  useSettingsStore.setState({ snapshot: { values: { "dictation.enabled": String(on) }, path: "/Users/me/.code-foundry/settings.toml", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

/** Publishes a snapshot (and the matching setting) and waits for the store to have it. */
async function publish(s: ReturnType<typeof dictationSnap>): Promise<void> {
  await act(async () => {
    setEnabled(s.enabled);
    fakeDictation.publish(s);
    await vi.waitFor(() => {
      expect(useDictationStore.getState().snapshot).toBe(s);
    });
  });
}

async function mount(s: ReturnType<typeof dictationSnap>) {
  setEnabled(s.enabled);
  fakeDictation.publish(s);
  render(
    <>
      <SettingsSection schema={schema} pageId="general" section={{ section, fields: [field] }} />
      <ConfirmDialog />
    </>,
  );
  const sec = document.querySelector<HTMLElement>('[data-section="dictation"]');
  if (!sec) throw new Error("no section");
  // The section holds the Watch: the first snapshot arrives a tick later.
  await vi.waitFor(() => {
    expect(within(sec).getByTestId("dictation-model-row").getAttribute("data-state")).toBe(s.state);
  });
  const toggle = sec.querySelector<HTMLElement>('[data-setting="dictation.enabled"]');
  if (!toggle) throw new Error("no toggle row");
  return { sec, toggle, model: within(sec).getByTestId("dictation-model-row") };
}

function invoked(): string[] {
  return invokeCommand.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  invokeCommand.mockResolvedValue({ message: "", resultJson: "" });
});
afterEach(() => {
  cleanup();
  resetDictationForTests();
  fakeDictation.reset();
  vi.clearAllMocks();
});

describe("Settings › Dictation", () => {
  it("off without the model: Needs the model, Download starts it, and when it finishes the size, the switch on and Ready", async () => {
    const { sec, toggle, model } = await mount(dictationSnap({ enabled: false, state: "disabled", model: NO_MODEL }));
    expect(within(sec).getByRole("heading", { name: "Dictation" })).not.toBeNull();
    expect(sec.textContent).toContain("Speak into any composer. Transcribed on this Mac with Whisper; audio never leaves it.");
    expect(toggle.textContent).toContain("Adds a microphone button to every composer and the ⇧⌘M shortcut. Needs the model below.");
    expect(within(toggle).queryByTestId("dictation-chip")).toBeNull();
    expect(model.textContent).toContain("Whisper Large v3 Turbo, English. Downloaded once, kept in ~/.code-foundry/dictation.");
    expect(within(model).getByTestId("dictation-mac").textContent).toBe("This Mac: Apple M4 Pro · 48 GB");
    expect(within(model).queryByTestId("dictation-m1")).toBeNull();

    fireEvent.click(within(model).getByTestId("dictation-download-button"));
    expect(invoked()).toEqual(["dictation.download"]);
    await publish(dictationSnap({ enabled: false, state: "downloading", model: { ...NO_MODEL, download: { receivedBytes: 1_000_000, totalBytes: 874_188_075, bytesPerSecond: 0 } } }));
    expect(within(model).getByTestId("dictation-progress")).not.toBeNull();
    expect(model.textContent).toContain("Downloading. Dictation turns on when it finishes.");

    // The daemon turns the setting on when the download finishes.
    await publish(dictationSnap());
    expect(within(model).getByTestId("dictation-size").textContent).toBe("874 MB on disk");
    expect(within(toggle).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(toggle).getByTestId("dictation-chip").textContent).toBe("Ready");
    expect(toggle.textContent).not.toContain("Needs the model below.");
  });

  it("the switch without the model downloads instead of turning on", async () => {
    const { sec, toggle } = await mount(dictationSnap({ enabled: false, state: "disabled", model: NO_MODEL }));
    fireEvent.click(within(toggle).getByRole("switch"));
    expect(invoked()).toEqual(["dictation.download"]);
    expect(saveSettings).not.toHaveBeenCalled();
    await publish(dictationSnap({ enabled: false, state: "downloading", model: { ...NO_MODEL, download: { receivedBytes: 0, totalBytes: 874_188_075, bytesPerSecond: 0 } } }));
    expect(within(sec).getByTestId("dictation-download")).not.toBeNull();
    // While it downloads the switch does nothing more (dictation turns on by itself).
    fireEvent.click(within(toggle).getByRole("switch"));
    expect(invoked()).toEqual(["dictation.download"]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("a failed download says so once, a line per source", async () => {
    const message = "Download failed:\nGitHub: gh is not logged in (run gh auth login)\nhuggingface.co: the server answered 403 Forbidden";
    const { sec } = await mount(dictationSnap({ enabled: false, state: "disabled", model: NO_MODEL, error: message }));
    const errors = within(sec).getAllByTestId("dictation-download-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.textContent).toBe(message);
    // The lines show as lines.
    expect(errors[0]?.className).toContain("whitespace-pre-line");
  });

  it("downloading: progress, speed and Cancel", async () => {
    const { sec } = await mount(dictationSnap({ enabled: false, state: "downloading", model: { ...NO_MODEL, download: { receivedBytes: 557_000_000, totalBytes: 874_188_075, bytesPerSecond: 11_000_000 } } }));
    expect(within(sec).getByTestId("dictation-progress").textContent).toBe("557 MB of 874 MB · 11 MB/s");
    fireEvent.click(within(sec).getByTestId("dictation-cancel"));
    expect(invoked()).toEqual(["dictation.download.cancel"]);
    await publish(dictationSnap({ enabled: false, state: "disabled", model: NO_MODEL }));
    expect(within(sec).getByTestId("dictation-download-button").textContent).toBe("Download · 0.9 GB");
  });

  it("on an M1: the chip, the warning, unloaded, the engine's failure, Remove confirms", async () => {
    const { sec } = await mount(dictationSnap({ hardware: M1 }));
    const chip = () => within(sec).getByTestId("dictation-chip");
    expect(chip().textContent).toBe("Ready");
    expect(within(sec).getByTestId("dictation-mac").textContent).toBe("This Mac: Apple M1 Pro · 16 GB");
    expect(within(sec).getByTestId("dictation-m1").textContent).toBe(
      "On an M1 each phrase takes a few seconds to appear, and the model uses about 1.2 GB while loaded. Newer M-series chips are much quicker.",
    );
    await publish(dictationSnap({ hardware: M1, state: "unloaded" }));
    expect(chip().textContent).toBe("Unloaded · reloads when you return");
    await publish(dictationSnap({ hardware: M1, state: "error", error: "the engine exited 3 times in a row: signal: killed" }));
    expect(chip().textContent).toBe("the engine exited 3 times in a row: signal: killed");
    expect(chip().getAttribute("data-state")).toBe("error");
    // The engine's failure is the chip's, not the Model row's.
    expect(within(sec).queryByTestId("dictation-download-error")).toBeNull();

    await publish(dictationSnap());
    invokeCommand.mockRejectedValueOnce(new NeedsConfirm({ command: "dictation.remove", title: "Remove Dictation Model", message: REMOVE_CONFIRM }));
    fireEvent.click(within(sec).getByTestId("dictation-remove"));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Remove the dictation model?");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledTimes(2);
    });
    expect(invokeCommand).toHaveBeenLastCalledWith("dictation.remove", expect.anything(), {}, undefined, { confirmed: true });
    await publish(dictationSnap({ model: { downloaded: false } }));
    expect(within(sec).getByTestId("dictation-download-button")).not.toBeNull();
  });
});
