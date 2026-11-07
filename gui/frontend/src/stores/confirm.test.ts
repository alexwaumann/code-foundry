import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { answerConfirm, registerOwnDialog, requestChoice, requestConfirm, useConfirmStore, withdrawConfirm } from "./confirm";

const app = { title: "Remove", message: "Remove it?", confirmLabel: "Remove" };
const guarded = (message: string) => ({ title: "Change", message, confirmLabel: "Change", guarded: true });
const shown = () => useConfirmStore.getState().pending?.message;
const settled = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useConfirmStore.setState({ pending: null });
});

describe("a guarded request", () => {
  it("opens at once when nothing is open", () => {
    void requestConfirm(guarded("one"));
    expect(shown()).toBe("one");
    answerConfirm(false);
  });

  it("waits behind the app's dialog and does not answer it", async () => {
    const heard = vi.fn();
    void requestConfirm(app).then(heard);
    const asked = requestConfirm(guarded("one"));
    expect(shown()).toBe("Remove it?");
    await settled();
    expect(heard).not.toHaveBeenCalled();
    answerConfirm(true);
    await settled();
    expect(heard).toHaveBeenCalledWith(true);
    expect(shown()).toBe("one");
    answerConfirm(true);
    await expect(asked).resolves.toBe(true);
  });

  it("waits behind a three-way prompt too", async () => {
    const heard = vi.fn();
    void requestChoice({ ...app, alternateLabel: "Discard" }).then(heard);
    void requestConfirm(guarded("one"));
    expect(useConfirmStore.getState().pending?.alternateLabel).toBe("Discard");
    await settled();
    expect(heard).not.toHaveBeenCalled();
    answerConfirm(false);
    expect(shown()).toBe("one");
    answerConfirm(false);
  });

  it("opens in turn, oldest first", () => {
    void requestConfirm(guarded("one"));
    void requestConfirm(guarded("two"));
    expect(shown()).toBe("one");
    answerConfirm(false);
    expect(shown()).toBe("two");
    answerConfirm(false);
    expect(shown()).toBeUndefined();
  });

  it("gives way to the app's own request, which cancels it as ever", async () => {
    const asked = requestConfirm(guarded("one"));
    void requestConfirm(app);
    await expect(asked).resolves.toBe(false);
    expect(shown()).toBe("Remove it?");
    answerConfirm(false);
  });

  it("waits behind a dialog of the app's in its own store", async () => {
    const other = create<{ open: boolean }>()(() => ({ open: true }));
    const stop = registerOwnDialog(other, (s) => s.open);
    void requestConfirm(guarded("one"));
    expect(shown()).toBeUndefined();
    other.setState({ open: false });
    await settled();
    expect(shown()).toBe("one");
    answerConfirm(false);
    stop();
  });
});

describe("withdrawConfirm", () => {
  it("takes back the open question as a no", async () => {
    const req = guarded("one");
    const asked = requestConfirm(req);
    withdrawConfirm(req);
    await expect(asked).resolves.toBe(false);
    expect(shown()).toBeUndefined();
  });

  it("takes back a waiting one and leaves what is open alone", async () => {
    const heard = vi.fn();
    void requestConfirm(app).then(heard);
    const req = guarded("one");
    const asked = requestConfirm(req);
    withdrawConfirm(req);
    await expect(asked).resolves.toBe(false);
    expect(shown()).toBe("Remove it?");
    expect(heard).not.toHaveBeenCalled();
    answerConfirm(false);
    expect(shown()).toBeUndefined();
  });

  it("does nothing to a dialog that is not this request's", async () => {
    const heard = vi.fn();
    void requestConfirm(app).then(heard);
    withdrawConfirm(guarded("never asked"));
    await settled();
    expect(heard).not.toHaveBeenCalled();
    expect(shown()).toBe("Remove it?");
    answerConfirm(false);
  });
});
