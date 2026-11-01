import { Loader2, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { DictationMic, DictationNote } from "@/components/compose/DictationMic";
import { useComposerDictation } from "@/components/compose/useComposerDictation";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import { LISTENING_PLACEHOLDER, phraseAtCaret } from "@/lib/dictation";
import { cn } from "@/lib/utils";
import { composerKeyAction } from "./keys";

/**
 * Sizes the textarea to its text, from its 3 rows up to its max-height (6 rows), past
 * which it scrolls. Height includes the border (border-box).
 */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${String(el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
}

export interface PanelComposerSubmit {
  label: string;
  /** When the visible label alone is ambiguous ("Approve #139"). */
  ariaLabel?: string;
  icon: LucideIcon;
  className: string;
  disabled: boolean;
  /** A spinner in place of the icon, and aria-busy. */
  busy: boolean;
}

/** data-testids of the composer's parts (the e2e and unit tests use each composer's own). */
export interface PanelComposerTestIds {
  root: string;
  label?: string;
  input: string;
  hint: string;
  cancel: string;
  submit: string;
}

/**
 * The inline composer under the PR header, shared by Ask a question (PrAskComposer) and
 * the review (PrReviewComposer): a label, a textarea of 3 rows growing to 6, then a hint,
 * a quiet Cancel and the submit button.
 *
 * Keys (composerKeyAction): `submitKey` "enter" sends on Enter, "cmd-enter" only on
 * cmd+Enter; Escape cancels unless `locked`. Both are kept from the panel's keys.
 * `onSubmit` is the caller's send (it guards against blank text and running sends): when
 * it resolves true the composer closes. Closing (Cancel, Escape, a successful submit)
 * calls `onClose` and hands focus to the panel so its keys keep working.
 *
 * `locked`: the caller's own send runs; the field is read-only and Cancel and Escape do
 * nothing (the command goes through either way). `focusRequest`: bumped by the surface
 * each time the composer is chosen, so choosing it again moves focus back into it.
 * Element ids come from useId, so two panels can show a composer at once.
 */
export function PanelComposer({
  ariaLabel,
  className,
  label,
  labelClassName,
  text,
  onTextChange,
  placeholder,
  hint,
  hintIsStatus,
  submitKey,
  submit,
  onSubmit,
  locked,
  focusRequest,
  onClose,
  testIds,
  dataAttrs,
}: {
  ariaLabel: string;
  className?: string;
  label: ReactNode;
  labelClassName?: string;
  text: string;
  onTextChange: (text: string) => void;
  placeholder: string;
  hint: string;
  /** The hint reports a state (another surface is sending): role=status. */
  hintIsStatus?: boolean;
  submitKey: "enter" | "cmd-enter";
  submit: PanelComposerSubmit;
  onSubmit: () => Promise<boolean>;
  locked: boolean;
  focusRequest: number;
  onClose: () => void;
  testIds: PanelComposerTestIds;
  dataAttrs?: Record<`data-${string}`, string>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const hintId = useId();
  const rootRef = useRef<HTMLElement>(null);
  // The latest text and submit: a dictated phrase and Send's wait for it outlive a render.
  const latest = useRef({ text, onTextChange, onSubmit });
  useLayoutEffect(() => {
    latest.current = { text, onTextChange, onSubmit };
  });
  // Where the caret goes once a dictated phrase is in the text.
  const caretAfter = useRef<number | null>(null);
  const dictation = useComposerDictation({
    draftKey: testIds.root,
    rootRef,
    primary: false,
    insert: (phrase) => {
      const el = ref.current;
      const value = latest.current.text;
      const start = el && document.activeElement === el ? el.selectionStart : value.length;
      const end = el && document.activeElement === el ? el.selectionEnd : value.length;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nl = value.indexOf("\n", end);
      const ins = phraseAtCaret(phrase, value.slice(lineStart, start), value.slice(end, nl === -1 ? undefined : nl));
      if (ins === "") return;
      caretAfter.current = start + ins.length;
      latest.current.onTextChange(value.slice(0, start) + ins + value.slice(end));
    },
  });

  // After the menu closes (it does not take focus back to its button for these items).
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => {
      cancelAnimationFrame(id);
    };
  }, [focusRequest]);

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
    const at = caretAfter.current;
    caretAfter.current = null;
    if (at !== null && ref.current && document.activeElement === ref.current) ref.current.setSelectionRange(at, at);
  }, [text]);

  /** Closes, handing focus to the panel so its keys keep working. */
  const close = () => {
    const panel = ref.current?.closest<HTMLElement>('[data-region="panel"]');
    onClose();
    panel?.focus();
  };

  const send = async () => {
    if (dictation.phase) {
      // Dictating: stop, let the last phrase land (and render), then submit the text it made.
      await dictation.flush();
      await new Promise((r) => setTimeout(r, 0));
    }
    if (await latest.current.onSubmit()) close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        // Deprecated, but the only sign of WebKit's IME-confirming Enter (keys.ts).
        // oxlint-disable-next-line typescript/no-deprecated
        keyCode: e.nativeEvent.keyCode,
      },
      submitKey,
    );
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    // Escape while dictating stops it, and only that.
    if (action !== "send" && dictation.onEscape()) return;
    if (action === "send") void send();
    // Escape while the send runs does nothing: it goes through anyway.
    else if (!locked) close();
  };

  const SubmitIcon = submit.icon;
  return (
    <section ref={rootRef} className={cn("flex flex-col gap-2 border-b border-cf-divider px-4 py-3 @max-[340px]:px-3", className)} aria-label={ariaLabel} data-testid={testIds.root} {...dataAttrs}>
      <Label htmlFor={inputId} className={cn("gap-1.5 text-body-sm", labelClassName ?? "text-cf-text-muted")} data-testid={testIds.label}>
        {label}
      </Label>
      <Textarea
        id={inputId}
        ref={ref}
        rows={3}
        value={text}
        readOnly={locked}
        placeholder={dictation.listening ? LISTENING_PLACEHOLDER : placeholder}
        aria-describedby={hintId}
        className="max-h-[calc(6lh+1rem+2px)] min-h-0 resize-none overflow-y-auto text-body-sm read-only:opacity-70"
        data-testid={testIds.input}
        onChange={(e) => {
          onTextChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Tip label={hint} whenTruncated align="start">
          <span id={hintId} className="min-w-0 truncate text-caption-sm" role={hintIsStatus ? "status" : undefined} data-testid={testIds.hint}>
            {hint}
          </span>
        </Tip>
        <DictationMic dictation={dictation} disabled={locked} className="ml-auto" />
        <button
          type="button"
          disabled={locked}
          className={cn("shrink-0 rounded-md px-2 py-1 text-body-sm text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus disabled:opacity-50 disabled:hover:bg-transparent", dictation.availability === "hidden" && !dictation.phase && "ml-auto")}
          data-testid={testIds.cancel}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={submit.disabled && !(dictation.listening && !locked)}
          aria-busy={submit.busy || undefined}
          aria-label={submit.ariaLabel}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-body-sm font-medium whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-cf-focus disabled:opacity-50",
            submit.className,
          )}
          data-testid={testIds.submit}
          onClick={() => void send()}
        >
          {submit.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <SubmitIcon className="size-3.5" aria-hidden />}
          {submit.label}
        </button>
      </div>
      <DictationNote dictation={dictation} />
    </section>
  );
}
