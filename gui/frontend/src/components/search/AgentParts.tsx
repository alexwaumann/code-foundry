import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import type { AgentHitView, AgentStepView, SearchEntryView } from "@/api/search";
import { useThreadPlace } from "@/components/thread/useThreadPlace";
import { answerPieces, summaryLine, type AnswerPiece } from "@/lib/agentSearch";
import { dayLabel } from "@/lib/threadSearch";
import { cn } from "@/lib/utils";

/** A section's heading in the results column ("Searching", "Found so far", "Recent searches"). */
export function SectionHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between px-3 pt-3 pb-1.5">
      <span className="text-overline text-cf-text-muted">{children}</span>
      {right}
    </div>
  );
}

/**
 * A step's text with its query in code and its thread name stressed, when the text shows
 * them as given (the daemon writes the text; the fields say which part is which).
 */
function StepText({ step }: { step: AgentStepView }) {
  const part = step.kind === "search" ? step.query : step.kind === "read" ? step.threadName : "";
  const at = part ? step.text.indexOf(part) : -1;
  if (at < 0) return <>{step.text}</>;
  return (
    <>
      {step.text.slice(0, at)}
      <span className={step.kind === "search" ? "text-code" : "font-medium text-cf-text"}>{part}</span>
      {step.text.slice(at + part.length)}
    </>
  );
}

/** The run's steps: ✓ done, a spinner while running, ✗ failed. */
export function StepList({ steps }: { steps: readonly AgentStepView[] }) {
  return (
    <div className="flex flex-col" data-testid="agent-steps">
      {steps.map((s) => {
        const state = s.failed ? "failed" : s.done ? "done" : "running";
        return (
          <div key={s.index} className={cn("flex items-center gap-2 px-3 py-1 text-body-sm", state === "running" ? "text-cf-text" : "text-cf-text-muted")} data-testid="agent-step" data-state={state}>
            <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
              {state === "failed" ? <X className="size-3.5 text-cf-error-text" /> : state === "done" ? <Check className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
            </span>
            <span className="min-w-0 truncate">
              <StepText step={s} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Whether a marker's next piece starts with punctuation, which then sits against it. */
function beforePunctuation(next: AnswerPiece | undefined): boolean {
  return next?.kind === "text" && /^[.,;:!?)\]}…]/.test(next.text);
}

/** The answer: plain text (the model's, never markdown or links), its [n] references as small numbered markers that select that hit. */
export function AnswerText({ answer, onRef }: { answer: string; onRef?: (n: number) => void }) {
  return (
    <p className="px-3 pt-3 pb-1 text-body whitespace-pre-wrap text-cf-text" data-testid="agent-answer">
      {answerPieces(answer).map((p, i, all) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            // No gap before punctuation ("spot 1."); one between a word or marker and the next.
            className={cn("rounded-sm text-caption text-cf-warning-text outline-none hover:bg-cf-control-hover", beforePunctuation(all[i + 1]) ? "ml-px pl-0.5" : "mx-px px-0.5")}
            aria-label={`Result ${String(p.n)}`}
            data-testid="agent-answer-ref"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => onRef?.(p.n)}
          >
            {p.n}
          </button>
        ),
      )}
    </p>
  );
}

/** "2 searches · read 3 threads · 21s", which opens the steps under it. */
export function SummaryLine({ entry }: { entry: Pick<SearchEntryView, "steps" | "searches" | "threadsRead" | "durationMs"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="agent-summary">
      <button
        type="button"
        className="flex items-center gap-1.5 px-3 py-1 text-caption text-cf-text-muted outline-none hover:text-cf-text"
        aria-expanded={open}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          setOpen((o) => !o);
        }}
        data-testid="agent-summary-toggle"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
        {summaryLine(entry)}
      </button>
      {open && <StepList steps={entry.steps} />}
    </div>
  );
}

/** A hit: its number, thread name, project, archived, time; the quote under a warning-coloured rule; why. Opened ones say so and are dimmed. */
export function HitRow({ hit, selected, onSelect, onOpen }: { hit: AgentHitView; selected: boolean; onSelect?: () => void; onOpen?: () => void }) {
  const place = useThreadPlace(hit.threadId);
  const project = place.set ?? place.project;
  return (
    <div
      role="option"
      aria-selected={selected}
      className={cn("cursor-default rounded-md px-2.5 py-2", selected && "bg-cf-control-hover")}
      data-testid="agent-hit"
      data-n={hit.n}
      data-thread={hit.threadId}
      data-item={hit.itemId}
      data-selected={selected || undefined}
      data-opened={hit.opened || undefined}
      onPointerMove={selected ? undefined : onSelect}
      onMouseDown={(e) => {
        // Keep the keyboard in the query field.
        e.preventDefault();
      }}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-3.5 shrink-0 text-caption text-cf-warning-text tabular-nums">{hit.n}</span>
        <span className={cn("max-w-[55%] shrink-0 truncate text-label font-medium", hit.opened ? "text-cf-text-muted" : "text-cf-text")}>{hit.threadName || hit.threadId}</span>
        <span className="min-w-0 truncate text-caption text-cf-text-muted">{[project, hit.archived ? "archived" : ""].filter(Boolean).join(" · ")}</span>
        <span className="ml-auto shrink-0 text-caption text-cf-text-muted tabular-nums">
          {hit.opened ? (
            <span className="inline-flex items-center gap-1" data-testid="agent-hit-opened">
              <Check className="size-3" aria-hidden />
              opened
            </span>
          ) : (
            dayLabel(hit.itemAtMs)
          )}
        </span>
      </div>
      <div
        className={cn(
          "mt-1 ml-[22px] border-l-2 pl-2 text-body-sm",
          hit.opened ? "border-[color-mix(in_oklab,var(--cf-warning)_30%,transparent)] text-cf-text-muted" : "border-[color-mix(in_oklab,var(--cf-warning)_60%,transparent)] text-cf-text",
        )}
        data-testid="agent-hit-quote"
      >
        “{hit.quote}”
      </div>
      {hit.why && (
        <div className="mt-1 ml-[22px] text-caption text-cf-text-muted" data-testid="agent-hit-why">
          {hit.why}
        </div>
      )}
    </div>
  );
}
