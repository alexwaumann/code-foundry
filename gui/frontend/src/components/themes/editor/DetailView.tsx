import { useMemo, type ReactNode } from "react";
import { Check, ChevronLeft, Pin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  BASE_FALLBACK,
  baseValue,
  editorBack,
  OPTIONAL_BASE,
  pinSlot,
  resetSlotToDerived,
  setBaseColour,
  unpinSlot,
  useEditorAnalysis,
  useThemeEditorStore,
  type BaseKey,
} from "@/stores/themeEditor";
import { slotContrast, withoutPin } from "@/themes/contrast";
import { SLOTS } from "@/themes/slots";
import { SLOT_USES } from "@/themes/slotUses";
import { themeOf, type Theme } from "@/themes";
import { ColourPicker } from "./ColourPicker";
import { baseMeta, ratioText, shortName } from "./model";
import { SlotSample } from "./SlotSample";

const TINT = /^#[0-9a-f]{8}$/;

/** The view's top line: "‹ Slots" (or "‹ Base") and the group. */
function BackLine({ label, group }: { label: string; group: string }) {
  return (
    <div className="flex items-center gap-2 px-2 pt-2">
      <Button variant="ghost" size="xs" className="gap-0.5 px-1 text-cf-text-muted hover:text-cf-text" onClick={() => editorBack()} data-testid="editor-back">
        <ChevronLeft />
        {label}
      </Button>
      <span className="ml-auto pr-1 text-overline">{group}</span>
    </div>
  );
}

/** One side of the derived/yours comparison: its label and hex over the sample. */
function Compare({ label, value, theme, slot, chosen, testId }: { label: string; value: string; theme: Theme; slot: string; chosen?: boolean; testId: string }) {
  return (
    <div className={cn("min-w-0 flex-1 space-y-1 rounded-lg border p-1.5", chosen ? "border-cf-focus" : "border-cf-divider")} data-testid={testId}>
      <p className="truncate text-caption-sm">
        {label} · <span className="text-code">{value}</span>
      </p>
      <SlotSample theme={theme} slot={slot} />
    </div>
  );
}

