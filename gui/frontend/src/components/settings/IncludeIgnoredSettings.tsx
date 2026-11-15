import { useMemo, useState } from "react";
import type { SettingFieldView } from "@/api/settings";
import { AddPatternInput, PatternError, PatternRow } from "@/components/includes/PatternRows";
import { useIncludeSetting } from "@/components/includes/useIncludeSetting";
import { missingDefaults, parseIncludeSetting, restoreDefaults, restoreLabel, withoutPattern, withPattern } from "@/lib/includePatterns";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";
import type { EditorProps } from "./editor";
import type { SectionFields } from "./model";
import { SectionCard } from "./SectionCard";

/** The section's description (the field's own, longer one, is the CLI's and the search's). */
export const INCLUDE_DESCRIPTION = "Git-ignored files that match are found by Go to File, @ in the prompt and text search, in every project. A project can add its own on its page.";

/**
 * files.include_ignored as a list (docs/notes/file-search-2-includes-gui.md): its patterns,
 * the defaults among them, which defaults are missing, and saving a new list. One save at
 * a time (`busy`); a refused one leaves its message.
 */
function useIncludeEditor(field: SettingFieldView) {
  const { patterns, save } = useIncludeSetting();
  const defaults = useMemo(() => parseIncludeSetting(field.defaultValue), [field.defaultValue]);
  const fileIssue = useSettingsStore((s) => s.snapshot?.issues.find((i) => i.key === field.key)?.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (next: readonly string[]): Promise<string | null> => {
    setBusy(true);
    const err = await save(next);
    setBusy(false);
    setError(err);
    return err;
  };
  const missing = missingDefaults(patterns, defaults);
  return {
    patterns,
    defaults,
    missing,
    busy,
    message: error ?? (fileIssue ? `In the file: ${fileIssue}` : null),
    /** Only this editor's own (a search row's cell already shows the file's issue). */
    error,
    setError,
    remove: (p: string) => void run(withoutPattern(patterns, p)),
    add: (p: string) => (patterns.includes(p) ? Promise.resolve(null) : run(withPattern(patterns, p))),
    restore: () => void run(restoreDefaults(patterns, defaults)),
  };
}

type Editor = ReturnType<typeof useIncludeEditor>;

/** "Restore N defaults": shown only while a default is missing; appends them, never touching the user's own. */
function RestoreLink({ editor, className }: { editor: Editor; className?: string }) {
  if (editor.missing.length === 0) return null;
  return (
    <button type="button" className={cn("shrink-0 text-link hover:underline disabled:opacity-50", className)} disabled={editor.busy} data-testid="include-restore" onClick={editor.restore}>
      {restoreLabel(editor.missing.length)}
    </button>
  );
}

/** The rows (a "default" badge on the defaults) and the add field, hairline-separated. */
function IncludeRows({ editor }: { editor: Editor }) {
  return (
    <>
      {editor.patterns.map((p, i) => (
        <PatternRow
          key={p}
          pattern={p}
          badge={editor.defaults.includes(p) ? "default" : undefined}
          disabled={editor.busy}
          className={i > 0 ? "border-t border-cf-border" : undefined}
          onRemove={() => {
            editor.remove(p);
          }}
        />
      ))}
      <AddPatternInput busy={editor.busy} onAdd={editor.add} onError={editor.setError} className={editor.patterns.length > 0 ? "border-t border-cf-border" : undefined} />
    </>
  );
}

/**
 * Settings › General › Files, drawn as the setting's own section (sectionBodies): headed by
 * the setting's title, a card of its patterns with × each and an add field at the bottom,
 * and "Restore N defaults" at the heading's right. Removing the last pattern stores `none`.
 */
export function IncludeIgnoredSection({ section }: { section: SectionFields }) {
  const field = section.fields.find((f) => f.key === "files.include_ignored");
  if (!field) return null;
  return <IncludeSection field={field} sectionId={section.section.id} />;
}

function IncludeSection({ field, sectionId }: { field: SettingFieldView; sectionId: string }) {
  const editor = useIncludeEditor(field);
  return (
    <>
      <SectionCard id={sectionId} heading={field.title} description={INCLUDE_DESCRIPTION} aside={<RestoreLink editor={editor} className="text-caption" />}>
        <div data-setting={field.key} data-testid="include-setting">
          <IncludeRows editor={editor} />
        </div>
      </SectionCard>
      <PatternError message={editor.message} className="mt-1.5 ml-0.5" />
    </>
  );
}

/**
 * The same list as the setting's editor in a search result's row (keyEditors): the rows in
 * a box of their own, the restore link under it.
 */
export function IncludeIgnoredEditor({ field }: EditorProps) {
  const editor = useIncludeEditor(field);
  return (
    <div className="flex flex-col gap-1.5" data-testid="include-setting">
      <div className="overflow-hidden rounded-md border border-cf-border">
        <IncludeRows editor={editor} />
      </div>
      <RestoreLink editor={editor} className="self-start text-caption" />
      <PatternError message={editor.error} />
    </div>
  );
}
