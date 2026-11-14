import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { SquareTerminal, X } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { TerminalHost, type TerminalHostHandle } from "@/components/terminal/TerminalHost";
import { tildify } from "@/lib/path";
import { normalizeDir } from "@/lib/terminalName";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { quickHeight, quickMode, quickTerminalOf, registerQuickHost } from "@/shell/quickTerminal";
import { closeQuick, forgetQuickRan, handBackFromQuick, runQuickAgain, setQuickHeight } from "@/shell/terminalActions";
import { useTerminalDir } from "@/shell/terminalTab";
import { useThreadLayout } from "@/stores/layout";
import { useTerminalsStore } from "@/stores/terminals";
import { TerminalCwdHint } from "./TerminalCwdHint";
import { RanLine } from "./TerminalTab";

/** The thread's chrome the quick terminal must leave room for when it pushes: its header and its composer dock. */
function chromeOf(box: HTMLElement): number {
  const header = box.querySelector<HTMLElement>('[data-testid="thread-header"]');
  const dock = box.querySelector<HTMLElement>(".dock");
  return (header?.offsetHeight ?? 0) + (dock?.offsetHeight ?? 0);
}

/** The box's height and the thread's chrome, in layout px, kept current. */
function useBoxMetrics(box: React.RefObject<HTMLDivElement | null>, watch: boolean): { height: number; chrome: number } {
  const [m, setM] = useState({ height: 0, chrome: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !watch) return;
    const measure = () => {
      const z = zoomFactor();
      const next = { height: Math.round(el.getBoundingClientRect().height / z), chrome: Math.round(chromeOf(el)) };
      setM((prev) => (prev.height === next.height && prev.chrome === next.chrome ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const header = el.querySelector('[data-testid="thread-header"]');
    const dock = el.querySelector(".dock");
    if (header) ro.observe(header);
    if (dock) ro.observe(dock);
    return () => {
      ro.disconnect();
    };
  }, [box, watch]);
  return m;
}

/**
 * A thread's tab with its quick terminal (docs/notes/shell-model.md, "Terminals"): the
 * conversation and composer, and under them, while it is open, the thread's quick terminal. It
 * pushes the content up while the composer and CHAT_MIN of conversation still fit above it, and
 * overlays the bottom of the pane when they do not. Its open state and height are the thread's,
 * in the layout (terminal.quick). It is attached only while open under its thread's active tab:
 * the pane mounts only the active tab.
 */
export function ThreadWithQuick({ threadId, children }: { threadId: string; children: ReactNode }) {
  const quick = useThreadLayout(threadId)?.quick ?? null;
  const open = quick?.open === true;
  const box = useRef<HTMLDivElement>(null);
  const { height: boxH, chrome } = useBoxMetrics(box, open);
  const stored = quick?.height ?? 0;
  // The drag's height, over the stored one it started from: once a commit changes that, the stored one stands.
  const [drag, setDrag] = useState<{ h: number; from: number } | null>(null);
  const h = quickHeight(drag?.from === stored ? drag.h : stored, boxH);
  const mode = open ? quickMode(boxH, h, chrome) : "push";
  return (
    <div ref={box} className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell-thread" data-quick={open ? mode : undefined}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {open && (
        <QuickTerminal
          threadId={threadId}
          height={h}
          overlay={mode === "overlay"}
          onDrag={(next) => {
            setDrag({ h: quickHeight(next, boxH), from: stored });
          }}
          onDrop={(next) => {
            const final = quickHeight(next, boxH);
            setDrag({ h: final, from: stored });
            void setQuickHeight(threadId, final);
          }}
        />
      )}
    </div>
  );
}

/**
 * The quick terminal itself: a header with its directory, the Reset hint when it has left the
 * thread's directory (right-aligned; the path shortens first), the chord and a close button,
 * then, when a snooze ended its old shell, the line with the command that shell ran and "Run
 * again", then the thread's quick shell. Its top edge drags its height.
 */
function QuickTerminal({ threadId, height, overlay, onDrag, onDrop }: { threadId: string; height: number; overlay: boolean; onDrag: (h: number) => void; onDrop: (h: number) => void }) {
  const terminal = useTerminalsStore((s) => quickTerminalOf(s.byId, s.order, threadId));
  const id = terminal?.id ?? "";
  const ran = useThreadLayout(threadId)?.quick?.ran ?? "";
  // As the user typed it: macOS's /private/tmp is /tmp.
  const dir = tildify(normalizeDir(useTerminalDir(id)));
  const host = useRef<TerminalHostHandle>(null);
  useEffect(
    () =>
      registerQuickHost(threadId, () => {
        host.current?.focus();
      }),
    [threadId],
  );
  // Closed under the keyboard (its shell exited, the CLI closed it): the keyboard would fall to
  // the body with it, so the thread's prompt takes it. Read before the node goes: a layout
  // effect's cleanup runs while it is still in the document.
  useLayoutEffect(
    () => () => {
      handBackFromQuick(threadId);
    },
    [threadId],
  );
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height };
  };
  const at = (e: ReactPointerEvent<HTMLDivElement>) => (drag.current ? drag.current.h + (drag.current.y - e.clientY) / zoomFactor() : height);
  return (
    <section
      aria-label="Quick terminal"
      className={cn("relative flex shrink-0 flex-col border-t border-cf-divider bg-cf-surface", overlay && "absolute inset-x-0 bottom-0 z-20 shadow-lg")}
      style={{ height }}
      data-testid="quick-terminal"
      data-quick-terminal={threadId}
      data-mode={overlay ? "overlay" : "push"}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the quick terminal"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
        data-testid="quick-terminal-resize"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (drag.current) onDrag(at(e));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          onDrop(at(e));
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-cf-text-muted" data-testid="quick-terminal-header">
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
        <Tip label={dir} whenTruncated side="bottom">
          <span className="min-w-0 shrink-[3] truncate text-code text-cf-text" data-testid="quick-terminal-dir">
            {dir || "Starting…"}
          </span>
        </Tip>
        <span className="ml-auto flex min-w-0 shrink items-center gap-2">
          {id && <TerminalCwdHint terminalId={id} />}
          <Kbd size="sm">⌘J</Kbd>
          <Tip label="Close quick terminal">
            <button
              type="button"
              aria-label="Close quick terminal"
              data-testid="quick-terminal-close"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
              onClick={() => void closeQuick(threadId)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </Tip>
        </span>
      </div>
      {ran && id && (
        <RanLine
          ran={ran}
          onRun={() => runQuickAgain(threadId, id, ran)}
          onDismiss={() => {
            void forgetQuickRan(threadId);
          }}
        />
      )}
      <TerminalHost ref={host} terminalId={id || null} testId="quick-terminal-host" />
    </section>
  );
}
