import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { removeSpace } from "@/shell/spaceActions";
import { defaultRemoveTarget, threadsOfSpace, type RemoveChoice } from "@/shell/spaces";
import { useLayoutStore } from "@/stores/layout";
import { closeRemoveSpaceDialog, useRemoveSpaceDialogStore } from "@/stores/removeSpaceDialog";
import { useThreadsStore, type ThreadsData } from "@/stores/threads";

/** The user's own threads that are not archived (space.remove moves or archives these), joined for a narrow selector. */
function ownThreads(s: ThreadsData): string {
  return s.order.filter((id) => {
    const t = s.byId[id];
    return t !== undefined && !t.createdBy && t.archivedAtMs === null;
  }).join("\n");
}

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? "" : "s"}`;

/** The question's body: what closes, and what happens to the threads. */
function Body({ spaceId, onDone }: { spaceId: string; onDone: () => void }) {
  const order = useLayoutStore((s) => s.spaceOrder);
  const spaces = useLayoutStore((s) => s.spaces);
  const tabs = useLayoutStore((s) => Object.values(s.panes).reduce((n, p) => (p.spaceId === spaceId ? n + p.tabIds.length : n), 0));
  const own = useThreadsStore(ownThreads);
  const threads = useLayoutStore((s) => threadsOfSpace(own ? own.split("\n") : [], spaceId, s).length);
  const others = order.filter((id) => id !== spaceId);
  const [kind, setKind] = useState<RemoveChoice["kind"]>("move");
  const [to, setTo] = useState(() => defaultRemoveTarget(order, spaceId));
  const [busy, setBusy] = useState(false);
  const choice: RemoveChoice = kind === "archive" ? { kind } : { kind, to };
  const ready = !busy && (threads === 0 || kind === "archive" || others.includes(to));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        // With no thread in it, the threads have nowhere to go: the default target is passed and moves nothing.
        void removeSpace(spaceId, threads === 0 ? { kind: "move", to: to || (others[0] ?? "") } : choice).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <p className="text-body text-cf-text-muted" data-testid="remove-space-summary">
        {tabs > 0 ? `Its ${plural(tabs, "tab")} and panes close. ` : ""}
        {threads > 0 ? `It holds ${plural(threads, "thread")}.` : "It holds no threads."}
      </p>
      {threads > 0 && (
        <RadioGroup
          value={kind}
          onValueChange={(v) => {
            setKind(v === "archive" ? "archive" : "move");
          }}
          aria-label="What happens to its threads"
          className="gap-2.5"
          data-testid="remove-space-choice"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="move" id="remove-space-move" data-testid="remove-space-move" />
            <label htmlFor="remove-space-move" className="text-body whitespace-nowrap">
              Move them to
            </label>
            <Select
              value={to}
              onValueChange={(v) => {
                setTo(v);
                setKind("move");
              }}
            >
              <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="The space they move to" data-testid="remove-space-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((id) => (
                  <SelectItem key={id} value={id} data-testid="remove-space-target-item">
                    {spaces[id]?.name ?? id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="archive" id="remove-space-archive" data-testid="remove-space-archive" />
            <label htmlFor="remove-space-archive" className="text-body">
              Archive them all
            </label>
          </div>
        </RadioGroup>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={closeRemoveSpaceDialog}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="destructive" disabled={!ready} data-testid="remove-space-submit">
          Remove
        </Button>
      </div>
    </form>
  );
}

/**
 * Removing a space (docs/notes/shell-model.md, "Structure"): its tabs and panes are dropped and
 * its unlinked terminals end; its threads move to another space, picked here (they appear in that
 * sidebar, nothing opens), or are all archived. The last space cannot be removed, so the dialog is
 * never asked for it. One space.remove with --to or --archive.
 */
export function RemoveSpaceDialog() {
  const spaceId = useRemoveSpaceDialogStore((s) => s.spaceId);
  const seq = useRemoveSpaceDialogStore((s) => s.seq);
  const name = useLayoutStore((s) => s.spaces[spaceId]?.name ?? "");
  return (
    <Dialog
      open={spaceId !== ""}
      onOpenChange={(open) => {
        if (!open) closeRemoveSpaceDialog();
      }}
    >
      <DialogContent className="max-w-sm p-5" data-testid="remove-space-dialog" data-space-id={spaceId}>
        <DialogTitle className="truncate">Remove space “{name}”?</DialogTitle>
        <DialogDescription className="sr-only">Its tabs and panes close; its threads move to another space or are archived.</DialogDescription>
        {spaceId && <Body key={seq} spaceId={spaceId} onDone={closeRemoveSpaceDialog} />}
      </DialogContent>
    </Dialog>
  );
}
