import type { ReactNode } from "react";
import { ChevronRight, Pin, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { Tip } from "@/components/ui/tooltip";
import {
  BASE_FALLBACK,
  baseValue,
  setBaseColour,
  setEditorFilter,
  setPinnedOnly,
  showEditorView,
  toggleEditorGroup,
  useEditorAnalysis,
  useThemeEditorStore,
  type BaseKey,
  type EditorAnalysis,
} from "@/stores/themeEditor";
import { SLOT_GROUPS, SLOTS, type Slot, type SlotGroup } from "@/themes/slots";
import { SLOT_USES } from "@/themes/slotUses";
import { BaseView, SlotView } from "./DetailView";
import { ansiKey, baseMeta, ratioText, shortName, TONE_KEYS } from "./model";
import { Swatch } from "./Swatch";

const GROUP_LABEL: Record<SlotGroup, string> = {
  surfaces: "Surfaces",
  text: "Text",
  interactive: "Interactive",
  sidebar: "Sidebar",
  thread: "Thread",
  status: "Status",
  diff: "Diff",
  charts: "Charts",
  terminal: "Terminal",
  syntax: "Syntax",
};

/** Every slot by group, in the registry's order. */
const BY_GROUP: readonly (readonly [SlotGroup, readonly Slot[]])[] = SLOT_GROUPS.map((g) => [g, SLOTS.filter((s) => s.group === g)]);

/**
 * The editor's inspector (sketch D), between the theme list and the gallery: the base
 * colours, then every slot by group with its rule, value, pin, stale and contrast marks.
 * A row opens its colour's view (sketch E) in place of the lists.
 */
export function ThemeInspector() {
  const view = useThemeEditorStore((s) => s.view);
  const analysis = useEditorAnalysis();
  if (!analysis) return null;
  return (
    <div className="flex w-[340px] shrink-0 flex-col border-r border-cf-divider" data-testid="theme-inspector" aria-label="Theme editor">
      {view.kind === "slot" ? (
        <SlotView key={view.name} name={view.name} />
      ) : view.kind === "base" ? (
        <BaseView key={view.key} baseKey={view.key} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          <BaseSection analysis={analysis} />
          <SlotsSection analysis={analysis} />
        </div>
      )}
    </div>
  );
}

function SectionHeading({ heading, note, children }: { heading: string; note?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <p className="text-overline">
        {heading}
        {note && <span className="normal-case"> · {note}</span>}
      </p>
      <span className="ml-auto flex items-center gap-1">{children}</span>
    </div>
  );
}

function BaseSection({ analysis }: { analysis: EditorAnalysis }) {
  const draft = useThemeEditorStore((s) => s.draft);
  const terminalOpen = useThemeEditorStore((s) => s.open["terminal-base"] ?? false);
  if (!draft) return null;
  const base = draft.base;
  return (
    <section aria-label="Base colours" data-testid="editor-base">
      <SectionHeading heading="Base" note="what the theme supplies" />
      <div className="px-1.5">
        {(["canvas", "surface", "text", "accent"] as const).map((k) => (
          <BaseRow key={k} baseKey={k} value={base[k]} />
        ))}
        <div className="flex min-h-9 items-center gap-1 rounded-md px-1.5" data-testid="editor-base-tones">
          {TONE_KEYS.map((k) => (
            <Tip key={k} label={`${baseMeta(k).label} · ${base[k]}`}>
              <button
                type="button"
                className="rounded-sm p-0.5 outline-none hover:bg-cf-control-hover focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
                aria-label={`${baseMeta(k).label} ${base[k]}`}
                onClick={() => {
                  showEditorView({ kind: "base", key: k });
                }}
                data-testid={`editor-base-${k}`}
              >
                <Swatch value={base[k]} className="size-5" />
              </button>
            </Tip>
          ))}
          <span className="ml-1 min-w-0 truncate text-caption-sm">Success · Warning · Error · Info · Highlight</span>
        </div>
        <BaseRow baseKey="link" value={base.link} fallback={analysis.slots["--cf-link"]} />
        <Collapsible
          open={terminalOpen}
          onOpenChange={(open) => {
            toggleEditorGroup("terminal-base", open);
          }}
        >
          <CollapsibleTrigger asChild>
            <button type="button" className="group/t flex min-h-9 w-full items-center gap-2.5 rounded-md px-1.5 text-left outline-none hover:bg-cf-control-hover focus-visible:ring-[3px] focus-visible:ring-cf-focus/50" data-testid="editor-base-terminal">
              <Swatch value={base.terminal.foreground} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body-sm">Terminal</span>
                <span className="truncate text-caption-sm">foreground, cursor, selection, 16 ANSI</span>
              </span>
              <ChevronRight className="size-3.5 text-cf-icon-muted transition-transform group-aria-expanded/t:rotate-90" aria-hidden />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {(["terminal.foreground", "terminal.cursor", "terminal.cursorText", "terminal.selection"] as const).map((k) => (
              <BaseRow key={k} baseKey={k} value={baseValue(base, k)} fallback={analysis.slots[baseMeta(k).slot]} indent />
            ))}
            <div className="grid grid-cols-8 gap-1 py-1.5 pr-1.5 pl-7" data-testid="editor-base-ansi">
              {base.terminal.ansi.map((c, n) => (
                <Tip key={n} label={`${baseMeta(ansiKey(n)).label} · ${baseMeta(ansiKey(n)).hint} · ${c}`}>
                  <button
                    type="button"
                    className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
                    aria-label={`ANSI ${String(n)} ${c}`}
                    onClick={() => {
                      showEditorView({ kind: "base", key: ansiKey(n) });
                    }}
                  >
                    <Swatch value={c} className="h-5 w-full" />
                  </button>
                </Tip>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  );
}

/** A base colour's row: swatch, name, what it paints (or what it falls back to), hex; an optional one can be cleared. */
function BaseRow({ baseKey, value, fallback, indent }: { baseKey: BaseKey; value: string | undefined; fallback?: string; indent?: boolean }) {
  const meta = baseMeta(baseKey);
  const absent = value === undefined;
  const hint = absent ? (BASE_FALLBACK[baseKey] ?? meta.hint) : meta.hint;
  return (
    <div className={cn("group/b flex min-h-9 items-center rounded-md hover:bg-cf-control-hover", indent && "pl-5")}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
        onClick={() => {
          showEditorView({ kind: "base", key: baseKey });
        }}
        data-testid={`editor-base-${baseKey}`}
      >
        <Swatch value={value ?? fallback} className={cn(absent && "opacity-60")} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-sm">{meta.label}</span>
          <span className="truncate text-caption-sm">{hint}</span>
        </span>
        <span className={cn("text-code text-cf-text-muted", absent && "opacity-60")}>{value ?? fallback}</span>
      </button>
      {!absent && BASE_FALLBACK[baseKey] && (
        <Tip label={`Clear (${BASE_FALLBACK[baseKey] ?? ""})`}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="mr-1 text-cf-text-muted"
            aria-label={`Clear ${meta.label}`}
            onClick={() => {
              setBaseColour(baseKey, undefined);
            }}
          >
            <X />
          </Button>
        </Tip>
      )}
    </div>
  );
}

function SlotsSection({ analysis }: { analysis: EditorAnalysis }) {
  const filter = useThemeEditorStore((s) => s.filter);
  const pinnedOnly = useThemeEditorStore((s) => s.pinnedOnly);
  const overrides = useThemeEditorStore((s) => s.draft?.overrides);
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (s: Slot) => {
    if (pinnedOnly && overrides?.[s.name] === undefined) return false;
    if (words.length === 0) return true;
    const hay = `${s.name} ${s.group} ${s.rule} ${SLOT_USES[s.name] ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const groups = BY_GROUP.map(([g, slots]) => [g, slots.filter(visible)] as const).filter(([, slots]) => slots.length > 0);
  return (
    <section aria-label="Slots" data-testid="editor-slots">
      <SectionHeading heading="Slots">
        <span className="text-caption-sm" data-testid="editor-slots-summary">
          {analysis.pinned} pinned
          {analysis.stale.length > 0 && (
            <>
              {" · "}
              <span className="text-cf-warning-text">{analysis.stale.length} stale</span>
            </>
          )}
          {analysis.report.length > 0 && (
            <>
              {" · "}
              <span className="text-cf-error-text">{new Set(analysis.report.map((r) => r.slot)).size} contrast</span>
            </>
          )}
        </span>
      </SectionHeading>
      <div className="flex items-center gap-1.5 px-3 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-cf-icon-muted" aria-hidden />
          <Input
            type="search"
            aria-label="Filter slots"
            placeholder={`Filter ${String(SLOTS.length)} slots`}
            value={filter}
            onChange={(e) => {
              setEditorFilter(e.target.value);
            }}
            className="h-7 pl-7 text-body-sm"
            data-testid="editor-filter"
          />
        </div>
        <Toggle variant="outline" size="xs" pressed={pinnedOnly} onPressedChange={setPinnedOnly} aria-label="Pinned only" data-testid="editor-pinned-only">
          <Pin />
          Pinned only
        </Toggle>
      </div>
      {groups.length === 0 && <p className="px-3 py-2 text-caption">{pinnedOnly ? "No slot is pinned. Change a slot's colour to pin it." : `No slot matches “${filter}”.`}</p>}
      <div className="px-1.5">
        {groups.map(([g, slots]) => (
          <SlotGroupSection key={g} group={g} slots={slots} analysis={analysis} forceOpen={words.length > 0 || pinnedOnly} />
        ))}
      </div>
    </section>
  );
}

function SlotGroupSection({ group, slots, analysis, forceOpen }: { group: SlotGroup; slots: readonly Slot[]; analysis: EditorAnalysis; forceOpen: boolean }) {
  const open = useThemeEditorStore((s) => s.open[group] ?? true);
  const contrastCount = slots.filter((s) => analysis.failing.has(s.name)).length;
  const staleCount = slots.filter((s) => analysis.staleBySlot.has(s.name)).length;
  return (
    <Collapsible
      open={open || forceOpen}
      onOpenChange={(o) => {
        toggleEditorGroup(group, o);
      }}
      data-testid={`editor-group-${group}`}
    >
      <CollapsibleTrigger asChild>
        <button type="button" className="group/g flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-cf-control-hover focus-visible:ring-[3px] focus-visible:ring-cf-focus/50">
          <ChevronRight className="size-3 text-cf-icon-muted transition-transform group-aria-expanded/g:rotate-90" aria-hidden />
          <span className="text-overline">
            {GROUP_LABEL[group]} · {slots.length}
          </span>
          <span className="ml-auto flex gap-1">
            {staleCount > 0 && <MarkBadge tone="warning">{staleCount} stale</MarkBadge>}
            {contrastCount > 0 && <MarkBadge tone="error">{contrastCount} contrast</MarkBadge>}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {slots.map((s) => (
          <SlotRow key={s.name} slot={s} analysis={analysis} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A small tinted mark: stale (warning) or a contrast ratio (error). */
export function MarkBadge({ tone, children, testId }: { tone: "warning" | "error"; children: ReactNode; testId?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent px-1.5 py-0 text-caption-sm font-medium", tone === "warning" ? "bg-cf-warning-surface text-cf-warning-text" : "bg-cf-error-surface text-cf-error-text")} data-testid={testId}>
      {children}
    </Badge>
  );
}

function SlotRow({ slot, analysis }: { slot: Slot; analysis: EditorAnalysis }) {
  const pinned = useThemeEditorStore((s) => s.draft?.overrides?.[slot.name] !== undefined);
  const value = analysis.slots[slot.name] ?? "";
  const stale = analysis.staleBySlot.get(slot.name);
  const failing = analysis.failing.get(slot.name);
  const worst = failing?.reduce((a, b) => (b.ratio / b.required < a.ratio / a.required ? b : a));
  const line = stale ? `pinned · would now derive ${stale.derived}` : pinned ? `pinned · ${slot.rule}` : slot.rule;
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left outline-none hover:bg-cf-control-hover focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
      onClick={() => {
        showEditorView({ kind: "slot", name: slot.name });
      }}
      data-testid={`editor-slot-${shortName(slot.name)}`}
      data-pinned={pinned || undefined}
      data-stale={stale ? true : undefined}
    >
      <Swatch value={value} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-body-sm">{shortName(slot.name)}</span>
          {pinned && <Pin className="size-3 shrink-0 text-cf-accent-surface-foreground" aria-label="pinned" data-testid="slot-pin" />}
          {stale && <MarkBadge tone="warning">stale</MarkBadge>}
          {worst && (
            <MarkBadge tone="error" testId="slot-contrast">
              {ratioText(worst.ratio)}
            </MarkBadge>
          )}
        </span>
        <span className="truncate text-caption-sm">{line}</span>
      </span>
      <span className="shrink-0 text-code text-cf-text-muted">{value}</span>
    </button>
  );
}
