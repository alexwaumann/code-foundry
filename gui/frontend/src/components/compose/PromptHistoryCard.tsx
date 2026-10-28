import { useEffect, useRef, type ReactNode } from "react";
import type { PromptScopeView, SentPromptView } from "@/api/thread";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/lib/clock";
import { sentTime } from "@/lib/format";
import { hitRanges, oneLine, PROMPT_SCOPES, relativeAge, SCOPE_LABELS } from "@/lib/promptHistory";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { useFitBelow } from "./useFitBelow";
import { listStatusText, type PromptPickerModel } from "./usePromptHistory";

/**
 * The scope toggle (This thread / Project / All): the shared segmented control, small.
 * A mousedown keeps the keyboard where it is (the prompt, the palette's input).
 */
export function ScopeToggle({ scope, threadScope, onChange }: { scope: PromptScopeView; threadScope: boolean; onChange: (s: PromptScopeView) => void }) {
  return (
    <Tabs
      value={scope}
      onValueChange={(v) => {
        onChange(v as PromptScopeView);
      }}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      className="shrink-0"
    >
      <TabsList className="h-6 rounded-md p-0.5" aria-label="Scope" data-testid="prompt-history-scope">
        {PROMPT_SCOPES.map((s) => (
          <TabsTrigger key={s} value={s} disabled={s === "thread" && !threadScope} className="rounded-sm px-2 py-0 text-caption" data-testid={`prompt-history-scope-${s}`}>
            {SCOPE_LABELS[s]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The prompt on one line, the filter's hits emphasized. */
function PromptText({ text, query }: { text: string; query: string }) {
  const line = oneLine(text);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of hitRanges(line, query)) {
    if (from > at) parts.push(line.slice(at, from));
    parts.push(
      <mark key={from} className="rounded-sm bg-cf-info/25 text-cf-text" data-testid="prompt-history-hit">
        {line.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  parts.push(line.slice(at));
  return (
    <span className="min-w-0 flex-1 truncate text-cf-text" data-testid="prompt-history-text">
      {parts}
    </span>
  );
}

/**
 * A row's contents, in the card and the palette: the prompt on one line, then its sent
 * time (This thread) or its thread's name and age (Project, All). Clicking the name shows
 * the prompt in its thread.
 */
export function PromptRowBody({
  prompt,
  query,
  scope,
  selected,
  onThread,
}: {
  prompt: SentPromptView;
  query: string;
  scope: PromptScopeView;
  /** Shows the ⏎; undefined: the row's `group/prompt` data-selected decides (a cmdk item). */
  selected?: boolean;
  onThread: () => void;
}) {
  const now = useNow(30_000);
  const ms = prompt.sentAt.getTime();
  return (
    <>
      <PromptText text={prompt.text} query={query} />
      {scope === "thread" ? (
        <span className="shrink-0 text-caption tabular-nums" data-testid="prompt-history-time">
          {sentTime(ms)}
        </span>
      ) : (
        <>
          <button
            type="button"
            tabIndex={-1}
            className="max-w-40 shrink-0 cursor-pointer truncate text-caption hover:text-cf-text hover:underline"
            data-testid="prompt-history-thread"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onThread();
            }}
          >
            {prompt.threadName || prompt.threadId}
          </button>
          <span className="w-15 shrink-0 text-caption tabular-nums" data-testid="prompt-history-age">
            {relativeAge(ms, now)}
          </span>
        </>
      )}
      <span
        aria-hidden
        className={cn("w-3 shrink-0 text-caption", selected === false && "invisible", selected === undefined && "invisible group-data-[selected=true]/prompt:visible")}
      >
        ⏎
      </span>
    </>
  );
}

/** A footer hint: its keys, then what they do. */
export function Hint({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {keys.map((k) => (
        <Kbd key={k} size="sm">
          {k}
        </Kbd>
      ))}
      {children}
    </span>
  );
}

/**
 * The "Previous prompts" card (docs/notes/prompt-history-2-picker.md), in the completion
 * card's place and surface (CompletionCard: overlaid, height fitted to the room left), but
 * opaque: over the transcript, text behind a translucent card showed through. A header with the count and the
 * scope toggle, one row per prompt (the selected one on the control-hover background with
 * a ⏎), the keys in the footer. A mousedown keeps the keyboard in the prompt; hovering a
 * row selects it, a click puts it in the draft.
 */
export function PromptHistoryCard({ picker, above = false }: { picker: PromptPickerModel; /** Hang over the anchor instead of under it. */ above?: boolean }) {
  const { open, heading, scope, threadScope, setScope, list, query, selected, listId, optionId, select, pick, show } = picker;
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = open && list.prompts.length > 0 ? optionId(selected) : "";
  useFitBelow(cardRef, open, above);
  // The selected row stays in view (the list scrolls, never the pane), as in CompletionCard.
  useEffect(() => {
    const el = listRef.current;
    const option = active ? document.getElementById(active) : null;
    if (!el || !option) return;
    const o = option.getBoundingClientRect();
    const l = el.getBoundingClientRect();
    const zoom = zoomFactor();
    if (o.top < l.top) el.scrollTop -= Math.ceil((l.top - o.top) / zoom);
    else if (o.bottom > l.bottom) el.scrollTop += Math.ceil((o.bottom - l.bottom) / zoom);
  }, [active]);
  if (!open) return null;
  const status = listStatusText(list, query);
  return (
    <div
      ref={cardRef}
      className={cn(
        "group/completion absolute inset-x-0 z-10 flex flex-col overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised text-body-sm shadow-sm",
        above ? "bottom-full mb-2" : "top-full mt-2",
      )}
      data-testid="prompt-history"
      data-scope={scope}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-overline" data-testid="prompt-history-heading">
          {heading}
        </span>
        <ScopeToggle scope={scope} threadScope={threadScope} onChange={setScope} />
      </div>
      {status !== null ? (
        <p className="shrink-0 px-3 pt-1 pb-2.5 text-caption" role="status" data-testid="prompt-history-status">
          {status}
        </p>
      ) : (
        <div ref={listRef} id={listId} role="listbox" aria-label="Previous prompts" className="max-h-[15.5rem] min-h-0 overflow-y-auto pb-1">
          {list.prompts.map((p, i) => {
            const on = i === selected;
            return (
              <div
                key={`${p.threadId}/${p.itemId}`}
                id={optionId(i)}
                role="option"
                aria-selected={on}
                data-testid="prompt-history-item"
                data-selected={on || undefined}
                className={cn("mx-1 flex h-7 cursor-pointer items-center gap-3 rounded-md px-2", on && "bg-cf-control-hover")}
                onMouseMove={() => {
                  select(i);
                }}
                onClick={() => {
                  pick(i);
                }}
              >
                <PromptRowBody
                  prompt={p}
                  query={query}
                  scope={scope}
                  selected={on}
                  onThread={() => {
                    show(i);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-caption-sm group-data-[short]/completion:hidden" data-testid="prompt-history-hints">
        <Hint keys={["↵"]}>Use</Hint>
        <Hint keys={["⌘↵"]}>Show in thread</Hint>
        <Hint keys={["⌘C"]}>Copy</Hint>
        <Hint keys={["⌘S"]}>Scope</Hint>
        <span className="ml-auto">
          <Hint keys={["esc"]}>Close</Hint>
        </span>
      </div>
    </div>
  );
}
