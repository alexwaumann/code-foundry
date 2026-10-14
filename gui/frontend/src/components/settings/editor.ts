import type { SettingFieldView } from "@/api/settings";

/** What every setting editor gets from its row (SettingRow). */
export interface EditorProps {
  field: SettingFieldView;
  /** The daemon's value (the default when unset). */
  value: string;
  /** A save is in flight. */
  pending: boolean;
  invalid: boolean;
  /** Validates and saves a raw value ("" resets to the default). */
  commit: (raw: string) => void;
  setError: (e: string | null) => void;
}

export type SettingEditor = (p: EditorProps) => React.JSX.Element;
