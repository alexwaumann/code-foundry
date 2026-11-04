import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useSettingValue } from "@/stores/settings";
import { sectionAdvanced } from "./advancedFields";
import { useHiddenFields } from "./hiddenFields";
import { fieldRows, rowBorder, type SectionFields } from "./model";
import { sectionLinks } from "./sectionLinks";
import { SettingRow, SettingRowPair } from "./SettingRow";

/**
 * A section: its heading and description above a bordered card of hairline-separated rows.
 * `aside` sits at the heading's right, on its last line (a count, a section-wide action);
 * `after` follows the card (its Advanced disclosure).
 */
export function SectionCard({ id, heading, description, aside, after, children }: { id: string; heading: string; description?: string; aside?: ReactNode; after?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6" data-testid="settings-section" data-section={id} aria-label={heading || undefined}>
      {(heading || description || aside) && (
        <div className="mb-2 ml-0.5 flex items-end gap-4">
          <div className="min-w-0 flex-1">
            {heading && <h3 className="text-subheading">{heading}</h3>}
            {description && <p className="mt-px text-caption">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-cf-border">{children}</div>
      {after}
    </section>
  );
}

/**
 * A field whose row depends on a bool (dependsOn). Right under its parent it is indented
 * with a hairline; in another section it says why it does nothing instead. Either way it
 * dims while the parent is off, and its editor stays usable.
 */
function FieldRow({ field, parent, underParent, className }: { field: SettingFieldView; parent: SettingFieldView | undefined; underParent: boolean; className?: string }) {
  const parentValue = useSettingValue(field.dependsOn || "") ?? parent?.defaultValue;
  const dimmed = field.dependsOn !== "" && parentValue === "false";
  return (
    <SettingRow
      field={field}
      indent={underParent}
      dimmed={dimmed}
      note={!underParent && parent ? `Not used while ${parent.title} is off.` : undefined}
      className={className}
    />
  );
}

/** A section's Advanced fields: quiet text under its card, closed until asked, opening a card of its own. */
function AdvancedFold({ schema, fields }: { schema: SettingsSchemaView; fields: readonly SettingFieldView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group mt-3 ml-0.5 flex items-center gap-1.5 text-cf-text-muted" data-testid="settings-advanced-toggle">
        <ChevronRight className="size-4 shrink-0 group-data-[state=open]:rotate-90" aria-hidden />
        <span className="text-label">Advanced</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 overflow-hidden rounded-lg border border-cf-border" data-testid="settings-advanced">
          {fields.map((f, i) => (
            <FieldRow key={f.key} field={f} parent={schema.fields.find((p) => p.key === f.dependsOn)} underParent={false} className={rowBorder(i)} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A page's section: its rows (single fields, side-by-side pairs), any link row registered for it, and any Advanced fields. */
export function SettingsSection({ schema, pageId, section }: { schema: SettingsSchemaView; pageId: string; section: SectionFields }) {
  const hidden = useHiddenFields(section.fields);
  const id = `${pageId}/${section.section.id}`;
  const shown = section.fields.filter((f) => !hidden.has(f.key));
  const advanced = shown.filter((f) => sectionAdvanced[id]?.has(f.key));
  const rows = fieldRows(shown.filter((f) => !advanced.includes(f)));
  const Link = sectionLinks[id];
  return (
    <SectionCard
      id={section.section.id}
      heading={section.section.title}
      description={section.section.description}
      after={advanced.length > 0 ? <AdvancedFold schema={schema} fields={advanced} /> : undefined}
    >
      {rows.map((row, i) => {
        const [first] = row;
        if (!first) return null;
        if (row.length > 1) return <SettingRowPair key={first.key} fields={row} className={rowBorder(i)} />;
        const prev = rows[i - 1];
        const underParent = first.dependsOn !== "" && prev?.length === 1 && prev[0]?.key === first.dependsOn;
        const parent = first.dependsOn ? schema.fields.find((f) => f.key === first.dependsOn) : undefined;
        return <FieldRow key={first.key} field={first} parent={parent} underParent={underParent} className={underParent ? undefined : rowBorder(i)} />;
      })}
      {Link && <Link className={rowBorder(rows.length)} />}
    </SectionCard>
  );
}
