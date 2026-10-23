import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useColorScheme, useThemeSlots } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { draftRefusal, fixSlotContrast, saveEdits, setSaveOpen, unpinSlot, useEditorAnalysis, useThemeEditorStore } from "@/stores/themeEditor";
import { askForTheme } from "@/stores/themeCards";
import { themeById, userThemes } from "@/themes";
import { fixContrast, type ContrastFix } from "@/themes/contrast";
import { MarkBadge } from "./ThemeInspector";
import { ratioText, shortName } from "./model";

/** The Save… modal (sketch F), while the editor asks for it. */
export function SaveThemeDialog() {
  const open = useThemeEditorStore((s) => s.saveOpen);
  if (!open) return null;
  return <SaveBody />;
}

/**
 * Name (a rename keeps the id), where the theme is from, its problems with one-click
 * fixes (a failing pair's Fix, a stale pin's Re-derive), "Use as my … theme now", and
 * Save. Saving with contrast problems or stale pins is allowed; with what theme.save
 * would refuse (draftRefusal: a surface its scheme cannot carry, a name it does not take)
 * Save is held and says why.
 */
function SaveBody() {
  const draft = useThemeEditorStore((s) => s.draft);
  const saving = useThemeEditorStore((s) => s.saving);
  const analysis = useEditorAnalysis();
  const inUse = useColorScheme();
  const slots = useThemeSlots();
  const [name, setName] = useState(draft?.name ?? "");
  const [apply, setApply] = useState(draft?.scheme === inUse);
  const [pair, setPair] = useState(false);
  // What each failing slot's Fix would do, once per draft: a slot no value mends says so instead.
  const fixes = useMemo(() => (draft && analysis && analysis.refusal?.kind !== "scheme" ? new Map([...analysis.failing.keys()].map((slot) => [slot, fixContrast(draft, slot)])) : new Map<string, ContrastFix | null>()), [draft, analysis]);
  if (!draft || !analysis) return null;
  // A theme with no pair yet can ask the model for one (theme.ask --pair) once it is saved.
  const other = draft.scheme === "dark" ? "light" : "dark";
  const canPair = !draft.pair;
  const isSlot = slots[draft.scheme] === draft.id;
  const from = draft.from ? (themeById.get(draft.from)?.name ?? draft.from) : "";
  // What theme.save would refuse, with the name being typed: no "save anyway" for that.
  const refusal = draftRefusal(draft, name.trim() || draft.name);
  const nameLength = Array.from(name.trim()).length;
  const sameName = name.trim() !== "" && userThemes().some((t) => t.id !== draft.id && t.name.trim().toLowerCase() === name.trim().toLowerCase());
  // One line per failing slot, at its worst pair. A surface its scheme cannot carry fails most pairs: only that is listed.
  const failing = refusal?.kind === "scheme" ? [] : [...analysis.failing.entries()].map(([slot, rows]) => ({ slot, worst: rows.reduce((a, b) => (b.ratio / b.required < a.ratio / a.required ? b : a)) }));
  const stale = refusal?.kind === "scheme" ? [] : analysis.stale;
  const problems = failing.length + stale.length + (refusal ? 1 : 0);
  const save = () => {
    if (refusal) return;
    const id = draft.id;
    void saveEdits({ name, apply: apply && !isSlot }).then((ok) => {
      if (ok && pair && canPair) void askForTheme("", id);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) setSaveOpen(false);
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="theme-save-dialog">
        <DialogTitle className="text-title">Save {draft.name}</DialogTitle>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="theme-save-name">Name</Label>
            {/* No maxLength: a longer paste would be cut without a word; the count and the refusal say so instead. */}
            <Input
              id="theme-save-name"
              value={name}
              aria-invalid={refusal?.kind === "file" || undefined}
              onChange={(e) => {
                setName(e.target.value);
              }}
              data-testid="theme-save-name"
            />
            {(sameName || nameLength > 60) && (
              <p className="flex gap-2 text-caption-sm" data-testid="theme-save-name-hint">
                {sameName && <span>Another of your themes is called this.</span>}
                {nameLength > 60 && <span className={cn("ml-auto", nameLength > 80 && "text-cf-error-text")}>{nameLength}/80</span>}
              </p>
            )}
          </div>
          <DialogDescription className="text-caption">
            {from ? `From ${from} · ` : ""}
            {draft.scheme} · {analysis.pinned} {analysis.pinned === 1 ? "slot" : "slots"} pinned
          </DialogDescription>
          {problems > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-cf-divider p-2.5" data-testid="theme-save-problems">
              {refusal && (
                <p className="text-body-sm text-cf-error-text" role="alert" data-testid="theme-save-refusal">
                  {refusal.kind === "file" ? `Cannot save: ${refusal.message}` : refusal.message}
                </p>
              )}
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {failing.map(({ slot, worst }) => {
                  const fix = fixes.get(slot);
                  return (
                    <li key={slot} className="flex items-center gap-2 text-body-sm" data-testid="theme-save-contrast">
                      <MarkBadge tone="error">{ratioText(worst.ratio)}</MarkBadge>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2">
                          {shortName(slot)} on {shortName(worst.against)}
                        </span>
                        {fix?.kind === "none" && (
                          <span className="block text-caption-sm" data-testid="theme-save-unfixable">
                            {fix.reason === "unreachable"
                              ? `No colour on ${shortName(fix.against)} reaches ${String(fix.required)}:1; change the surface or the base colour.`
                              : "Fixing it here makes more pairs fail (colours derived from it move too); change the base colour instead."}
                          </span>
                        )}
                      </span>
                      {fix && fix.kind !== "none" && (
                        <Button type="button" variant="link" size="xs" className="px-1" onClick={() => { fixSlotContrast(slot); }} data-testid="theme-save-fix">
                          Fix
                        </Button>
                      )}
                    </li>
                  );
                })}
                {stale.map((p) => (
                  <li key={p.slot} className="flex items-center gap-2 text-body-sm" data-testid="theme-save-stale">
                    <MarkBadge tone="warning">stale</MarkBadge>
                    <span className="min-w-0 flex-1 line-clamp-2">
                      {shortName(p.slot)} pinned before the base changed
                    </span>
                    <Button type="button" variant="link" size="xs" className="px-1" onClick={() => { unpinSlot(p.slot); }} data-testid="theme-save-rederive">
                      Re-derive
                    </Button>
                  </li>
                ))}
              </ul>
              {!refusal && <p className="text-caption-sm">You can save anyway.</p>}
            </div>
          ) : (
            <p className="text-caption" data-testid="theme-save-clean">
              Every contrast pair reads, and no pin is stale.
            </p>
          )}
          {isSlot ? (
            <p className="text-caption">It is your {draft.scheme} theme: the window repaints when it is saved.</p>
          ) : (
            <Label className="flex items-center gap-2 text-body-sm font-normal">
              <Checkbox checked={apply} onCheckedChange={(v) => { setApply(v === true); }} data-testid="theme-save-apply" />
              Use as my {draft.scheme} theme now
            </Label>
          )}
          {canPair && (
            <Label className="flex items-center gap-2 text-body-sm font-normal">
              <Checkbox checked={pair} onCheckedChange={(v) => { setPair(v === true); }} data-testid="theme-save-pair" />
              Also make a {other} pair
              <span className="text-caption text-cf-text-muted">(a thread makes it)</span>
            </Label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setSaveOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim() || refusal !== null} data-testid="theme-save-submit">
              {apply && !isSlot ? "Save and apply" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
