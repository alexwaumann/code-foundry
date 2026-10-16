import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { listCommands, type CommandView } from "@/api/command";
import { errorMessage } from "@/api/stream";
import { Markdown } from "@/components/pr/Markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { viewActions } from "@/keys/bindings";
import { helpSections, type LocalChord } from "@/keys/help";
import { cn } from "@/lib/utils";
import { getUiContext } from "@/stores/context";
import { setHelpOpen, setHelpTab, useViewsStore, type HelpTab } from "@/stores/views";
import { guideMarkdown, guideToc } from "./guide";

/**
 * GUI chords that are not view actions but are worth knowing. This overlay (and the
 * palette) is the one place chords are listed; the rest of the UI uses buttons.
 */
const extraChords: LocalChord[] = [
  { chord: "f2", title: "Rename the selected thread" },
  { chord: "escape", title: "Close the palette, dialog, or settings" },
  { chord: "arrowup", title: "Move in the sidebar and lists" },
  { chord: "arrowdown", title: "Move in the sidebar and lists" },
  { chord: "enter", title: "Open the highlighted row" },
  { chord: "arrowleft", title: "Fold or unfold a sidebar row" },
  { chord: "arrowright", title: "Fold or unfold a sidebar row" },
  { chord: "a", title: "Pull Requests: all or registered repositories" },
  { chord: "cmd+enter", title: "Pull request rows: open on GitHub (Enter opens them in the side panel)" },
  { chord: "cmd+w", title: "Side panel: close the active tab (hides an empty panel)" },
  { chord: "escape", title: "Side panel, surface list after +: back to the tab" },
  { chord: "cmd+w", title: "Side panel, surface list after +: back to the tab" },
  { chord: "alt+arrowleft", title: "Side panel, focused tab: move it left or right" },
  { chord: "alt+arrowright", title: "Side panel, focused tab: move it left or right" },
  { chord: "cmd+shift+c", title: "Side panel, pull request: copy its link" },
  { chord: "cmd+w", title: "Bottom panel: close the active terminal (hides an empty panel)" },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

/** The Keyboard shortcuts tab: every command with its effective chords, then the GUI's own. */
function Shortcuts() {
  // Every command, available or not, with the keybindings CommandService reports
  // (settings overrides applied). Fetched each time the tab shows.
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
    <section aria-label="Keyboard shortcuts" data-testid="help-shortcuts" data-help-scroll tabIndex={-1} className="h-full columns-2 gap-8 overflow-y-auto px-5 py-4 outline-none">
      {error && <p className="mb-4 text-caption text-destructive">Cannot list commands: {error}</p>}
      {sections.map((s) => (
        <div key={s.title} data-help-section={s.title} className="mb-4 break-inside-avoid">
          <h4 className="mb-1 text-overline">{s.title}</h4>
          <ul className="space-y-0.5">
            {s.items.map((i) => (
              // The tooltip names the command (and why a dimmed one is dimmed).
              <Tip key={`${i.command ?? ""}:${i.label}`} label={i.command && (i.available ? i.command : `${i.command} (not available here)`)} align="start">
                <li className="flex items-center justify-between gap-3 text-body" data-help-command={i.command}>
                  <span className={i.available ? "truncate" : "truncate text-muted-foreground"}>{i.label}</span>
                  <Keys keys={i.keys} />
                </li>
              </Tip>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * The Guide tab: docs/GETTING-STARTED.md rendered with the markdown component and styles
 * threads use, and on the left its h2/h3 headings, each scrolling the guide to its section.
 */
export function Guide() {
  const body = useRef<HTMLDivElement>(null);
  const scrollTo = (index: number) => {
    // guideToc lists exactly the h2/h3 headings the renderer produces, in order.
    body.current?.querySelectorAll("h2, h3")[index]?.scrollIntoView({ block: "start" });
  };
  return (
    <div className="grid h-full grid-cols-[11rem_minmax(0,1fr)]">
      <nav aria-label="Contents" data-testid="help-toc" className="overflow-y-auto py-4 pr-2 pl-5">
        <ul>
          {guideToc.map((e, i) => (
            <li key={`${String(i)}:${e.title}`} className={e.level === 2 && i > 0 ? "mt-3" : undefined}>
              <button
                type="button"
                className={cn("w-full truncate rounded-sm py-0.5 text-left text-body-sm hover:text-foreground", e.level === 2 ? "font-medium text-foreground" : "text-muted-foreground")}
                data-toc-level={e.level}
                onClick={() => {
                  scrollTo(i);
                }}
              >
                {e.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div ref={body} data-testid="help-guide" data-help-scroll tabIndex={-1} className="overflow-y-auto py-4 pr-6 pl-2 outline-none [&_:is(h2,h3)]:scroll-mt-4">
        <Markdown>{guideMarkdown}</Markdown>
      </div>
    </div>
  );
}

/** Underlined tabs in the overlay's header (the shared TabsList is a segmented control). */
const tabClass =
  "h-auto flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-3 pb-2.5 text-label font-normal text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-transparent";

/** The overlay's body: the Guide and Keyboard shortcuts tabs, and a close button. */
function HelpBody() {
  const tab = useViewsStore((s) => s.helpTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        setHelpTab(v as HelpTab);
      }}
      className="gap-0"
    >
      <DialogTitle className="sr-only">Help</DialogTitle>
      <DialogDescription className="sr-only">The getting started guide and the keyboard shortcuts.</DialogDescription>
      <div className="flex items-center border-b px-5">
        <TabsList className="h-auto gap-5 rounded-none bg-transparent p-0" data-testid="help-tabs">
          <TabsTrigger value="guide" className={tabClass} data-testid="help-tab-guide">
            Guide
          </TabsTrigger>
          <TabsTrigger value="shortcuts" className={tabClass} data-testid="help-tab-shortcuts">
            Keyboard shortcuts
          </TabsTrigger>
        </TabsList>
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon-sm" className="-mr-2 ml-auto" aria-label="Close" data-testid="help-close">
            <X aria-hidden />
          </Button>
        </DialogClose>
      </div>
      <div className="h-[calc(72vh/var(--cf-zoom))]">
        <TabsContent value="guide" className="h-full">
          <Guide />
        </TabsContent>
        <TabsContent value="shortcuts" className="h-full">
          <Shortcuts />
        </TabsContent>
      </div>
    </Tabs>
  );
}

/**
 * cmd+/ (view.help) and the Help menu: the getting started guide (the default tab) and
 * the keyboard shortcuts.
 */
export function HelpOverlay() {
  const open = useViewsStore((s) => s.helpOpen);
  return (
    <Dialog open={open} onOpenChange={setHelpOpen}>
      <DialogContent
        className="top-[calc(8vh/var(--cf-zoom))] max-w-3xl"
        data-testid="help-overlay"
        onOpenAutoFocus={(e) => {
          // Focus the open tab's scrolling body rather than the first tab (which would
          // draw its focus ring): the arrow keys and space then scroll the guide.
          const scroll = e.currentTarget instanceof HTMLElement ? e.currentTarget.querySelector<HTMLElement>("[data-help-scroll]") : null;
          if (!scroll) return;
          e.preventDefault();
          scroll.focus();
        }}
      >
        {open && <HelpBody />}
      </DialogContent>
    </Dialog>
  );
}
