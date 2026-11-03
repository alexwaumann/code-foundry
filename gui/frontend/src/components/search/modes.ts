import type { ComponentType } from "react";
import type { SearchModeId } from "@/lib/agentSearch";
import { AgentSearch } from "./AgentSearch";
import { FindSearch } from "./FindSearch";
import type { SearchModeProps } from "./types";

/**
 * The search dialog's modes (components/search/SearchDialog.tsx): each draws its own body
 * and footer under the shared query field; the header shows a switch between them. Agent
 * search is the default until the user picks one (stores/searchDialog remembers it).
 */
export interface SearchMode {
  id: SearchModeId;
  label: string;
  placeholder: string;
  Body: ComponentType<SearchModeProps>;
}

export const SEARCH_MODES: readonly SearchMode[] = [
  { id: "find", label: "Find", placeholder: "Search threads and messages…", Body: FindSearch },
  { id: "agent", label: "Agent search", placeholder: "Ask about your threads…", Body: AgentSearch },
];
