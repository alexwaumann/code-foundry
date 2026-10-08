import { ConnectError } from "@connectrpc/connect";
import {
  SettingType,
  SettingsService,
  SettingsValidationErrorsSchema,
  type SettingField,
  type SettingGroup,
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
  defaultValue: string;
  restartRequired: boolean;
  min: number;
  max: number;
  placeholder: string;
}

export interface SettingGroupView {
  id: string;
  title: string;
  description: string;
}

export interface SettingsSchemaView {
  groups: SettingGroupView[];
  fields: SettingFieldView[];
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
    defaultValue: f.defaultValue,
    restartRequired: f.restartRequired,
    min: Number(f.min),
    max: Number(f.max),
    placeholder: f.placeholder,
  };
}

function toGroupView(g: SettingGroup): SettingGroupView {
  return { id: g.id, title: g.title || g.id, description: g.description };
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
  return { groups: res.groups.map(toGroupView), fields: res.fields.map(toSettingFieldView) };
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
