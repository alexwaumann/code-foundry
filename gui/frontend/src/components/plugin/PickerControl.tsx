import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, Loader2, SearchIcon, X } from "lucide-react";
import type { Field, SelectOption } from "@/api/plugin";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "@/components/pr/keys";
import { cn } from "@/lib/utils";
import type { LiveSender } from "./form";
import { PluginIcon } from "./parts";
import { avatarTone, groupOptions, PICKER_MAX_PICKED, PICKER_MIN_CHARS, pickedOptions, pickedSummary, pickerShows, pickerTerm, searchSender, togglePick } from "./picker";

/** The chart colours an avatar takes (picker.ts avatarTone), as literal classes for Tailwind. */
const AVATAR_BG = ["bg-cf-chart-1", "bg-cf-chart-2", "bg-cf-chart-3", "bg-cf-chart-4", "bg-cf-chart-5", "bg-cf-chart-6"];

export interface PickerProps {
  f: Field;
  id: string;
  /** The picked values now (the draft, else the plugin's). */
  value: readonly string[];
  invalid: boolean;
  disabled: boolean;
  /** In a toolbar or footer: a compact trigger with the label. */
  strip: boolean;
  /** The user changed the value: a draft and the field's change act. */
  commit: (next: string[]) => void;
  /** Send a search act with this query; resolves whether the plugin took it. */
  search: (term: string) => Promise<boolean>;
}

function Lead({ o }: { o: SelectOption }) {
  if (o.avatar) {
    return (
      <span
        aria-hidden
        className={cn("inline-flex size-4.5 shrink-0 items-center justify-center rounded-full text-caption-sm font-medium text-cf-canvas", AVATAR_BG[avatarTone(o.value) - 1])}
        data-testid="plugin-picker-avatar"
      >
        {o.avatar}
      </span>
    );
  }
  if (o.icon) return <PluginIcon name={o.icon} className="size-3.5 shrink-0 text-cf-text-muted" />;
  return null;
}

function Message({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p className="flex items-center gap-1.5 px-2 py-2 text-caption text-cf-text-muted" data-testid={testId}>
      {children}
    </p>
  );
}

