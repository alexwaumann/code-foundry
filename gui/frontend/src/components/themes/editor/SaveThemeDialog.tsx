import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useColorScheme, useThemeSlots } from "@/lib/theme";
import { fixSlotContrast, saveEdits, setSaveOpen, unpinSlot, useEditorAnalysis, useThemeEditorStore } from "@/stores/themeEditor";
import { themeById } from "@/themes";
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
 * Save. Saving with problems is allowed.
 */
function SaveBody() {
  const draft = useThemeEditorStore((s) => s.draft);
  const saving = useThemeEditorStore((s) => s.saving);
  const analysis = useEditorAnalysis();
  const inUse = useColorScheme();
  const slots = useThemeSlots();
  const [name, setName] = useState(draft?.name ?? "");
  const [apply, setApply] = useState(draft?.scheme === inUse);
  if (!draft || !analysis) return null;
  const isSlot = slots[draft.scheme] === draft.id;
  const from = draft.from ? (themeById.get(draft.from)?.name ?? draft.from) : "";
  // One line per failing slot, at its worst pair.
  const failing = [...analysis.failing.entries()].map(([slot, rows]) => ({ slot, worst: rows.reduce((a, b) => (b.ratio / b.required < a.ratio / a.required ? b : a)) }));
  const problems = failing.length + analysis.stale.length;
  const save = () => {
    void saveEdits({ name, apply: apply && !isSlot });
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
            <Input
              id="theme-save-name"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
              }}
              data-testid="theme-save-name"
            />
          </div>
          <DialogDescription className="text-caption">
            {from ? `From ${from} · ` : ""}
            {draft.scheme} · {analysis.pinned} {analysis.pinned === 1 ? "slot" : "slots"} pinned
          </DialogDescription>
          {problems > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-cf-divider p-2.5" data-testid="theme-save-problems">
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {failing.map(({ slot, worst }) => (
                  <li key={slot} className="flex items-center gap-2 text-body-sm" data-testid="theme-save-contrast">
                    <MarkBadge tone="error">{ratioText(worst.ratio)}</MarkBadge>
                    <span className="min-w-0 flex-1 line-clamp-2">
                      {shortName(slot)} on {shortName(worst.against)}
                    </span>
                    <Button type="button" variant="link" size="xs" className="px-1" onClick={() => { fixSlotContrast(slot); }} data-testid="theme-save-fix">
                      Fix
                    </Button>
                  </li>
                ))}
                {analysis.stale.map((p) => (
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
              <p className="text-caption-sm">You can save anyway.</p>
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
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setSaveOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim()} data-testid="theme-save-submit">
              {apply && !isSlot ? "Save and apply" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
