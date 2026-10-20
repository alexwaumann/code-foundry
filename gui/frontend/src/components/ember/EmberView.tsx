import type { ReactNode } from "react";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { ThreadPane } from "@/components/thread/ThreadPane";
import { Button } from "@/components/ui/button";
import { DragBand } from "@/components/window/DragBand";
import { useEmberEnabled, useEmberThreadId } from "@/stores/ember";
import { openEmberSettings } from "@/stores/emberPanel";
import { Flame } from "./Flame";

/** A centred flame and a line, alone in the pane. */
function EmberNote({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-10 outline-none" tabIndex={-1} data-focus-root data-region="content" aria-label="Ember" data-testid={testId}>
        {children}
      </section>
      <DragBand />
    </div>
  );
}

/**
 * The Ember view (selection view "ember"): Ember's chat by role. Its thread's chat once it
 * has one; "Ember is waking up…" while Ember is on and the daemon is still making it; a
 * pointer to the setting while Ember is off.
 */
export function EmberView() {
  const enabled = useEmberEnabled();
  const id = useEmberThreadId();
  if (enabled && id) return <ThreadPane threadId={id} />;
  if (enabled)
    return (
      <EmberNote testId="ember-waking">
        <Flame state="thinking" size="hero" />
        <p className="text-body text-muted-foreground">Ember is waking up…</p>
      </EmberNote>
    );
  return (
    <EmberNote testId="ember-off">
      <Flame state="idle" size="hero" />
      <p className="text-body text-muted-foreground">Ember is off.</p>
      <Button type="button" variant="outline" size="sm" onClick={openEmberSettings}>
        Open Ember settings
      </Button>
    </EmberNote>
  );
}
