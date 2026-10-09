import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft } from "lucide-react";
import type { CommandView, UiContextView } from "@/api/command";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ProjectPicker } from "@/components/compose/ProjectPicker";
import { isStartable, presentCommand, presentInPalette } from "@/keys/bindings";
import { formatChord } from "@/keys/chord";
import { argChoices, groupByCategory, previousArg, promptedArgs, startPrompt, submitArg, UNSET_CHOICE, type ArgPrompt } from "@/palette/args";
import { refreshCommands, runCommand, useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { useUiStore } from "@/stores/ui";

function CommandRow({ c, onPick }: { c: CommandView; onPick: (c: CommandView) => void }) {
  return (
    <CommandItem
      value={c.name}
      keywords={[c.title, c.category]}
      onSelect={() => {
        onPick(c);
      }}
      data-command={c.name}
    >
      <span className="truncate">{c.title}</span>
      {promptedArgs(c).length > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-label="asks for input" />}
      <span className="truncate text-xs text-muted-foreground">{c.name}</span>
      {c.keybindings[0] && <CommandShortcut>{formatChord(c.keybindings[0])}</CommandShortcut>}
    </CommandItem>
  );
}

/** Item to highlight when an arg prompt starts: the default choice, else the first, else submit. */
function initialSelection(p: ArgPrompt): string {
  const spec = p.specs[p.index];
  const choices = spec ? argChoices(spec) : null;
  if (!spec || !choices) return "__submit";
  return choices.includes(spec.defaultValue) ? spec.defaultValue : (choices[0] ?? "");
}

interface BodyProps {
  initialQuery: string;
  initialCommand: string | null;
  close: () => void;
}

/** Palette contents for one opening. Remounted on every open (fresh state). */
function PaletteBody({ initialQuery, initialCommand, close }: BodyProps) {
  // Snapshot the context when the palette opens: that's what the user was looking at.
  const [context] = useState<UiContextView>(getUiContext);
  const commands = useCommandsStore((s) => s.commands);
  const loading = useCommandsStore((s) => s.loading);
  const error = useCommandsStore((s) => s.error);
  const [query, setQuery] = useState(initialQuery);
  const [prompt, setPrompt] = useState<ArgPrompt | null>(null);
  const [argError, setArgError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState(initialCommand);
  const [autoRun, setAutoRun] = useState<CommandView | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The list is fresh once a List for this palette's context has completed.
  const fresh = useCommandsStore((s) => !s.loading && s.contextKey === contextKey(context));
  // Enter pressed before the list was fresh: run the highlighted command once it is.
  const pendingEnter = useRef(false);

  useEffect(() => {
    void refreshCommands(context);
  }, [context]);

  const available = useMemo(() => commands.filter(isStartable), [commands]);
  const groups = useMemo(() => groupByCategory(available), [available]);

  const invoke = (c: CommandView, values: Record<string, string>) => {
    close();
    void runCommand(c.name, values, context);
  };

  const enterPrompt = (p: ArgPrompt) => {
    setPrompt(p);
    setQuery("");
    setArgError(null);
  };

  const pick = (c: CommandView) => {
    // session.new: the project picker replaces the model/effort prompts.
    if (presentInPalette(c.name)) {
      close();
      return;
    }
    const p = startPrompt(c);
    if (p.specs.length === 0) {
      // Commands with their own UI (e.g. the update dialog) present themselves.
      if (presentCommand(c.name)) {
        close();
        return;
      }
      invoke(c, {});
      return;
    }
    enterPrompt(p);
  };

  // A keybinding (or the sidebar "+") can open the palette straight into a command's arg
  // prompts. Adjusts state during render once it's listed.
  if (pendingCommand) {
    const c = available.find((x) => x.name === pendingCommand);
    if (c) {
      setPendingCommand(null);
      const p = startPrompt(c);
      if (p.specs.length > 0) enterPrompt(p);
      else setAutoRun(c);
    }
  }

  // A pre-selected command with nothing to ask runs straight away (outside render).
  useEffect(() => {
    if (autoRun) invoke(autoRun, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  useEffect(() => {
    if (!pendingEnter.current || !fresh || prompt) return;
    // cmdk highlights the best match in a layout effect after the list changes and does
    // not report automatic highlights through onValueChange, so read it from the DOM.
    const raf = requestAnimationFrame(() => {
      const name = rootRef.current?.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-value");
      const c = available.find((x) => x.name === name);
      if (!c) return;
      pendingEnter.current = false;
      pick(c);
    });
    return () => {
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, available, prompt]);

  const submit = (raw: string) => {
    if (!prompt) return;
    const step = submitArg(prompt, raw);
    if (step.kind === "error") {
      setArgError(step.error);
      return;
    }
    if (step.kind === "done") invoke(prompt.command, step.values);
    else enterPrompt(step.prompt);
  };

  const back = () => {
    if (!prompt) return;
    const prev = previousArg(prompt);
    if (prev) enterPrompt(prev);
    else {
      setPrompt(null);
      setQuery("");
      setArgError(null);
    }
  };

  const spec = prompt?.specs[prompt.index];
  const choices = spec ? argChoices(spec) : null;

  return (
    <Command
      // Remount per step so cmdk's highlight starts on a valid item (the default choice).
      key={prompt ? `${prompt.command.name}:${String(prompt.index)}` : "commands"}
      defaultValue={prompt ? initialSelection(prompt) : undefined}
      loop
      shouldFilter={!prompt || choices !== null}
      ref={rootRef}
      onKeyDown={(e) => {
        if (!prompt && e.key === "Enter" && !fresh) {
          e.preventDefault();
          pendingEnter.current = true;
          return;
        }
        if (prompt && e.key === "Backspace" && query === "") {
          e.preventDefault();
          back();
        }
      }}
      data-testid="palette"
      data-mode={prompt ? "args" : "commands"}
    >
      <CommandInput
        autoFocus
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          setArgError(null);
        }}
        placeholder={spec ? spec.description || `${spec.name}${spec.type === "path" ? " (path)" : ""}` : "Type a command…"}
        leading={
          prompt && spec ? (
            <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
              <span className="rounded bg-accent px-1.5 py-0.5 text-accent-foreground">{prompt.command.title}</span>
              <ChevronRight className="size-3 text-muted-foreground" />
              <span className="font-mono text-muted-foreground">{spec.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {prompt.index + 1}/{prompt.specs.length}
              </span>
            </span>
          ) : undefined
        }
      />
      <CommandList>
        {!prompt && (
          <>
            <CommandEmpty>{loading && available.length === 0 ? "Loading commands…" : error ? `Cannot list commands: ${error}` : "No matching commands."}</CommandEmpty>
            {groups.map(([category, list]) => (
              <CommandGroup key={category} heading={category}>
                {list.map((c) => (
                  <CommandRow key={c.name} c={c} onPick={pick} />
                ))}
              </CommandGroup>
            ))}
          </>
        )}
        {prompt && spec && choices && (
          <>
            <CommandEmpty>No matching values.</CommandEmpty>
            <CommandGroup heading={spec.description || spec.name}>
              {choices.map((v) => (
                <CommandItem
                  key={v}
                  value={v}
                  keywords={v === UNSET_CHOICE ? ["default"] : undefined}
                  onSelect={() => {
                    submit(v);
                  }}
                >
                  {spec.type === "bool" ? (v === "true" ? "Yes" : "No") : v === UNSET_CHOICE ? <span className="text-muted-foreground">Default (not set)</span> : v}
                  {v === spec.defaultValue && <span className="text-xs text-muted-foreground">default</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {prompt && spec && !choices && (
          <CommandGroup heading={spec.description || spec.name}>
            <CommandItem
              value="__submit"
              onSelect={() => {
                submit(query);
              }}
            >
              <CornerDownLeft />
              {query ? (
                <span className="truncate">
                  Use <span className="font-mono">{query}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">{spec.defaultValue ? `Use default (${spec.defaultValue})` : `Enter ${spec.name}`}</span>
              )}
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      {(argError ?? prompt) && (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs">
          <span className={argError ? "text-destructive" : "text-muted-foreground"} role={argError ? "alert" : undefined}>
            {argError ?? "⌫ on empty input goes back · Esc cancels"}
          </span>
        </div>
      )}
    </Command>
  );
}

export function CommandPalette() {
  const open = useUiStore((s) => s.palette.open);
  const query = useUiStore((s) => s.palette.query);
  const commandName = useUiStore((s) => s.palette.commandName);
  const page = useUiStore((s) => s.palette.page);
  const close = useUiStore((s) => s.closePalette);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent
        className="max-w-xl overflow-hidden p-0"
        data-region="palette"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{page === "projects" ? "New thread" : "Command palette"}</DialogTitle>
        <DialogDescription className="sr-only">{page === "projects" ? "Pick the project for a new thread" : "Run a command in the current context"}</DialogDescription>
        {page === "projects" ? (
          <ProjectPicker close={close} />
        ) : (
          <PaletteBody key={`${query}\u0000${commandName ?? ""}`} initialQuery={query} initialCommand={commandName} close={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}
