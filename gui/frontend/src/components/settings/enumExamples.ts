import type { SettingFieldView } from "@/api/settings";
import { useSettingValue } from "@/stores/settings";
import type { ExplainedOption } from "./model";

/** The word before a prefix mode branch's slash; this value of projects.branch_prefix means no prefix. */
const NO_PREFIX = "none";

/** A prefix mode example with the user's prefix in place of the schema's. */
export function withBranchPrefix(option: ExplainedOption, prefix: string): string {
  if (option.value !== "prefix") return option.example;
  const slug = option.example.slice(option.example.indexOf("/") + 1);
  return prefix === NO_PREFIX ? slug : `${prefix.replace(/^\/+|\/+$/g, "")}/${slug}`;
}

/** Explained enums whose examples follow another setting, by key: its key and how. */
const followers: Readonly<Partial<Record<string, { key: string; example: (option: ExplainedOption, value: string) => string }>>> = {
  "projects.branch_naming": { key: "projects.branch_prefix", example: withBranchPrefix },
};

/** An option's example as it would come out now. */
export function useEnumExample(field: SettingFieldView, option: ExplainedOption): string {
  const follower = followers[field.key];
  const value = useSettingValue(follower?.key ?? "");
  return follower && value !== undefined ? follower.example(option, value) : option.example;
}
