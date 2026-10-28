import { useRef, useState } from "react";
import type { PromptScopeView, SentPromptView } from "@/api/thread";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Hint, PromptRowBody, ScopeToggle } from "@/components/compose/PromptHistoryCard";
import { listStatusText, usePromptList } from "@/components/compose/usePromptHistory";
import { nextScope, pickerAction } from "@/lib/promptHistory";
import { copyPrompt, insertFromPalette, paletteSource, revealPrompt } from "@/stores/promptHistory";

function promptKey(p: SentPromptView): string {
  return `${p.threadId}/${p.itemId}`;
}

/**
 * The palette's previous prompts (composer.history without a focused composer;
 * docs/notes/prompt-history-2-picker.md): the input filters, the scope toggle sits in the
 * input row (This thread with a thread on screen, else Project or All), rows as in the
 * composer's card. Enter puts the prompt in the window's composer (stores/promptHistory
 * insertFromPalette), cmd+Enter shows it in its thread, cmd+C copies it, cmd+S cycles
 * the scope.
 */
export function PromptsPicker({ close }: { close: () => void }) {
  // What the window showed when the palette opened.
  const [{ threadId, source, scope: initial }] = useState(paletteSource);
  const threadScope = threadId !== "";
  const [scope, setScope] = useState<PromptScopeView>(initial);
  const [query, setQuery] = useState("");
  const filter = query.trim();
  const list = usePromptList({ open: true, openSeq: 1, scope, threadId, source, query: filter });
  const rootRef = useRef<HTMLDivElement>(null);
  const status = listStatusText(list, filter);

  /** The row cmdk highlights (it does not report automatic highlights, so read the DOM). */
  const highlighted = (): SentPromptView | undefined => {
    const key = rootRef.current?.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-value");
    return list.prompts.find((p) => promptKey(p) === key);
  };
  const pick = (p: SentPromptView) => {
    close();
    insertFromPalette(p);
  };
  const show = (p: SentPromptView) => {
    close();
    revealPrompt(p);
  };

  return (
    <Command
      ref={rootRef}
      loop
      shouldFilter={false}
      data-testid="palette"
      data-mode="prompts"
      onKeyDown={(e) => {
        const input = e.target instanceof HTMLInputElement ? e.target : null;
        const selectionEmpty = !input || input.selectionStart === input.selectionEnd;
        const a = pickerAction(e.nativeEvent, selectionEmpty);
        if (!a || (a.kind !== "show" && a.kind !== "copy" && a.kind !== "scope")) return;
        e.preventDefault();
        e.stopPropagation();
        if (a.kind === "scope") {
          setScope((s) => nextScope(s, threadScope));
          return;
        }
        const p = highlighted();
        if (!p) return;
        if (a.kind === "show") show(p);
        else void copyPrompt(p);
      }}
    >
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Search previous prompts…"
        trailing={<ScopeToggle scope={scope} threadScope={threadScope} onChange={setScope} />}
      />
      <CommandList>
        {status !== null ? (
          <p className="px-3 py-6 text-center text-body text-cf-text-muted" role="status" data-testid="prompt-history-status">
            {status}
          </p>
        ) : (
          <div className="p-1" role="presentation">
            {list.prompts.map((p) => (
              <CommandItem
                key={promptKey(p)}
                value={promptKey(p)}
                onSelect={() => {
                  pick(p);
                }}
                className="group/prompt h-7 gap-3 rounded-md py-0 text-body-sm"
                data-testid="prompt-history-item"
              >
                <PromptRowBody
                  prompt={p}
                  query={filter}
                  scope={scope}
                  onThread={() => {
                    show(p);
                  }}
                />
              </CommandItem>
            ))}
          </div>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-caption-sm" data-testid="prompt-history-hints">
        <Hint keys={["↵"]}>Insert into composer</Hint>
        <Hint keys={["⌘↵"]}>Show in thread</Hint>
        <Hint keys={["⌘C"]}>Copy</Hint>
      </div>
    </Command>
  );
}
