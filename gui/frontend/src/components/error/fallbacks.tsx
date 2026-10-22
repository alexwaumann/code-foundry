import { ChevronRight, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { FallbackProps } from "./ErrorBoundary";

/** The error's message, and its raw data when there is some, behind a "Details" disclosure. */
export function ErrorDetails({ error, raw }: { error: Error; raw?: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-0.5 text-caption text-cf-text-muted hover:text-cf-text" data-testid="error-details-toggle">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="select-text mt-1 max-h-64 overflow-auto rounded-md bg-cf-surface-sunken px-2 py-1.5 text-code break-words whitespace-pre-wrap" data-testid="error-details">
          {error.message}
          {raw ? `\n\n${raw}` : ""}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A panel tab body's or the bottom panel's fallback: what broke, and Try again. */
export function PaneError({ error, reset }: FallbackProps) {
  return (
    <div className="flex flex-col gap-2 p-4 text-body-sm" role="alert" data-testid="pane-error">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-cf-error" aria-hidden />
        <span className="font-medium">This part of the window could not render.</span>
        <Button variant="outline" size="xs" className="ml-auto" onClick={reset}>
          <RotateCw aria-hidden />
          Try again
        </Button>
      </div>
      <ErrorDetails error={error} />
    </div>
  );
}

/** The app root's fallback: the error, and Reload (a fresh start from the daemon's state). */
export function AppError({ error }: FallbackProps) {
  return (
    <div className="flex h-full items-center justify-center bg-cf-canvas p-8 text-cf-text" role="alert" data-testid="app-error">
      <div className="flex max-w-xl flex-col gap-3">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-5 shrink-0 text-cf-error" aria-hidden />
          <h1 className="text-heading">Code Foundry hit an error</h1>
        </div>
        <p className="text-body text-cf-text-muted">Your threads keep running in the daemon. Reload the window to pick up where you were.</p>
        <pre className="select-text max-h-64 overflow-auto rounded-md bg-cf-surface-sunken px-3 py-2 text-code break-words whitespace-pre-wrap">{error.stack ?? error.message}</pre>
        <div>
          <Button
            onClick={() => {
              window.location.reload();
            }}
          >
            <RotateCw aria-hidden />
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
