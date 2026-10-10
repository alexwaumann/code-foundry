import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Folder, FolderGit2, FolderOpen } from "lucide-react";
import { pickDirectory } from "@/api/app";
import type { CommandView, UiContextView } from "@/api/command";
import { listDirectories } from "@/api/filesystem";
import { errorMessage } from "@/api/stream";
import { descendInto, entryPath, tabCompletion } from "@/palette/paths";
import { usePathListing, useAppHost } from "./usePathListing";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ProjectPicker } from "@/components/compose/ProjectPicker";
import { RunInPicker } from "./RunInPicker";
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
  const isPath = spec?.type === "path";
  const paths = usePathListing(query, isPath);
  const host = useAppHost();

  const changeQuery = (v: string) => {
    setQuery(v);
    setArgError(null);
  };

  /** Name of the highlighted folder suggestion (cmdk keeps the highlight in the DOM). */
  const highlightedEntry = (): string | null =>
    rootRef.current?.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-entry-name") ?? null;

  // Tab: descend into the highlighted folder, else extend to the common completion
  // (asking right away when the debounced listing is not for this input yet).
  const completePath = async () => {
    const q = query;
    const name = highlightedEntry();
    let completion = paths?.prefix === q ? (paths.listing?.completion ?? null) : null;
    if (name === null && completion === null) {
      try {
        completion = (await listDirectories(q)).completion;
      } catch {
        return;
      }
    }
    const next = tabCompletion(q, completion, name);
    if (next === null) return;
    setQuery((cur) => (cur === q ? next : cur));
    setArgError(null);
  };

  const chooseFolder = async () => {
    try {
      const picked = await pickDirectory(query);
      if (picked) changeQuery(picked);
    } catch (err) {
      setArgError(errorMessage(err));
    }
    rootRef.current?.querySelector("input")?.focus();
  };

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
          return;
        }
        if (isPath && e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          void completePath();
          return;
        }
        if (isPath && e.key === "/") {
          const name = highlightedEntry();
          if (name !== null) {
            e.preventDefault();
            changeQuery(descendInto(query, name));
          }
        }
      }}
      data-testid="palette"
      data-mode={prompt ? "args" : "commands"}
    >
      <CommandInput
        autoFocus
        value={query}
        onValueChange={changeQuery}
        trailing={
          isPath && host ? (
            <button
              type="button"
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="Choose folder…"
              aria-label="Choose folder"
              data-testid="pick-directory"
              onClick={() => {
                void chooseFolder();
              }}
            >
              <FolderOpen className="size-4" />
            </button>
          ) : undefined
        }
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
        {isPath && paths?.message && (
          <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="path-message">
            {paths.message}
          </div>
        )}
        {isPath && paths?.listing && paths.listing.entries.length > 0 && (
          <CommandGroup heading={paths.listing.truncated ? `Folders (first ${String(paths.listing.entries.length)})` : "Folders"}>
            {paths.listing.entries.map((e) => (
              <CommandItem
                key={e.path}
                value={`dir:${e.path}`}
                data-entry-name={e.name}
                data-testid="path-entry"
                data-git={e.isGit ? "true" : undefined}
                data-registered={e.registered ? "true" : undefined}
                onSelect={() => {
                  submit(entryPath(query, e.name));
                }}
              >
                {e.isGit ? <FolderGit2 className="text-orange-600 dark:text-orange-400" aria-label="git repository" /> : <Folder />}
                <span className="truncate font-mono">{e.name}</span>
                {e.registered && <span className="ml-auto shrink-0 text-xs text-muted-foreground">already added</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      {(argError ?? prompt) && (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs">
          <span className={argError ? "text-destructive" : "text-muted-foreground"} role={argError ? "alert" : undefined}>
            {argError ?? (isPath ? "Tab completes · / opens the highlighted folder · ⌫ on empty input goes back · Esc cancels" : "⌫ on empty input goes back · Esc cancels")}
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
  const runInSession = useUiStore((s) => s.palette.sessionId ?? "");
  const close = useUiStore((s) => s.closePalette);
  const title = page === "projects" ? "New thread" : page === "runin" ? "Run thread in" : "Command palette";
  const description =
    page === "projects" ? "Pick the project for a new thread" : page === "runin" ? "Pick the workspace member the thread moves to" : "Run a command in the current context";
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
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {page === "projects" ? (
          <ProjectPicker close={close} />
        ) : page === "runin" ? (
          <RunInPicker sessionId={runInSession} close={close} />
        ) : (
          <PaletteBody key={`${query}\u0000${commandName ?? ""}`} initialQuery={query} initialCommand={commandName} close={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}
