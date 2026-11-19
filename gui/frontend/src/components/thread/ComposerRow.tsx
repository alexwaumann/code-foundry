import { useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { AlarmClock, ArrowDown, ChevronRight, ChevronUp } from "lucide-react";
import { StatusCircle } from "@/components/status/StatusCircle";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import {
  pillSegments,
  pillStep,
  segmentForm,
  snoozeFull,
  snoozeShort,
  waitTotal,
  waitWords,
  WIDEST_TIMERS,
  type PillSegment,
  type PillSnooze,
  type PillStep,
} from "@/lib/composerPill";
import { formatDuration, type DurationUnits } from "@/lib/duration";
import { rowToneClasses } from "@/lib/statusRegistry";
import { cn } from "@/lib/utils";
import type { WaitCounts } from "@/lib/waitList";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { PillSnoozeMenu } from "./PillSnoozeMenu";
import { usePillSnooze, useStopWaiting, useWaitData } from "./pillData";
import { useBridgeAway, useBridgeSince, type TimelineBridge } from "./timelineBridge";
import { WaitingPanel } from "./WaitingPanel";

/** The turn header's units (rows.tsx ELAPSED). */
const ELAPSED: DurationUnits = { hours: true, minutes: true, seconds: true };

const SEG = "flex shrink-0 items-center gap-1 px-2 whitespace-nowrap outline-none";
const BUTTON = "cursor-default hover:bg-cf-control-hover focus-visible:bg-cf-control-hover aria-expanded:bg-cf-control-hover";
const ICON = "size-3.5 shrink-0";
const MUTED = "text-cf-text-muted";
const WARNING = rowToneClasses.warning;

/**
 * When the live turn started, as its header says it (rows.tsx HeaderRow): its message's time,
 * or the setup's end when that is later (the first turn's work starts then). Null with no
 * live turn or no message.
 */
function useTurnStart(threadId: string, since: string): number | null {
  const sent = useThreadStore((s) => (since ? (s.logs[threadId]?.byId[since]?.createdAtMs ?? null) : null));
  const setupEnd = useThreadsStore((s) => (since ? (s.byId[threadId]?.setup?.endedAtMs ?? null) : null));
  return sent !== null && setupEnd !== null ? Math.max(sent, setupEnd) : sent;
}

/** The elapsed time, on the shared 1 s clock: only this ticks, not the row. */
function Elapsed({ from }: { from: number }) {
  const now = useNow(1000);
  return <>{formatDuration(now - from, ELAPSED)}</>;
}

/** An icon, or in the measuring copy a box of its size (nothing turns there). */
function Icon({ measure, children }: { measure: boolean; children: ReactNode }) {
  return measure ? <span className={cn(ICON, "inline-block")} /> : children;
}

function Chevron({ open }: { open: boolean }) {
  const C = open ? ChevronUp : ChevronRight;
  return <C className={cn("size-3 shrink-0", MUTED)} aria-hidden />;
}

/** What a segment says in each form; `timer` is the elapsed time (or, measuring, its widest text). */
interface SegmentData {
  timer: ReactNode;
  snooze: PillSnooze | null;
  counts: WaitCounts;
  now: number;
}

function WorkingBody({ form, timer, measure }: { form: number; timer: ReactNode; measure: boolean }) {
  return (
    <>
      <Icon measure={measure}>
        <StatusCircle tone="working" className={ICON} aria-hidden />
      </Icon>
      {form === 0 && <span>Working</span>}
      {timer !== null && <span className={cn(MUTED, "tabular-nums")}>{timer}</span>}
    </>
  );
}

function SnoozeBody({ form, snooze, now, open, measure }: { form: number; snooze: PillSnooze; now: number; open: boolean; measure: boolean }) {
  const woken = snooze.kind === "woken";
  return (
    <>
      <Icon measure={measure}>
        <AlarmClock className={cn(ICON, woken ? WARNING : MUTED)} aria-hidden />
      </Icon>
      <span className={cn(woken && WARNING)} data-testid={measure ? undefined : "snooze-sentence"}>
        {form === 0 ? snoozeFull(snooze, now) : snoozeShort(snooze)}
      </span>
      <Chevron open={open} />
    </>
  );
}

function WaitingBody({ form, counts, open, measure }: { form: number; counts: WaitCounts; open: boolean; measure: boolean }) {
  return (
    <>
      <Icon measure={measure}>
        <StatusCircle tone="waiting" className={ICON} aria-hidden />
      </Icon>
      <span data-testid={measure ? undefined : "waiting-sentence"}>
        {form < 2 && "Waiting on "}
        <span className={MUTED}>{form === 0 ? waitWords(counts) : String(waitTotal(counts))}</span>
      </span>
      <Chevron open={open} />
    </>
  );
}

function JumpBody() {
  return (
    <>
      <ArrowDown className={cn(ICON, MUTED)} aria-hidden />
      Jump to bottom
    </>
  );
}

/** How many forms each segment has (lib/composerPill segmentForm). */
const FORMS: Readonly<Record<PillSegment, number>> = {
  working: 2,
  snooze: 2,
  waiting: 3,
  stop: 1,
  jump: 1,
};

function segmentBody(seg: PillSegment, form: number, d: SegmentData, open: boolean, measure: boolean): ReactNode {
  switch (seg) {
    case "working":
      return <WorkingBody form={form} timer={d.timer} measure={measure} />;
    case "snooze":
      return d.snooze && <SnoozeBody form={form} snooze={d.snooze} now={d.now} open={open} measure={measure} />;
    case "waiting":
      return <WaitingBody form={form} counts={d.counts} open={open} measure={measure} />;
    case "stop":
      return "Stop waiting";
    case "jump":
      return <JumpBody />;
  }
}

/**
 * Every form of every present segment, laid out off the row and invisible, for measuring
 * (padding, icons and chevrons included). The timer is measured at its widest texts, so a
 * ticking one never changes the form.
 */
function Measurer({ segs, d, ref }: { segs: readonly PillSegment[]; d: SegmentData; ref: Ref<HTMLDivElement> }) {
  // Clipped to the row, so its width never overflows what holds the row.
  return (
    <div aria-hidden className="pointer-events-none invisible absolute inset-0 overflow-hidden">
      <div ref={ref} className="flex w-max" data-testid="composer-pill-measure">
        {segs.flatMap((seg) =>
          Array.from({ length: FORMS[seg] }, (_, form) =>
            (seg === "working" && d.timer !== null ? WIDEST_TIMERS : [null]).map((timer, i) => (
              <div key={`${seg}:${String(form)}:${String(i)}`}>
                <span className={SEG} data-seg={seg} data-form={form}>
                  {segmentBody(seg, form, timer === null ? d : { ...d, timer }, false, true)}
                </span>
              </div>
            )),
          ),
        )}
      </div>
    </div>
  );
}

/** The measured widths of each segment's forms (the widest of a form's copies). */
function measured(el: HTMLElement): Partial<Record<PillSegment, number[]>> {
  const out: Partial<Record<PillSegment, number[]>> = {};
  for (const node of el.querySelectorAll<HTMLElement>("[data-seg]")) {
    const seg = node.dataset.seg as PillSegment;
    const form = Number(node.dataset.form);
    const forms = (out[seg] ??= []);
    forms[form] = Math.max(forms[form] ?? 0, node.getBoundingClientRect().width);
  }
  return out;
}

/**
 * The form the pill takes in its row: measured before paint (a layout effect after every
 * render, and a ResizeObserver on the row and on the measuring copy), so it never shows a
 * form that does not fit, nor flickers on a resize.
 */
function usePillStep(segs: readonly PillSegment[]): {
  rowRef: RefObject<HTMLDivElement | null>;
  measureRef: RefObject<HTMLDivElement | null>;
  step: PillStep;
} {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<PillStep>(0);
  const fit = useRef(() => {});
  // After every render: the segments or their words may have changed.
  useLayoutEffect(() => {
    fit.current = () => {
      const row = rowRef.current;
      const m = measureRef.current;
      if (!row || !m) return;
      const available = row.getBoundingClientRect().width;
      // Not laid out (a hidden pane): nothing to fit yet; the observer measures again once it is.
      if (available === 0) return;
      // The pill's border, and a 1px divider between two segments.
      const chrome = 2 + Math.max(0, segs.length - 1);
      setStep(pillStep({ segments: measured(m), chrome }, available));
    };
    fit.current();
  });
  useLayoutEffect(() => {
    const row = rowRef.current;
    const m = measureRef.current;
    if (!row || !m) return;
    const ro = new ResizeObserver(() => {
      fit.current();
    });
    ro.observe(row);
    ro.observe(m);
    return () => {
      ro.disconnect();
    };
  }, []);
  return { rowRef, measureRef, step };
}

/**
 * The row above a thread's composer (docs/notes/composer-row-pill.md): always in the layout at
 * its fixed height, so nothing moves when what it shows changes. Centred in it, one pill of
 * segments, left to right: Working (the live turn's circle, word and time), the snooze (a menu
 * upward), Waiting on (a panel upward), Stop waiting while idle, and Jump to bottom while the
 * list is scrolled up. With none of them the row is empty. When the pill does not fit, its
 * segments shorten in a fixed order (lib/composerPill pillStep), each shortened one with its
 * whole text as a tooltip. `bridge` is the timeline's (Jump to bottom, the turn's start).
 */
export function ComposerRow({ threadId, working, bridge }: { threadId: string; working: boolean; bridge: TimelineBridge }) {
  const snooze = usePillSnooze(threadId);
  const wait = useWaitData(threadId);
  const stopper = useStopWaiting(threadId);
  const away = useBridgeAway(bridge);
  const since = useBridgeSince(bridge);
  const start = useTurnStart(threadId, working ? since : "");
  const now = useNow(30_000);
  const [open, setOpen] = useState<"snooze" | "waiting" | null>(null);
  const segs = pillSegments({
    working,
    snooze: snooze !== null,
    waiting: wait.shown,
    canStopWaiting: wait.canStop,
    away,
  });
  const { rowRef, measureRef, step } = usePillStep(segs);
  const d: SegmentData = {
    timer: start === null ? null : <Elapsed from={start} />,
    snooze,
    counts: wait.counts,
    now,
  };
  const toggle = (which: "snooze" | "waiting") => (o: boolean) => {
    setOpen(o ? which : null);
  };

  const segment = (seg: PillSegment): ReactNode => {
    const form = segmentForm(seg, step);
    switch (seg) {
      case "working":
        return (
          <Tip key={seg} label={form > 0 ? <>Working{start !== null && <> {d.timer}</>}</> : ""}>
            <span className={SEG} data-testid="pill-working" data-form={form}>
              {segmentBody(seg, form, d, false, false)}
            </span>
          </Tip>
        );
      case "snooze":
        if (!snooze) return null;
        return (
          <DropdownMenu key={seg} open={open === "snooze"} onOpenChange={toggle("snooze")}>
            <Tip label={form > 0 ? snoozeFull(snooze, now) : ""}>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(SEG, BUTTON)} data-testid="pill-snooze" data-kind={snooze.kind} data-form={form}>
                  {segmentBody(seg, form, d, open === "snooze", false)}
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent side="top" align="center" sideOffset={6} className="min-w-60" data-testid="snooze-menu">
              <PillSnoozeMenu threadId={threadId} snooze={snooze} now={now} />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      case "waiting":
        return (
          <Popover key={seg} open={open === "waiting"} onOpenChange={toggle("waiting")}>
            <Tip label={form > 0 ? `Waiting on ${waitWords(wait.counts)}` : ""}>
              <PopoverTrigger asChild>
                <button type="button" className={cn(SEG, BUTTON)} data-testid="pill-waiting" data-form={form}>
                  {segmentBody(seg, form, d, open === "waiting", false)}
                </button>
              </PopoverTrigger>
            </Tip>
            <PopoverContent side="top" align="center" sideOffset={6} className="w-[27rem] max-w-[calc(100vw-2rem)] p-0">
              <WaitingPanel threadId={threadId} />
            </PopoverContent>
          </Popover>
        );
      case "stop":
        return (
          <button key={seg} type="button" className={cn(SEG, BUTTON, "disabled:text-cf-text-muted")} disabled={stopper.disabled} data-testid="waiting-stop" onClick={stopper.stop}>
            Stop waiting
          </button>
        );
      case "jump":
        return (
          <button
            key={seg}
            type="button"
            className={cn(SEG, BUTTON)}
            data-testid="thread-jump-bottom"
            data-shown="true"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              bridge.jump();
            }}
          >
            <JumpBody />
          </button>
        );
    }
  };

  return (
    <div ref={rowRef} className="composer-row relative flex h-8 items-start justify-center text-caption-sm text-cf-text" data-testid="composer-row">
      <Measurer ref={measureRef} segs={segs} d={d} />
      {segs.length > 0 && (
        <div
          className="flex h-7 max-w-full items-stretch overflow-hidden rounded-full border border-cf-border bg-cf-surface-raised shadow-sm [&>*+*]:border-l [&>*+*]:border-cf-border"
          data-testid="composer-pill"
          data-step={step}
        >
          {segs.map(segment)}
        </div>
      )}
    </div>
  );
}
