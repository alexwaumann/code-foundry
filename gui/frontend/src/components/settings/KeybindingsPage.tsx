import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SettingFieldView, SettingPageView, SettingsSchemaView } from "@/api/settings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";
import { setBoundOnly, useSettingsPrefsStore } from "@/stores/settingsPrefs";
import { bucketKeybindings, rowBorder } from "./model";
import { PageHead } from "./PageHead";
import { SectionCard } from "./SectionCard";
import { FieldError, ResetButton } from "./SettingRow";
import { useSettingField } from "./useSettingField";

const NO_VALUES: Readonly<Record<string, string>> = {};

/** One command on one line: its title (description and command name in the tooltip), the recorder, the reset arrow. */
function KeybindingRow({ field, className }: { field: SettingFieldView; className?: string | undefined }) {
  const state = useSettingField(field);
  const command = field.key.replace(/^keybindings\./, "");
  return (
    <div className={cn("px-4", className)} data-setting={field.key} data-modified={state.modified || undefined}>
      <div className="flex h-10 items-center gap-3">
        <div className="min-w-0 flex-1">
          <Tip
            side="bottom"
            align="start"
            label={
              <>
                {field.description}
                <span className="mt-1 block font-mono text-caption-sm">{command}</span>
              </>
            }
          >
            <span className="inline-block max-w-full truncate align-middle text-body-sm">{field.title}</span>
          </Tip>
        </div>
        <div className="min-w-28">{state.editor}</div>
        <ResetButton field={field} state={state} />
      </div>
      <FieldError message={state.message} className="pb-2" />
    </div>
  );
}

/** A row that opens (or closes) a list below it: "19 more unbound", a category in "No shortcuts yet". */
function ExpanderRow({ open, onToggle, className, testId, children }: { open: boolean; onToggle: () => void; className?: string | undefined; testId: string; children: React.ReactNode }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      className={cn("flex h-9 w-full items-center gap-2 px-4 text-left text-body-sm text-muted-foreground outline-none hover:bg-accent/50 focus-visible:bg-accent/50", className)}
      onClick={onToggle}
      data-testid={testId}
    >
      <Chevron className="size-3.5 shrink-0" aria-hidden />
      {children}
    </button>
  );
}

/**
 * The keybindings page: a card per command category. With Bound only (on by default)
 * a category lists its bound commands and keeps the rest behind "N more unbound";
 * categories with nothing bound fold into one "No shortcuts yet" card.
 */
export function KeybindingsPage({ schema, page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  const values = useSettingsStore((s) => s.snapshot?.values ?? NO_VALUES);
  const boundOnly = useSettingsPrefsStore((s) => s.boundOnly);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const fields = useMemo(() => schema.fields.filter((f) => f.page === page.id), [schema, page.id]);
  const buckets = bucketKeybindings(page.sections, fields, values, boundOnly);
  const toggle = (id: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const count = `${String(buckets.bound)} of ${String(buckets.total)} commands have a shortcut.`;

  return (
    <>
      <PageHead
        page={page}
        description={page.description ? `${page.description} ${count}` : count}
        aside={
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Label htmlFor="settings-bound-only" className="text-body-sm font-normal">
              Bound only
            </Label>
            <Switch id="settings-bound-only" checked={boundOnly} onCheckedChange={setBoundOnly} data-testid="settings-bound-only" />
          </div>
        }
      />
      {buckets.categories.map(({ section, shown, unbound }) => {
        const expanded = open.has(section.id);
        return (
          <SectionCard key={section.id} id={section.id} heading={section.title} description={section.description}>
            {shown.map((f, i) => (
              <KeybindingRow key={f.key} field={f} className={rowBorder(i)} />
            ))}
            {unbound.length > 0 && (
              <>
                <ExpanderRow open={expanded} onToggle={() => { toggle(section.id); }} className={rowBorder(1)} testId={`keybindings-more-${section.id}`}>
                  <span>
                    <span className="tabular-nums">{unbound.length}</span> {expanded ? "unbound" : "more unbound"}
                  </span>
                </ExpanderRow>
                {expanded && unbound.map((f) => <KeybindingRow key={f.key} field={f} className={rowBorder(1)} />)}
              </>
            )}
          </SectionCard>
        );
      })}
      {buckets.empty.length > 0 && (
        <SectionCard
          id="unbound"
          heading="No shortcuts yet"
          description="Categories whose commands are all unbound. Open one to give a command a shortcut, or turn off Bound only."
        >
          <div data-testid="keybindings-unbound-card">
            {buckets.empty.map(({ section, fields: cmds }, i) => {
              const expanded = open.has(section.id);
              return (
                <div key={section.id} className={rowBorder(i)} data-section={section.id}>
                  <ExpanderRow open={expanded} onToggle={() => { toggle(section.id); }} testId={`keybindings-category-${section.id}`}>
                    <span className="flex-1 text-foreground">{section.title}</span>
                    <span className="text-caption-sm tabular-nums">{cmds.length} unbound</span>
                  </ExpanderRow>
                  {expanded && (
                    <div className="ml-5 border-l border-border">
                      {cmds.map((f) => (
                        <KeybindingRow key={f.key} field={f} className="border-t border-border" />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </>
  );
}
