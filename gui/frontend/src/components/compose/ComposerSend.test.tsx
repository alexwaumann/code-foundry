// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDraft, updateDraft } from "@/stores/compose";
import { daemon, lastInvocation, refuse } from "@/test/daemonFakes";
import { CF, updateProject } from "@/test/projectsWorld";
import { composeIn, openPicker, optionTexts, pickOption, promptValue, SelectedComposer, seedComposer, send, settle } from "@/test/composerWorld";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));

afterEach(() => {
  cleanup();
});

/** The draft text, set the way typing leaves it. */
function type(key: string, text: string) {
  act(() => {
    updateDraft(key, { text });
  });
}

describe("a project's composer (compose.spec.ts)", () => {
  beforeEach(() => {
    seedComposer({ "threads.default_worktree": "new" });
  });

  it("the defaults: settings model and effort, Auto, a fresh copy from the default branch; send starts thread.new with them", async () => {
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build in code-foundry?");
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).toBe("Ask anything. @ files and threads, / skills and commands");
    expect(screen.getByTestId("composer-model").textContent).toBe("Sonnet 5");
    expect(screen.getByTestId("composer-effort").textContent).toBe("Medium");
    expect(screen.getByTestId("composer-permission").textContent).toBe("Auto");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Fresh copy");
    expect(screen.getByTestId("composer-worktree").getAttribute("aria-label")).toBe("Work in: Fresh copy");
    expect(screen.getByTestId("composer-base").textContent).toBe("From default");
    expect(screen.getByTestId("composer-base").getAttribute("aria-label")).toBe("Branch from: From default");

    type("repo-cf", "Add a dark mode toggle\nin settings");
    await send();
    expect(lastInvocation("thread.new")?.args).toEqual({
      project: "repo-cf",
      "new-worktree": "true",
      model: "claude-sonnet-5[1m]",
      effort: "medium",
      permission: "auto",
      prompt: "Add a dark mode toggle\nin settings",
    });
    // The draft was cleared.
    expect(getDraft("repo-cf").text).toBe("");
  });

  it("the polish: the name in semibold, the Claude mark in its orange, a neutral send until there is text, the folder's detail (composer-polish.spec.ts)", async () => {
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-input").getAttribute("aria-placeholder")).toBe("Ask anything. @ files and threads, / skills and commands");
    expect(screen.getByTestId("composer-project-name").className).toContain("font-semibold");
    expect(screen.getByTestId("composer-model").querySelector("svg")?.getAttribute("style")).toContain("color: rgb(217, 119, 87)");
    const sendButton = screen.getByTestId("composer-send");
    expect(sendButton).toHaveProperty("disabled", true);
    // The disabled look is a neutral grey (SEND_DISABLED), not the faded accent.
    expect(sendButton.className).toContain("disabled:bg-cf-surface-sunken");
    type("repo-cf", "Hello");
    expect(sendButton).toHaveProperty("disabled", false);
    const list = await openPicker("composer-worktree");
    expect(optionTexts(list).find((o) => o.startsWith("Project folder"))).toBe("Project folderEdits land in the project's checkout directly. One thread at a time is safest.");
  });

  it("while starting: Creating worktree… and the prompt disabled", async () => {
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    act(() => {
      updateDraft("repo-cf", { text: "x", phase: "starting" });
    });
    expect(screen.getByTestId("composer-send").textContent).toBe("Creating worktree…");
    expect(screen.getByTestId("composer-input").getAttribute("contenteditable")).toBe("false");
  });
});

/** The real editor (tiptap keeps itself on its DOM node): an edit through it runs the composer's onChange. */
function editor(): { commands: { insertContent(s: string): boolean; setContent(s: string): boolean } } {
  return (screen.getByTestId("composer-input") as unknown as { editor: ReturnType<typeof editor> }).editor;
}

