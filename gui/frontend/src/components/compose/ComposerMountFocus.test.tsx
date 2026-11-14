// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeIn, seedComposer, settle } from "@/test/composerWorld";
import { SelectedComposer } from "@/test/SelectedComposer";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));

/**
 * The prompt takes the keyboard a frame after the composer mounts, unless a text field took it
 * within that frame: the top bar's "+" shows a new space (its composer) and opens the space's name
 * field, and whichever focused last used to win (e2e/shell-spaces.spec.ts).
 */

let frames: FrameRequestCallback[] = [];

/** Runs the frames queued so far. */
function frame(): void {
  const run = frames;
  frames = [];
  act(() => {
    for (const cb of run) cb(performance.now());
  });
}

const inPrompt = () => document.activeElement?.closest('[data-testid="composer-prompt"]') != null;

beforeEach(() => {
  seedComposer();
  composeIn("repo-cf");
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames[id - 1] = () => undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.querySelectorAll("[data-testid=other-field]").forEach((el) => {
    el.remove();
  });
});

describe("the prompt's focus on mount", () => {
  it("takes the keyboard a frame after the composer mounts", async () => {
    render(<SelectedComposer />);
    await settle();
    expect(inPrompt()).toBe(false);
    frame();
    expect(inPrompt()).toBe(true);
  });

  it("leaves it in a text field that took it within that frame", async () => {
    render(<SelectedComposer />);
    await settle();
    const field = document.createElement("input");
    field.dataset.testid = "other-field";
    document.body.append(field);
    field.focus();
    frame();
    expect(document.activeElement).toBe(field);
  });
});
