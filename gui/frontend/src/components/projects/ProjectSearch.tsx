import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { IncludeAddField } from "@/components/includes/IncludeAddField";
import { PatternError, PatternRow } from "@/components/includes/PatternRows";
import type { SuggestFn } from "@/components/includes/useIncludeSuggestions";
import { useIncludeSetting } from "@/components/includes/useIncludeSetting";
import { effectivePatterns, withoutPattern, withPattern, type EffectivePattern, type IncludeScope } from "@/lib/includePatterns";
import { setProjectIncludes } from "@/stores/projectIncludes";
import { useProjectsStore } from "@/stores/projects";
import { SectionHeader } from "./bits";

const NONE: readonly string[] = [];

/**
 * A git project's Search section (docs/notes/file-search-2-includes-gui.md): the effective
 * include patterns, the setting's first with "all projects" (× there edits the setting, for
 * every project: the badge says so), then the project's own; and the add field with the
 * project's ignored entries as suggestions (Enter: this project, cmd+Enter: all projects).
 */
export function ProjectSearch({ projectId, suggest }: { projectId: string; suggest?: SuggestFn }) {
  const own = useProjectsStore(useShallow((s) => s.byId[projectId]?.includeIgnored ?? NONE));
  const setting = useIncludeSetting();
  const rows = useMemo(() => effectivePatterns(setting.patterns, own), [setting.patterns, own]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = async (scope: IncludeScope, next: readonly string[]): Promise<string | null> => {
    setBusy(true);
    const err = scope === "all" ? await setting.save(next) : await setProjectIncludes(projectId, next);
    setBusy(false);
    return err;
  };
  const remove = (r: EffectivePattern) => {
    void write(r.scope, withoutPattern(r.scope === "all" ? setting.patterns : own, r.pattern)).then(setError);
  };
  const add = (pattern: string, scope: IncludeScope): Promise<string | null> => {
    setError(null);
    const list = scope === "all" ? setting.patterns : own;
    // Already in the effective list for this scope (or for every project): nothing to write.
    if (list.includes(pattern) || (scope === "project" && setting.patterns.includes(pattern))) return Promise.resolve(null);
    return write(scope, withPattern(list, pattern));
  };

  return (
    <div data-testid="project-search">
      <SectionHeader label="Search" />
      <p className="-mt-1 mb-2 text-caption">Git-ignored files to include in Go to File and @ in the prompt. Everything else ignored stays out.</p>
      {rows.length > 0 && (
        <div className="mb-2.5 overflow-hidden rounded-lg border bg-cf-surface" data-testid="include-list">
          {rows.map((r, i) => (
            <PatternRow
              key={r.pattern}
              pattern={r.pattern}
              scope={r.scope}
              badge={r.scope === "all" ? "all projects" : undefined}
              disabled={busy}
              className={i > 0 ? "border-t" : undefined}
              onRemove={() => {
                remove(r);
              }}
            />
          ))}
        </div>
      )}
      <PatternError message={error} className="mb-1.5" />
      <IncludeAddField projectId={projectId} rev={rows.map((r) => r.pattern).join("\n")} busy={busy} onAdd={add} {...(suggest ? { suggest } : {})} />
    </div>
  );
}