function Rows({ options, picked, full, pick }: { options: readonly SelectOption[]; picked: readonly string[]; full: boolean; pick: (o: SelectOption) => void }) {
  return (
    <>
      {groupOptions(options).map((g) => (
        <CommandGroup key={g.heading} heading={g.heading || undefined} className="p-0" data-testid="plugin-picker-group" data-heading={g.heading}>
          {g.options.map((o) => {
            const on = picked.includes(o.value);
            return (
              <CommandItem
                key={o.key}
                value={o.key}
                disabled={o.disabled || (full && !on)}
                onSelect={() => {
                  pick(o);
                }}
                data-testid="plugin-picker-option"
                data-option={o.value}
                data-picked={on || undefined}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">{on && <Check className="size-3.5 text-cf-text" aria-label="Picked" />}</span>
                <Lead o={o} />
                <Tip label={o.label} whenTruncated>
                  <span className="min-w-0 truncate">{o.label}</span>
                </Tip>
                {o.detail && <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-caption text-cf-text-muted">{o.detail}</span>}
              </CommandItem>
            );
          })}
        </CommandGroup>
      ))}
    </>
  );
}

/**
 * The open picker: its search box (a multiple picker's picked values as tokens before the
 * text) and the list: the options until PICKER_MIN_CHARS characters, then the plugin's
 * results for the query in the box, or "Searching…" until a view answers it (picker.ts).
 * Mounted only while open: closing drops the text and any search waiting to go.
 */
function PickerBody({ f, value, commit, search, close, picked }: PickerProps & { close: () => void; picked: readonly SelectOption[] }) {
  const sel = f.select ?? {};
  const multiple = sel.multiple ?? false;
  const [input, setInput] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const term = pickerTerm(input);
  const sendRef = useRef(search);
  useEffect(() => {
    sendRef.current = search;
  });
  const sender = useRef<LiveSender | null>(null);
  useEffect(() => {
    const s = searchSender((t) =>
      sendRef.current(t).then((ok) => {
        setFailed((was) => (ok ? (was === t ? null : was) : t));
      }),
    );
    sender.current = s;
    return s.cancel;
  }, []);
  const shows = pickerShows(sel.search, term);
  const full = multiple && value.length >= PICKER_MAX_PICKED;
  const pick = (o: SelectOption) => {
    commit(togglePick(value, o.value, multiple, f.required ?? false));
    if (!multiple) close();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && input === "" && multiple && value.length > 0) {
      e.preventDefault();
      commit(value.slice(0, -1));
    }
  };
  const placeholder = sel.search?.placeholder || "Search";
  return (
    <Command className="bg-transparent" loop shouldFilter={false}>
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b px-3 py-2" data-testid="plugin-picker-box">
        {!multiple && <SearchIcon className="mr-1 size-4 shrink-0 opacity-50" aria-hidden />}
        {multiple &&
          picked.map((o) => (
            <span key={o.value} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm bg-cf-control py-0.5 pr-0.5 pl-1.5 text-caption" data-testid="plugin-picker-token" data-value={o.value}>
              <span className="min-w-0 truncate">{o.label}</span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove ${o.label}`}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text"
                onPointerDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => {
                  commit(value.filter((v) => v !== o.value));
                }}
                data-testid="plugin-picker-token-remove"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        <CommandPrimitive.Input
          autoFocus
          value={input}
          onValueChange={(v) => {
            setInput(v);
            sender.current?.push(v);
          }}
          onKeyDown={onKey}
          placeholder={multiple && picked.length > 0 ? "" : placeholder}
          aria-label={placeholder}
          className="h-6 min-w-16 flex-1 bg-transparent text-body outline-hidden placeholder:text-cf-placeholder"
          data-testid="plugin-picker-search"
        />
      </div>
      <CommandList className="max-h-72 p-1" data-testid="plugin-picker-list" data-shows={shows.kind}>
        {shows.kind === "options" &&
          ((sel.options ?? []).length > 0 ? (
            <Rows options={sel.options ?? []} picked={value} full={full} pick={pick} />
          ) : (
            <Message testId="plugin-picker-hint">Type {PICKER_MIN_CHARS}+ characters to search</Message>
          ))}
        {shows.kind === "results" &&
          (shows.results.length > 0 ? <Rows options={shows.results} picked={value} full={full} pick={pick} /> : <Message testId="plugin-picker-nomatch">No matches</Message>)}
        {shows.kind === "searching" &&
          (failed === term ? (
            <Message testId="plugin-picker-failed">Search failed</Message>
          ) : (
            <Message testId="plugin-picker-searching">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              Searching…
            </Message>
          ))}
      </CommandList>
    </Command>
  );
}

/**
 * A select the plugin searches (pluginsdk/ui Select.Search; picker.ts): a trigger naming the
 * picked options that opens a popover with a search box and the options. In a form's body
 * the trigger is the full-width dropdown's; in a toolbar or footer it is compact, its label
 * then the picked labels ("Assignee  Me, Kim"). Arrows move, Enter picks, Esc closes and
 * focus goes back to the trigger. A single pick closes it; a multiple picker stays open.
 */
export function PickerControl(props: PickerProps) {
  const { f, id, value, invalid, disabled, strip } = props;
  const sel = f.select ?? {};
  const [open, setOpen] = useState(false);
  const { ref, boundary } = usePanelBoundary();
  // The options the user picked here, for their labels: a value picked from an earlier
  // search's results may be in no list of a later view.
  const [seen, setSeen] = useState<ReadonlyMap<string, SelectOption>>(() => new Map());
  const picked = pickedOptions(value, [sel.search?.results ?? [], sel.options ?? []], seen);
  const summary = pickedSummary(picked);
  const commit = (next: string[]) => {
    const lists = [...(sel.search?.results ?? []), ...(sel.options ?? [])];
    const add = next.flatMap((v) => lists.find((x) => x.value === v) ?? []);
    if (add.length > 0) setSeen((m) => new Map([...m, ...add.map((o) => [o.value, o] as const)]));
    props.commit(next);
  };
  const empty = picked.length === 0;
  const placeholder = sel.placeholder || (strip ? "" : "Choose…");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type="button"
          id={id}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-required={f.required || undefined}
          className={cn(
            "flex h-7 min-w-0 items-center gap-2 rounded-md border border-cf-input bg-transparent px-2.5 py-1 text-body-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-cf-focus focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-cf-error aria-invalid:ring-cf-error/20 dark:bg-cf-input/30 dark:hover:bg-cf-input/50 dark:aria-invalid:ring-cf-error/40",
            strip ? "max-w-64 px-2" : "w-full justify-between",
            !strip && empty && "text-cf-text-muted",
          )}
          data-testid="plugin-select"
          data-name={f.name}
          data-style={strip ? "picker-compact" : "picker"}
        >
          {strip && f.label && <span className="shrink-0 text-cf-text-muted">{f.label}</span>}
          <Tip label={empty ? undefined : summary} whenTruncated>
            <span className={cn("min-w-0 truncate", strip && empty && "text-cf-text-muted")} data-testid="plugin-picker-summary">
              {empty ? placeholder : summary}
            </span>
          </Tip>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {!strip && picked.length > 1 && <span className="text-caption-sm tabular-nums">{picked.length}</span>}
            <ChevronDown className="size-4 text-cf-text-muted opacity-50" aria-hidden />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        // In a strip 288 px under the compact trigger; in a form as wide as its full-width trigger.
        className={cn("overflow-hidden p-0", strip ? "w-72" : "w-[calc(var(--radix-popover-trigger-width)/var(--cf-zoom))]", POPUP_FIT)}
        data-testid="plugin-picker"
        onKeyDown={stopPlainKeys}
      >
        <PickerBody
          {...props}
          commit={commit}
          picked={picked}
          close={() => {
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
