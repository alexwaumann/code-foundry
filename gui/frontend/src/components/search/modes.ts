import type { ComponentType } from "react";
import { FindSearch, type SearchModeProps } from "./FindSearch";

/**
 * The search dialog's modes (components/search/SearchDialog.tsx): each draws its own body
 * and footer under the shared query field. One today (Find); a second (Agent search) adds
 * an entry here, and the dialog's header then shows a switch between them.
 */
export interface SearchMode {
  id: string;
  label: string;
  Body: ComponentType<SearchModeProps>;
}

export const SEARCH_MODES: readonly SearchMode[] = [{ id: "find", label: "Find", Body: FindSearch }];
