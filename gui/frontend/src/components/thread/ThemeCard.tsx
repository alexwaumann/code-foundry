import { memo, useMemo, useState } from "react";
import { Check, Pencil, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { ThemeAa } from "@/components/themes/ThemeChip";
import { cn } from "@/lib/utils";
import { useSettingValue } from "@/stores/settings";
import { useThreadItem } from "@/stores/thread";
import { useThemesStore, useUserThemes } from "@/stores/themes";
import { applySavedTheme, editSavedTheme, themeUndoState, undoTheme, type ThemeUndoTarget } from "@/stores/themeCards";
import { contrastReport } from "@/themes/contrast";
import { themeById, themeOf, type Theme, type UserThemeFile } from "@/themes";
import { useThreadCtx } from "./context";

/** The nine base colours a card shows, in this order. */
const BASE = ["canvas", "surface", "text", "accent", "success", "warning", "error", "info", "highlight"] as const;

/**
 * A theme the thread saved (code-foundry theme save; docs/notes/theme-model-flow.md),
 * sketch C: the theme's "Aa", its name, "scheme · from <name>", an "applied" badge when
 * the save changed a slot, its nine base colours, and a footer with the pinned count, the
 * contrast check (computed here from the file as saved, as the editor does) and Undo /
 * Edit. The card shows the file as it was saved: a later save of the same id is another
 * card. Undo puts back what the slot showed just before this save, another theme or the
 * colours this save replaced, while the slot still shows this card's colours ("Undone"
 * once it is back; disabled, with why, when that is gone: stores/themeCards.ts);
 * Edit opens the Themes page's editor on the theme as it is now. A card saved without
 * applying has Apply instead (theme.set-<scheme>), while its scheme's slot is on another
 * theme; once the slot is on it, the badge shows (docs/notes/theme-followups.md).
 */
export const ThemeCardRow = memo(function ThemeCardRow({ id }: { id: string }) {
  const { threadId } = useThreadCtx();
  const item = useThreadItem(threadId, id);
  if (item?.kind !== "theme" || !item.theme) return null;
  const undo: ThemeUndoTarget = {
    scheme: item.theme.scheme,
    id: item.theme.id,
    previous: item.applied ? item.previous : "",
    version: item.previousVersion,
    gone: item.previousGone,
  };
  return <ThemeCard file={item.theme} applied={item.applied} undo={undo} />;
});

function ThemeCard({ file, applied, undo }: { file: UserThemeFile; applied: boolean; undo: ThemeUndoTarget }) {
  // The file as saved, resolved once: its slots paint the chip, its report the footer.
  const theme = useMemo<Theme>(() => themeOf(file), [file]);
  const issues = useMemo(() => contrastReport(file, theme.slots).length, [file, theme]);
  const pinned = Object.keys(file.overrides ?? {}).length;
  const from = file.from ? (themeById.get(file.from)?.name ?? file.from) : "";
  // A card saved without applying: applied once the slot is on the theme (its own Apply, or
  // any other way), and Apply again if the slot moves off it.
  const slot = useSettingValue(`appearance.theme_${file.scheme}`);
  const inUse = applied || slot === file.id;
  return (
    <div className="mt-1 mb-2.5 ml-1 max-w-md rounded-lg border border-cf-border bg-cf-surface-raised px-3 py-2.5" data-testid="thread-theme-card" data-theme-id={file.id}>
      <div className="flex min-w-0 items-center gap-2">
        <ThemeAa theme={theme} />
        <span className="truncate text-body-sm font-medium" data-testid="thread-theme-name">
          {file.name}
        </span>
        <span className="min-w-0 truncate text-caption text-cf-text-muted">
          {file.scheme}
          {from && ` · from ${from}`}
        </span>
        {inUse && (
          <Badge variant="secondary" className="ml-auto shrink-0 bg-cf-accent-surface px-1.5 py-0 text-cf-accent-surface-foreground" data-testid="thread-theme-applied">
            applied
          </Badge>
        )}
      </div>
      <div className="mt-2 flex gap-1" aria-hidden data-testid="thread-theme-swatches">
        {BASE.map((k) => (
          <span key={k} className="size-4 rounded-sm border border-cf-border" style={{ background: file.base[k] }} />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-caption text-cf-text-muted" data-testid="thread-theme-summary">
          {pinned} pinned ·{" "}
          {issues === 0 ? "contrast ok" : <span className="text-cf-warning-text">{issues === 1 ? "1 contrast issue" : `${String(issues)} contrast issues`}</span>}
        </span>
        {applied && undo.previous && <UndoButton undo={undo} saved={file} />}
        {!inUse && <ApplyButton scheme={file.scheme} id={file.id} />}
        <EditButton id={file.id} />
      </div>
    </div>
  );
}

/**
 * Undo (stores/themeCards.ts themeUndoState): what the slot showed just before this save
 * back; shown only while the slot still shows this card's colours; "Undone" (disabled) once
 * the slot is back on it; disabled with why when that is gone.
 */
function UndoButton({ undo, saved }: { undo: ThemeUndoTarget; saved: UserThemeFile }) {
  const slot = useSettingValue(`appearance.theme_${undo.scheme}`);
  // Re-renders when the user's themes or their kept versions change.
  useUserThemes();
  const history = useThemesStore((s) => s.history[undo.id]);
  const [busy, setBusy] = useState(false);
  const state = useMemo(() => themeUndoState(undo, saved, slot), [undo, saved, slot, history]); // eslint-disable-line react-hooks/exhaustive-deps -- history: the lookup reads it
  if (state.kind === "none" || state.kind === "hidden") return null;
  const undone = state.kind === "undone";
  return (
    <Tip label={state.tip}>
      {/* A disabled button takes no hover: the span carries the tooltip. */}
      <span className="inline-flex" data-testid="thread-theme-undo-tip">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-cf-text-muted"
          disabled={state.kind !== "undo" || busy}
          data-testid="thread-theme-undo"
          data-undo={state.kind}
          onClick={() => {
            setBusy(true);
            void undoTheme(undo).finally(() => {
              setBusy(false);
            });
          }}
        >
          <Undo2 aria-hidden />
          {undone ? "Undone" : "Undo"}
        </Button>
      </span>
    </Tip>
  );
}

/** Apply: the scheme's slot on the theme; disabled once it is no longer one of the user's themes. */
function ApplyButton({ scheme, id }: { scheme: UserThemeFile["scheme"]; id: string }) {
  useUserThemes();
  const [busy, setBusy] = useState(false);
  const gone = !themeById.get(id)?.user;
  return (
    <Button
      type="button"
      size="xs"
      disabled={gone || busy}
      data-testid="thread-theme-apply"
      onClick={() => {
        setBusy(true);
        void applySavedTheme(scheme, id).finally(() => {
          setBusy(false);
        });
      }}
    >
      <Check aria-hidden />
      Apply
    </Button>
  );
}

/** Edit: the editor on the theme; disabled once it is no longer one of the user's themes. */
function EditButton({ id }: { id: string }) {
  // Re-renders when the user's themes change (a deleted theme disables Edit).
  useUserThemes();
  const gone = !themeById.get(id)?.user;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn(gone && "text-cf-text-muted")}
      disabled={gone}
      data-testid="thread-theme-edit"
      onClick={() => {
        void editSavedTheme(id);
      }}
    >
      <Pencil aria-hidden />
      Edit
    </Button>
  );
}
