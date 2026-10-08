import { useEffect, useMemo, useState } from "react";
import { listCommands, type CommandView } from "@/api/command";
import { errorMessage } from "@/api/stream";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { viewActions } from "@/keys/bindings";
import { helpSections, type LocalChord } from "@/keys/help";
import { getUiContext } from "@/stores/context";
import { setHelpOpen, useViewsStore } from "@/stores/views";

/**
 * GUI chords that are not view actions but are worth knowing. This overlay (and the
 * palette) is the one place chords are listed; the rest of the UI uses buttons.
 */
const extraChords: LocalChord[] = [
  { chord: "f2", title: "Rename the selected session" },
  { chord: "escape", title: "Close the palette, dialog, or settings" },
  { chord: "arrowup", title: "Move in the sidebar and lists" },
  { chord: "arrowdown", title: "Move in the sidebar and lists" },
  { chord: "enter", title: "Open the highlighted row" },
  { chord: "arrowleft", title: "Fold or unfold a sidebar row" },
  { chord: "arrowright", title: "Fold or unfold a sidebar row" },
  { chord: "a", title: "Pull Requests: all or registered repositories" },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-[11px] text-foreground/80">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function HelpBody() {
  // Every command, available or not, with the keybindings CommandService reports
  // (settings overrides applied). Fetched once per opening.
  const [commands, setCommands] = useState<CommandView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listCommands(getUiContext(), { includeUnavailable: true }).then(
      (c) => {
        if (live) setCommands(c);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const sections = useMemo(() => helpSections(commands ?? [], [...viewActions, ...extraChords]), [commands]);

  return (
    <div className="grid max-h-[72vh] grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-6 overflow-y-auto p-5">
      <section className="space-y-3 text-sm text-muted-foreground" aria-label="How code-foundry works">
        <DialogTitle className="text-base text-foreground">How code-foundry works</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-3">
            <p>
              <span className="font-medium text-foreground">Sessions</span> are Claude Code running in a terminal the daemon owns. They keep
              running when the window closes. A closed session stays listed, disconnected, and Reconnect resumes its conversation.
            </p>
            <p>
              <span className="font-medium text-foreground">Worktrees</span> give each session its own checkout of a registered repository,
              so sessions never edit each other's files. The sidebar groups sessions under their worktree.
            </p>
            <p>
              <span className="font-medium text-foreground">The palette</span> (⌘K) lists every action available for what you are looking
              at. The same commands are keyboard shortcuts and <code className="font-mono text-xs">code-foundry</code> CLI verbs.
            </p>
            <p>
              Change shortcuts, defaults and appearance in <span className="font-medium text-foreground">Settings</span> (⌘,).
            </p>
          </div>
        </DialogDescription>
      </section>
      <section aria-label="Keyboard shortcuts" data-testid="help-shortcuts" className="space-y-4">
        <h3 className="text-base font-semibold">Keyboard shortcuts</h3>
        {error && <p className="text-xs text-destructive">Cannot list commands: {error}</p>}
        {sections.map((s) => (
          <div key={s.title} data-help-section={s.title}>
            <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{s.title}</h4>
            <ul className="space-y-0.5">
              {s.items.map((i) => (
                <li
                  key={`${i.command ?? ""}:${i.label}`}
                  className="flex items-center justify-between gap-3 text-sm"
                  data-help-command={i.command}
                  title={i.available ? i.command : `${i.command ?? ""} (not available here)`}
                >
                  <span className={i.available ? "truncate" : "truncate text-muted-foreground"}>{i.label}</span>
                  <Keys keys={i.keys} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

/** cmd+/ (view.help): keybindings and a short orientation. */
export function HelpOverlay() {
  const open = useViewsStore((s) => s.helpOpen);
  return (
    <Dialog open={open} onOpenChange={setHelpOpen}>
      <DialogContent className="top-[8vh] max-w-3xl" data-testid="help-overlay">
        {open && <HelpBody />}
      </DialogContent>
    </Dialog>
  );
}
