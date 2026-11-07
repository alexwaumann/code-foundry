import type { ReactNode } from "react";
import type { SettingFieldView } from "@/api/settings";
import { SelectItem } from "@/components/ui/select";
import { useEnumExample } from "./enumExamples";
import { Highlight } from "./Highlight";
import { matchedOptions, type ExplainedOption } from "./model";

/** Only in the list: the trigger (the item's text copied into select-value) shows the name alone. */
const LIST_ONLY = "[[data-slot=select-value]_&]:hidden";

/** An explained option in its dropdown: name and example, the sentence under them. */
export function EnumOptionItem({ field, option, value, children }: { field: SettingFieldView; option: ExplainedOption; value: string; children: ReactNode }) {
  const example = useEnumExample(field, option);
  return (
    <SelectItem value={value} className="items-start *:[span]:last:min-w-0 *:[span]:last:flex-1">
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span>{children}</span>
          {example && <span className={`text-code text-cf-text-muted ${LIST_ONLY}`}>{example}</span>}
        </span>
        <span className={`block text-caption ${LIST_ONLY}`}>{option.description}</span>
      </span>
    </SelectItem>
  );
}

/** The row's words for the picked option: its sentence and its example. */
export function PickedOption({ field, option }: { field: SettingFieldView; option: ExplainedOption }) {
  const example = useEnumExample(field, option);
  return (
    <>
      {option.description}
      {example && (
        <>
          {" For example "}
          <span className="text-code whitespace-nowrap text-cf-text">{example}</span>.
        </>
      )}
    </>
  );
}

/** After a search hit's description: the options the search found the field by, each "Name: what it does." */
export function MatchedOptions({ field, words }: { field: SettingFieldView; words: readonly string[] }) {
  return matchedOptions(field, words).map((o) => (
    <span key={o.value}>
      {" "}
      <Highlight text={`${o.label}: ${o.description.charAt(0).toLowerCase()}${o.description.slice(1)}`} words={words} />
    </span>
  ));
}
