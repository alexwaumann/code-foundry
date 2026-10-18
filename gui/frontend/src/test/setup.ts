import { afterEach, vi } from "vitest";
import { resetStreamSlots } from "@/api/streamSlots";

// Unit tests never load the real Wails runtime. Importing it has side effects: dist/drag.js
// starts a 50ms poll that touches `window`, and index.js fetches /wails/custom.js. Those can
// fire after vitest tears down a file's jsdom environment, which surfaced as a flaky
// "ReferenceError: window is not defined" after all tests passed. There is no Wails host
// under test, so every host call rejects, as it does in a plain browser.
const noHost = () => Promise.reject(new Error("no Wails host in unit tests"));

vi.mock("@wailsio/runtime", () => ({
  Call: { ByID: noHost, ByName: noHost },
  Browser: { OpenURL: noHost },
  Window: { SetTitle: noHost },
  Events: { On: () => () => undefined },
}));

// The app has one TooltipProvider at its root (App.tsx) and Radix tooltips throw outside
// one, so every component render in a unit test gets one too, unless the test passes its
// own wrapper.
vi.mock("@testing-library/react", async (importOriginal) => {
  const rtl = await importOriginal<typeof import("@testing-library/react")>();
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const render = ((ui: Parameters<typeof rtl.render>[0], options?: Parameters<typeof rtl.render>[1]) => rtl.render(ui, { wrapper: TooltipProvider, ...options })) as typeof rtl.render;
  return { ...rtl, render };
});

// Radix form controls inside a <form> (Switch, Checkbox, Select) measure their trigger
// with ResizeObserver for the hidden native input they render; jsdom has none.
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
}

// Stream slots (api/streamSlots.ts) are module state: a runner a test left running must
// not hold a slot in the next test.
afterEach(() => {
  resetStreamSlots();
});