/** The contrast pairs a slot is in, with ratios and pass/fail (CONTRAST_PAIRS). */
function PairList({ slots, slot }: { slots: Readonly<Record<string, string>>; slot: string }) {
  const rows = slotContrast(slots, slot);
  return (
    <div className="space-y-1" data-testid="editor-pairs">
      <p className="text-overline">Contrast</p>
      {rows.length === 0 && <p className="text-caption">No contrast pair checks this colour.</p>}
      {rows.map((r) => {
        const words = r.slot === slot ? `on ${shortName(r.against)}${r.over ? ` over ${shortName(r.over)}` : ""}` : `${shortName(r.slot)} on it`;
        return (
          <div key={r.label} className="flex items-baseline gap-2 text-caption" data-pass={r.pass}>
            <span className="min-w-0 flex-1 truncate">{words}</span>
            <span className={cn("shrink-0 text-code", r.pass ? "text-cf-success-text" : "text-cf-error-text")}>
              {ratioText(r.ratio)} {r.pass ? <Check className="inline size-3" aria-label="passes" /> : <X className="inline size-3" aria-label="fails" />}
            </span>
            <span className="w-10 shrink-0 text-right text-caption-sm">≥{r.required}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A slot's view (sketch E): its rule and uses, derived beside yours on the surface it sits
 * on, the picker (any change pins it), the pairs it is checked in, Reset to derived and
 * Unpin. Escape (or ‹ Slots) goes back to the list.
 */
export function SlotView({ name }: { name: string }) {
  const analysis = useEditorAnalysis();
  const draft = useThemeEditorStore((s) => s.draft);
  const slot = SLOTS.find((s) => s.name === name);
  const derivedTheme = useMemo(() => (draft ? themeOf(withoutPin(draft, name)) : null), [draft, name]);
  if (!analysis || !draft || !slot || !derivedTheme) return null;
  const value = analysis.slots[name] ?? "";
  const derived = derivedTheme.slots[name] ?? "";
  const pinned = draft.overrides?.[name] !== undefined;
  const stale = analysis.staleBySlot.get(name);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="slot-view" data-slot={name}>
      <BackLine label="Slots" group={slot.group} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pt-1 pb-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-subheading" data-testid="slot-view-name">
            {shortName(name)}
            {pinned && <Pin className="size-3.5 text-cf-accent-surface-foreground" aria-label="pinned" />}
          </h2>
          <p className="text-caption">Rule: {slot.rule}.</p>
          <p className="text-caption">Used by {SLOT_USES[name] ?? "nothing in the app"}.</p>
          {stale && (
            <p className="text-caption text-cf-warning-text" data-testid="slot-view-stale">
              Stale: pinned when it derived {stale.basis}; it would now derive {stale.derived}.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Compare label="Derived" value={derived} theme={derivedTheme} slot={name} chosen={!pinned} testId="slot-view-derived" />
          {pinned ? (
            <Compare label="Yours" value={value} theme={analysis.theme} slot={name} chosen testId="slot-view-yours" />
          ) : (
            <p className="flex min-w-0 flex-1 items-center rounded-lg border border-dashed border-cf-divider p-2 text-caption">Change the colour below to pin it.</p>
          )}
        </div>
        <ColourPicker
          key={name}
          label={shortName(name)}
          value={value}
          tint={TINT.test(derived) || TINT.test(value)}
          onChange={(hex) => {
            pinSlot(name, hex);
          }}
          onEscape={() => editorBack()}
        />
        <PairList slots={analysis.slots} slot={name} />
        {pinned && (
          <div className="flex gap-2">
            <Button variant="outline" size="xs" onClick={() => { resetSlotToDerived(name); }} data-testid="slot-reset">
              Reset to derived
            </Button>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => { unpinSlot(name); }} data-testid="slot-unpin">
              Unpin
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A base colour's view: the picker, what the rules make of it (the slot it becomes, which
 * may be stepped for contrast), saved beside yours when it changed, and that slot's pairs.
 * An optional one (link, the terminal's cursor, cursor text and selection) can be cleared.
 */
export function BaseView({ baseKey }: { baseKey: BaseKey }) {
  const analysis = useEditorAnalysis();
  const draft = useThemeEditorStore((s) => s.draft);
  const saved = useThemeEditorStore((s) => s.saved);
  const savedTheme = useMemo(() => (saved ? themeOf(saved) : null), [saved]);
  if (!analysis || !draft || !saved || !savedTheme) return null;
  const meta = baseMeta(baseKey);
  const value = baseValue(draft.base, baseKey);
  const was = baseValue(saved.base, baseKey);
  const resolved = analysis.slots[meta.slot] ?? "";
  const shown = value ?? resolved;
  const optional = OPTIONAL_BASE.has(baseKey);
  let note: ReactNode = null;
  if (value === undefined) note = <>Not set: {BASE_FALLBACK[baseKey] ?? "derived"} ({resolved}). Change it to set it.</>;
  else if (resolved && resolved !== value && !TINT.test(resolved))
    note = (
      <>
        The rules make {shortName(meta.slot)} <span className="text-code">{resolved}</span> from it (held to its contrast).
      </>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="base-view" data-base={baseKey}>
      <BackLine label="Base" group="base" />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pt-1 pb-3">
        <div>
          <h2 className="text-subheading" data-testid="base-view-name">
            {meta.label}
          </h2>
          <p className="text-caption">Paints {meta.hint}; every slot derived from it follows (pins keep their values).</p>
          {note && <p className="text-caption">{note}</p>}
        </div>
        {was !== value && (
          <div className="flex gap-2">
            <Compare label="Saved" value={was ?? "not set"} theme={savedTheme} slot={meta.slot} testId="base-view-saved" />
            <Compare label="Yours" value={value ?? "not set"} theme={analysis.theme} slot={meta.slot} chosen testId="base-view-yours" />
          </div>
        )}
        <ColourPicker
          key={baseKey}
          label={meta.label}
          value={shown.length === 9 ? shown.slice(0, 7) : shown}
          onChange={(hex) => {
            setBaseColour(baseKey, hex);
          }}
          onEscape={() => editorBack()}
        />
        {meta.slot && <PairList slots={analysis.slots} slot={meta.slot} />}
        {optional && value !== undefined && (
          <Button variant="ghost" size="xs" onClick={() => { setBaseColour(baseKey, undefined); }} data-testid="base-clear">
            Clear ({BASE_FALLBACK[baseKey]})
          </Button>
        )}
      </div>
    </div>
  );
}
