import { useCallback, useMemo, useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { copyFromBrowser, pasteToBrowser, sendBrowserInput } from "@/api/browser";
import { usePanelKey } from "@/components/panel/panelKeyContext";
import { buttonName, ClickCounter, heldButton, InputQueue, isCopyChord, isPasteChord, keyDown, keyForPage, keyUp, modifiersOf, toPage, wheelPixels } from "@/lib/browserInput";
import { setBrowserError, useBrowserState, useBrowserStore } from "@/stores/browser";
import { BrowserOverlays } from "./BrowserOverlays";
import { BrowserToolbar } from "./BrowserToolbar";
import { useBrowserStream } from "./useBrowserStream";

/**
 * A page in Chrome, in a panel tab: frames on a canvas, input forwarded. Keys go through a
 * hidden textarea rather than the canvas, because only a text field gets real paste events and
 * finishes compositions (dead keys, IME), and [data-chord-yield] lets the app's own cmd chords
 * through it (keys/bindings.ts).
 */
export function BrowserSurface() {
  const surface = usePanelKey();
  const state = useBrowserState(surface);
  const error = useBrowserStore((s) => s.errors[surface] ?? "");
  const offline = useBrowserStore((s) => s.offline[surface] ?? false);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const page = useBrowserStream(surface, box, canvas);
  const clicks = useMemo(() => new ClickCounter(), []);
  const queue = useMemo(() => new InputQueue((events) => sendBrowserInput(surface, events)), [surface]);
  const pressed = useRef(0);

  const at = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = canvas.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
      return toPage(e.clientX, e.clientY, r, page.current);
    },
    [page],
  );

  const mouse = (e: PointerEvent, type: "mousePressed" | "mouseReleased" | "mouseMoved", clickCount: number) => {
    queue.push({ kind: "mouse", type, button: type === "mouseMoved" ? heldButton(e.buttons) : buttonName(e.button), ...at(e), buttons: e.buttons, clickCount, modifiers: modifiersOf(e), deltaX: 0, deltaY: 0 });
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // the focus goes to the sink, not to wherever the browser would put it
    sink.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    pressed.current = clicks.press(e.timeStamp, e.clientX, e.clientY, e.button);
    mouse(e, "mousePressed", pressed.current);
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    mouse(e, "mouseReleased", pressed.current);
  };

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    queue.push({ kind: "mouse", type: "mouseWheel", button: "none", ...at(e), buttons: e.buttons, clickCount: 0, modifiers: modifiersOf(e), ...wheelPixels(e, page.current.height) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // A paste the page gets through onPaste below; let the browser make that event.
    if (isPasteChord(e)) return;
    if (!keyForPage(e)) return;
    e.preventDefault();
    e.stopPropagation();
    queue.push(keyDown(e));
    if (isCopyChord(e)) {
      void queue.drained().then(() => {
        copyFromBrowser(surface).catch((err: unknown) => {
          setBrowserError(surface, err);
        });
      });
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || isPasteChord(e) || !keyForPage(e)) return;
    e.stopPropagation();
    queue.push(keyUp(e));
  };

  const leave = useCallback(() => {
    sink.current?.focus({ preventScroll: true });
  }, []);

  const scale = page.current.width > 0 && box.current ? { x: box.current.clientWidth / page.current.width, y: box.current.clientHeight / page.current.height } : { x: 1, y: 1 };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="browser-surface">
      <BrowserToolbar surface={surface} state={state} onLeave={leave} />
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-white">
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full"
          data-testid="browser-canvas"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={(e) => {
            mouse(e, "mouseMoved", 0);
          }}
          onWheel={onWheel}
          onContextMenu={(e) => {
            e.preventDefault();
          }}
        />
        <div data-chord-yield="" className="pointer-events-none absolute top-0 left-0 size-px overflow-hidden opacity-0">
          <textarea
            ref={sink}
            tabIndex={-1}
            aria-label="Page input"
            data-testid="browser-input"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              if (text) {
                pasteToBrowser(surface, text).catch((err: unknown) => {
                  setBrowserError(surface, err);
                });
              }
            }}
            onChange={(e) => {
              // What a composition or a dead key finished: everything else never gets here.
              const text = e.target.value;
              e.target.value = "";
              if (text) queue.push({ kind: "text", text });
            }}
          />
        </div>
        <BrowserOverlays
          surface={surface}
          state={state}
          error={error}
          offline={offline}
          scale={scale}
          onDismissError={() => {
            setBrowserError(surface, null);
          }}
        />
      </div>
    </div>
  );
}