describe("a failed start and the Work in picker (compose.spec.ts)", () => {
  beforeEach(() => {
    seedComposer({ "threads.default_worktree": "new" });
  });

  it("the refusal shows, the draft stays editable; Project folder drops the base; editing clears the error; the send works in the folder", async () => {
    daemon.handlers.set("thread.new", (inv) => {
      if (inv.args.prompt?.includes("FAIL")) throw refuse("create worktree: git fetch origin main: exit status 128");
      return { message: "", resultJson: JSON.stringify({ id: "s-new-1" }) };
    });
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    type("repo-cf", "Please FAIL here");
    await send();
    expect(screen.getByTestId("composer-error").textContent).toBe("create worktree: git fetch origin main: exit status 128");
    expect(promptValue()).toBe("Please FAIL here");
    expect(screen.getByTestId("composer-input").getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("composer")).not.toBeNull();

    // The two choices, then the project's branches (newest first, the default left out) under a search box.
    const list = await openPicker("composer-worktree");
    expect(optionTexts(list)).toEqual([
      "Fresh copyEdits land in a new branch with its own worktree. Multiple threads at a time is safe.",
      "Project folderEdits land in the project's checkout directly. One thread at a time is safest.",
      "feat/sidebar",
      "fix/resize",
      "release/v0.3",
    ]);
    expect(Array.from(list.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent)).toEqual(["Work in"]);
    expect(within(list).getByPlaceholderText("Find existing branch")).not.toBeNull();
    await pickOption(list, "Project folder");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    expect(screen.queryByTestId("composer-base")).toBeNull();

    act(() => {
      editor().commands.setContent("Please work");
    });
    expect(screen.queryByTestId("composer-error")).toBeNull();
    await send();
    expect(lastInvocation("thread.new")?.args).toEqual({ project: "repo-cf", worktree: CF, model: "claude-sonnet-5[1m]", effort: "medium", permission: "auto", prompt: "Please work" });
    // The new thread replaces the composer.
    expect(screen.getByTestId("selected-thread").textContent).toBe("s-new-1");
  });

  it("the current checkout's branch: read-only, not focusable, live; an existing branch has none; a fresh copy brings the base back", async () => {
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-base")).not.toBeNull();
    expect(screen.queryByTestId("composer-checkout-branch")).toBeNull();

    await pickOption(await openPicker("composer-worktree"), "Project folder");
    expect(screen.queryByTestId("composer-base")).toBeNull();
    const indicator = () => screen.getByTestId("composer-checkout-branch");
    expect(indicator().textContent).toBe("On main");
    expect(indicator().getAttribute("role")).toBe("note");
    expect(indicator().getAttribute("aria-label")).toBe("Current checkout is on main");
    expect(indicator().hasAttribute("tabindex")).toBe(false);
    expect(indicator().hasAttribute("data-compose-stop")).toBe(false);

    // Follows the project store: a checkout elsewhere, then a detached HEAD.
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === CF ? { ...w, branch: "release/v0.3" } : w)) }));
    expect(indicator().textContent).toBe("On release/v0.3");
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === CF ? { ...w, branch: "", detached: true, head: "3c3c4651aa" } : w)) }));
    expect(indicator().textContent).toBe("Detached at 3c3c465");
    expect(indicator().getAttribute("aria-label")).toBe("Current checkout is detached at 3c3c465");

    // An existing branch: the pill is its name, no indicator and no base.
    await pickOption(await openPicker("composer-worktree"), "feat/sidebar");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("feat/sidebar");
    expect(screen.getByTestId("composer-worktree").getAttribute("aria-label")).toBe("Work in: feat/sidebar");
    expect(screen.queryByTestId("composer-checkout-branch")).toBeNull();
    expect(screen.queryByTestId("composer-base")).toBeNull();

    await pickOption(await openPicker("composer-worktree"), "Fresh copy");
    expect(screen.queryByTestId("composer-checkout-branch")).toBeNull();
    expect(screen.getByTestId("composer-base").textContent).toBe("From default");
  });
});

describe("Work in by default (compose.spec.ts)", () => {
  beforeEach(() => {
    // threads.default_worktree unset: the project folder itself.
    seedComposer();
  });

  it("a thread starts in place; a pick applies to its draft only, and is sent without a base", async () => {
    composeIn("repo-cf");
    const { unmount } = render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    expect(screen.queryByTestId("composer-base")).toBeNull();
    expect(screen.getByTestId("composer-checkout-branch").textContent).toBe("On main");

    await pickOption(await openPicker("composer-worktree"), "Fresh copy");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Fresh copy");
    expect(screen.getByTestId("composer-base").textContent).toBe("From default");
    type("repo-cf", "Tidy the README");
    await send();
    const args = lastInvocation("thread.new")?.args;
    expect(args).toMatchObject({ project: "repo-cf", "new-worktree": "true" });
    expect(args).not.toHaveProperty("base");

    // The next code-foundry draft starts from the setting again.
    unmount();
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    expect(screen.queryByTestId("composer-base")).toBeNull();
  });
});

describe("a local-only repository (compose.spec.ts)", () => {
  beforeEach(() => {
    seedComposer({ "threads.default_worktree": "new" });
  });

  it("Branch from lists its local branches under the rule; the pick is sent as the base", async () => {
    composeIn("repo-sk");
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build in sketches?");
    expect(screen.getByTestId("composer-base").textContent).toBe("From default");
    const list = await openPicker("composer-base");
    expect(Array.from(list.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent)).toEqual(["Branch from"]);
    expect(optionTexts(list)).toEqual(["Default branch", "experiment/shaders"]);
    expect(list.querySelector('[data-slot="picker-footer"]')?.textContent).toBe("The project takes origin's copy of the branch, or its own when that is ahead.");
    await pickOption(list, "experiment/shaders");
    expect(screen.getByTestId("composer-base").textContent).toBe("From experiment/shaders");
    type("repo-sk", "Try a new shader");
    await send();
    expect(lastInvocation("thread.new")?.args).toMatchObject({ project: "repo-sk", "new-worktree": "true", base: "experiment/shaders" });
  });
});

describe("thread tags (composer-threads.spec.ts)", () => {
  it("the send projects a thread tag for the daemon and keeps the tag as the composer prompt", async () => {
    seedComposer();
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    type("repo-cf", "[Fix resize race](cf-thread://s-3) hit the same bug");
    await send();
    const args = lastInvocation("thread.new")?.args;
    expect(args?.prompt).toBe('[Thread "Fix resize race" (id s-3)] hit the same bug');
    expect(args?.["composer-prompt"]).toBe("[Fix resize race](cf-thread://s-3) hit the same bug");
  });
});
