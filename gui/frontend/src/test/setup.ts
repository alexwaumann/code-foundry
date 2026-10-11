import { vi } from "vitest";

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
