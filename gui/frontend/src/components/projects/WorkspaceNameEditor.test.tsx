import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameWorkspace = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/workspaceActions", async (orig) => ({ ...(await orig<typeof import("@/stores/workspaceActions")>()), renameWorkspace }));

const { WorkspaceNameEditor } = await import("./WorkspaceNameEditor");
const { useWorkspacesStore } = await import("@/stores/workspaces");

/** The card's use: the editor while renaming, the stored name (from the store) passed in, a list to give the keyboard back to. */
function Card() {
  const name = useWorkspacesStore((s) => s.byId["w-1"]?.name ?? "");
  const [editing, setEditing] = useState(true);
  return (
    <div tabIndex={0} data-focus-root data-testid="list">
      {editing ? (
        <WorkspaceNameEditor
          workspaceId="w-1"
          name={name}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : (
        <span data-testid="name">{name}</span>
      )}
      <button type="button">elsewhere</button>
    </div>
  );
}

function setName(name: string) {
  act(() => {
    useWorkspacesStore.setState({
      byId: {
        "w-1": { id: "w-1", name, members: [], rootPath: "", defaultPrimary: "", managedDir: "", instructions: "", skills: [] } as never,
        "w-2": { id: "w-2", name: "mono", members: [], rootPath: "", defaultPrimary: "", managedDir: "", instructions: "", skills: [] } as never,
      },
      order: ["w-2", "w-1"],
      loaded: true,
    });
  });
}

const input = () => screen.getByTestId<HTMLInputElement>("workspace-name-input");

beforeEach(() => {
  renameWorkspace.mockClear();
  setName("shop");
});
afterEach(() => {
  cleanup();
});

describe("WorkspaceNameEditor", () => {
  it("Escape keeps the stored name and renames nothing, though the list takes focus (a blur)", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: "renamedByEscape" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(renameWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId("name").textContent).toBe("shop");
    expect(document.activeElement).toBe(screen.getByTestId("list"));
  });

  it("Enter renames once (the blur after it does nothing)", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: "store" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    expect(renameWorkspace).toHaveBeenCalledWith("w-1", "store");
    expect(document.activeElement).toBe(screen.getByTestId("list"));
  });

  it("leaving the field renames once", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: "store" } });
    fireEvent.blur(input());
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a refused name stays in the field on Enter; leaving drops it", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: "MONO" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("workspace-name-error").textContent).toBe("A workspace named “MONO” exists.");
    expect(input()).toBeTruthy();
    fireEvent.blur(input());
    expect(renameWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId("name").textContent).toBe("shop");
  });

  it("untouched, it follows a rename made elsewhere and Enter renames nothing (no revert)", () => {
    render(<Card />);
    setName("cli-name");
    expect(input().value).toBe("cli-name");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(renameWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId("name").textContent).toBe("cli-name");
  });

  it("typed, a rename elsewhere does not overwrite the field and Enter commits what was typed (last write wins)", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: "mine" } });
    setName("cli-name");
    expect(input().value).toBe("mine");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    expect(renameWorkspace).toHaveBeenCalledWith("w-1", "mine");
  });

  it("typed back to the stored name: nothing to rename", () => {
    render(<Card />);
    fireEvent.change(input(), { target: { value: " shop " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(renameWorkspace).not.toHaveBeenCalled();
  });
});
