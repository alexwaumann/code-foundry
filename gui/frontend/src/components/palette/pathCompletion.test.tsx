// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DirectoryEntryView } from "@/api/filesystem";
import { Command, CommandList } from "@/components/ui/command";
import { PathSuggestions } from "./pathCompletion";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(cleanup);

const dir = (name: string, o: Partial<DirectoryEntryView> = {}): DirectoryEntryView => ({ path: `/Users/dev/${name}`, name, isGit: false, registered: false, ...o });

function show(entries: DirectoryEntryView[], truncated: boolean) {
  render(
    <Command>
      <CommandList>
        <PathSuggestions paths={{ prefix: "~/", listing: { entries, completion: "", truncated }, message: null }} onPick={() => undefined} />
      </CommandList>
    </Command>,
  );
}

// What a listing holds (the 200 cap, the common completion, dot-directories) is the daemon's:
// internal/fsx/list_test.go. The Add Project dialog's keys are AddProjectDialog.test.tsx's.
describe("PathSuggestions", () => {
  it("a bounded listing says so in its heading", () => {
    show(Array.from({ length: 200 }, (_, i) => dir(`d${String(i).padStart(3, "0")}`)), true);
    expect(screen.getByText("Folders (first 200)")).toBeTruthy();
    expect(screen.getAllByTestId("path-entry")).toHaveLength(200);
  });

  it("a whole listing is just Folders; a repository and a project already added are marked", () => {
    show([dir("dotfiles", { isGit: true, registered: true }), dir("new-app", { isGit: true }), dir("Notebook")], false);
    expect(screen.getByText("Folders")).toBeTruthy();
    const row = (name: string) => screen.getAllByTestId("path-entry").find((e) => e.dataset.entryName === name);
    expect(row("dotfiles")?.dataset).toMatchObject({ git: "true", registered: "true" });
    expect(row("dotfiles")?.textContent).toContain("already added");
    expect(row("new-app")?.dataset.git).toBe("true");
    expect(row("new-app")?.textContent).not.toContain("already added");
    expect(row("Notebook")?.dataset.git).toBeUndefined();
  });
});
