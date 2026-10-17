import { ConnectError } from "@connectrpc/connect";
import {
  SettingType,
  SettingsService,
  SettingsValidationErrorsSchema,
  type SettingField,
  type SettingGroup,
  type SettingPage,
  type SettingsSnapshot,
} from "@/gen/codefoundry/v1/settings_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type SettingTypeView = "string" | "int" | "bool" | "enum" | "path" | "keybinding";

export interface SettingFieldView {
  key: string;
  title: string;
  description: string;
  group: string;
  type: SettingTypeView;
  enumValues: string[];
  /** Display names parallel to enumValues; empty when the values are shown as they are. */
  enumLabels: string[];
  defaultValue: string;
  restartRequired: boolean;
  min: number;
  max: number;
  placeholder: string;
  /** SettingPageView.id of the page the field shows on. */
  page: string;
  /** SettingSectionView.id within the page. */
  section: string;
  /** Suffix inside a number input ("s", "pt", "%"); "" for none. */
  unit: string;
  /** Key of a bool field; while it is false this field renders indented and dimmed. "" for none. */
  dependsOn: string;
  /** Fields of a section sharing a non-empty row render side by side; the first one's description goes under the row. */
  row: string;
}

/** A table of the settings file. */
export interface SettingGroupView {
  id: string;
  title: string;
  description: string;
}

export interface SettingSectionView {
  id: string;
  /** "" for a page's single unnamed section. */
  title: string;
  description: string;
}

/** A page (tab) of the settings page; display only, independent of the file's groups. */
export interface SettingPageView {
  id: string;
  title: string;
  description: string;
  sections: SettingSectionView[];
}

export interface SettingsSchemaView {
  /** The file's tables, in file order. */
  groups: SettingGroupView[];
  /** Every field; within a section, in display order. */
  fields: SettingFieldView[];
  /** Pages in display order. */
  pages: SettingPageView[];
}

export interface SettingIssueView {
  key: string;
  message: string;
}

export interface SettingsSnapshotView {
  /** Every field's effective value (defaults included), string-encoded by type. */
  values: Readonly<Record<string, string>>;
  path: string;
  revision: number;
  /** The file does not parse; previous values stay in effect. */
  loadError: string;
  issues: SettingIssueView[];
  /** restart_required keys changed since the daemon started. */
  restartPending: string[];
}

/** An Update the daemon rejected, with one message per key. */
export class SettingsValidationError extends Error {
  constructor(readonly issues: SettingIssueView[]) {
    super(issues.map((i) => `${i.key}: ${i.message}`).join("; "));
  }
}

const typeMap: Record<SettingType, SettingTypeView> = {
  [SettingType.UNSPECIFIED]: "string",
  [SettingType.STRING]: "string",
  [SettingType.INT]: "int",
  [SettingType.BOOL]: "bool",
  [SettingType.ENUM]: "enum",
  [SettingType.PATH]: "path",
  [SettingType.KEYBINDING]: "keybinding",
};

export function toSettingFieldView(f: SettingField): SettingFieldView {
  return {
    key: f.key,
    title: f.title || f.key,
    description: f.description,
    group: f.group,
    type: typeMap[f.type],
    enumValues: [...f.enumValues],
    enumLabels: f.enumLabels.length === f.enumValues.length ? [...f.enumLabels] : [],
    defaultValue: f.defaultValue,
    restartRequired: f.restartRequired,
    min: Number(f.min),
    max: Number(f.max),
    placeholder: f.placeholder,
    page: f.page,
    section: f.section,
    unit: f.unit,
    dependsOn: f.dependsOn,
    row: f.row,
  };
}

function toGroupView(g: SettingGroup): SettingGroupView {
  return { id: g.id, title: g.title || g.id, description: g.description };
}

export function toSettingPageView(p: SettingPage): SettingPageView {
  return {
    id: p.id,
    title: p.title || p.id,
    description: p.description,
    sections: p.sections.map((s) => ({ id: s.id, title: s.title, description: s.description })),
  };
}

export function toSettingsSnapshotView(s: SettingsSnapshot): SettingsSnapshotView {
  return {
    values: { ...s.values },
    path: s.path,
    revision: Number(s.revision),
    loadError: s.loadError,
    issues: s.issues.map((i) => ({ key: i.key, message: i.message })),
    restartPending: [...s.restartPending],
  };
}

export async function getSettingsSchema(conn: DaemonConnection = daemon): Promise<SettingsSchemaView> {
  const c = await conn.client(SettingsService);
  const res = await c.getSchema({});
  return { groups: res.groups.map(toGroupView), fields: res.fields.map(toSettingFieldView), pages: res.pages.map(toSettingPageView) };
}

export async function getSettings(conn: DaemonConnection = daemon): Promise<SettingsSnapshotView | null> {
  const c = await conn.client(SettingsService);
  const res = await c.get({});
  return res.settings ? toSettingsSnapshotView(res.settings) : null;
}

/**
 * Applies a partial change ("" resets a key). Throws SettingsValidationError when the
 * daemon rejects values, other errors as they come.
 */
export async function updateSettings(values: Record<string, string>, conn: DaemonConnection = daemon): Promise<SettingsSnapshotView | null> {
  const c = await conn.client(SettingsService);
  try {
    const res = await c.update({ values });
    return res.settings ? toSettingsSnapshotView(res.settings) : null;
  } catch (err) {
    if (err instanceof ConnectError) {
      const [detail] = err.findDetails(SettingsValidationErrorsSchema);
      if (detail) throw new SettingsValidationError(detail.errors.map((i) => ({ key: i.key, message: i.message })));
    }
    throw err;
  }
}
