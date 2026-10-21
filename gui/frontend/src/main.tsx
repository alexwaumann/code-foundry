import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/error/ErrorBoundary";
import { AppError } from "./components/error/fallbacks";
import { loadBundledFont } from "./terminal/fonts";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// xterm measures cells when a terminal opens, so let the bundled font load first. Bounded
// by a timeout and never rejects; a late load is handled by the renderer re-measuring.
void loadBundledFont().then(() => {
  createRoot(root).render(
    <StrictMode>
      {/* Anything that escapes the inner boundaries (rows, panel tabs, bottom panel) shows
          the error and a Reload button instead of a blank window. */}
      <ErrorBoundary label="app" fallback={AppError}>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
