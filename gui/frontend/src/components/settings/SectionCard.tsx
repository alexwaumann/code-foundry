import type { ReactNode } from "react";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";
import { useSettingValue } from "@/stores/settings";
import { fieldRows, rowBorder, type SectionFields } from "./model";
import { sectionLinks } from "./sectionLinks";
import { SettingRow, SettingRowPair } from "./SettingRow";

/**
 * A section: its heading and description above a bordered card of hairline-separated rows.
 * `aside` sits at the heading's right, on its last line (a count, a section-wide action).
 */
export function SectionCard({ id, heading, description, aside, children }: { id: string; heading: string; description?: string; aside?: ReactNode; children: ReactNode }) {
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
      <div className="overflow-hidden rounded-lg border border-border">{children}</div>
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

/** A page's section: its rows (single fields, side-by-side pairs) and any link row registered for it. */
export function SettingsSection({ schema, pageId, section }: { schema: SettingsSchemaView; pageId: string; section: SectionFields }) {
  const rows = fieldRows(section.fields);
  const Link = sectionLinks[`${pageId}/${section.section.id}`];
  return (
    <SectionCard id={section.section.id} heading={section.section.title} description={section.section.description}>
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
