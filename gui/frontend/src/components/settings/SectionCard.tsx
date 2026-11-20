import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { sectionAdvanced } from "./advancedFields";
import { useFieldUnused } from "./fieldUnused";
import { hiddenWhileOff, useHiddenFields } from "./hiddenFields";
import { fieldRows, rowBorder, type SectionFields } from "./model";
import { sectionBodies } from "./sectionBodies";
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
 * The page's switch: its first field when that is a bool (Enable Ember). Its dependents
 * further down the page dim without saying why, as the switch at the top says it once.
 */
function pageSwitch(schema: SettingsSchemaView, pageId: string): string | undefined {
  const first = schema.fields.find((f) => f.page === pageId);
  return first?.type === "bool" ? first.key : undefined;
}

/**
 * A field whose row depends on another (dependsOn). Right under its parent it is indented
 * with a hairline; in another section it says why it does nothing instead, unless the parent
 * is the page's switch (`quiet`). Either way it dims while the parent is off, and its editor
 * stays usable.
 */
function FieldRow({ field, parent, underParent, quiet, className }: { field: SettingFieldView; parent: SettingFieldView | undefined; underParent: boolean; quiet: boolean; className?: string }) {
  const { unused, reason } = useFieldUnused(field, parent);
  return <SettingRow field={field} indent={underParent} dimmed={unused} note={underParent || quiet ? undefined : reason} className={className} />;
}

/** A pair of fields sharing a row (Ember's model and effort): it dims like a FieldRow, as one, by its first field's parent. */
function PairRow({ first, fields, parent, quiet, className }: { first: SettingFieldView; fields: readonly SettingFieldView[]; parent: SettingFieldView | undefined; quiet: boolean; className?: string }) {
  const { unused, reason } = useFieldUnused(first, parent);
  return <SettingRowPair fields={fields} dimmed={unused} note={quiet ? undefined : reason} className={className} />;
}

/** A section's Advanced fields: quiet text under its card, closed until asked, opening a card of its own. */
function AdvancedFold({ schema, fields, quietUnder }: { schema: SettingsSchemaView; fields: readonly SettingFieldView[]; quietUnder: string | undefined }) {
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
            <FieldRow key={f.key} field={f} parent={schema.fields.find((p) => p.key === f.dependsOn)} underParent={false} quiet={f.dependsOn === quietUnder} className={rowBorder(i)} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A page's section: its rows (single fields, side-by-side pairs), any link row registered for
 * it, and any Advanced fields. `bare` leaves its heading off, for a dialog whose title says it.
 */
export function SettingsSection({ schema, pageId, section, bare = false }: { schema: SettingsSchemaView; pageId: string; section: SectionFields; bare?: boolean }) {
  const hidden = useHiddenFields(section.fields);
  const id = `${pageId}/${section.section.id}`;
  const shown = section.fields.filter((f) => !hidden.has(f.key));
  const advanced = shown.filter((f) => sectionAdvanced[id]?.has(f.key));
  const rows = fieldRows(shown.filter((f) => !advanced.includes(f)));
  const quietUnder = pageSwitch(schema, pageId);
  const Link = sectionLinks[id];
  const Body = bare ? undefined : sectionBodies[id];
  if (Body) return <Body section={{ ...section, fields: shown }} />;
  return (
    <SectionCard
      id={section.section.id}
      heading={bare ? "" : section.section.title}
      description={bare ? "" : section.section.description}
      after={advanced.length > 0 ? <AdvancedFold schema={schema} fields={advanced} quietUnder={quietUnder} /> : undefined}
    >
      {rows.map((row, i) => {
        const [first] = row;
        if (!first) return null;
        const parent = first.dependsOn ? schema.fields.find((f) => f.key === first.dependsOn) : undefined;
        const quiet = first.dependsOn !== "" && first.dependsOn === quietUnder;
        if (row.length > 1) return <PairRow key={first.key} first={first} fields={row} parent={parent} quiet={quiet} className={rowBorder(i)} />;
        const prev = rows[i - 1];
        // A field that leaves with its parent (Dictation's) is not indented: it is never there to dim.
        const underParent = first.dependsOn !== "" && !hiddenWhileOff(first.key) && prev?.length === 1 && prev[0]?.key === first.dependsOn;
        return <FieldRow key={first.key} field={first} parent={parent} underParent={underParent} quiet={quiet} className={underParent ? undefined : rowBorder(i)} />;
      })}
      {Link && <Link className={rowBorder(rows.length)} />}
    </SectionCard>
  );
}
