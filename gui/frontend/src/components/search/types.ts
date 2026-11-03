import type { ReactNode, RefObject } from "react";
import type { SearchEntryView } from "@/api/search";
import type { ComposerDictation } from "@/components/compose/useComposerDictation";
import type { SearchModeId, SearchSession, UnseenCue } from "@/lib/agentSearch";
import type { RecentApi } from "./RecentSearches";
import type { WatchSearchFn } from "./useAgentSearch";
import type { PreviewLoaders, SearchFn } from "./useSearch";

/** Where a restored agent search puts its selection and scroll. */
export interface RestoreInit {
  selectedN: number | null;
  openedN: number | null;
  scrollTop: number;
}

/** What the dialog shares with its modes (components/search/SearchDialog.tsx). */
export interface SearchDialogApi {
  mode: SearchModeId;
  /** How many modes the dialog has (the Tab hint shows only with more than one). */
  modeCount: number;
  setMode: (m: SearchModeId) => void;
  query: string;
  setQuery: (q: string) => void;
  /** The agent search shown; null for none. */
  entryId: string | null;
  /** Its entry as StartAgent or Recent searches gave it, until Watch's snapshot. */
  seed: SearchEntryView | null;
  /** Shows a saved agent search (Agent mode, its query selected). */
  show: (e: SearchEntryView) => void;
  /** Starts an agent search for the question (Agent mode). */
  start: (question: string) => void;
  starting: boolean;
  /** Why the last start failed; "" for none. */
  startError: string;
  /** A restored search's selection and scroll; null for none. */
  restore: RestoreInit | null;
  /** What a reopen within RESTORE_MS restores (the mode reports its selection, opened hit and scroll). */
  report: (p: Partial<SearchSession>) => void;
  recent: RecentApi;
  /** A restored dialog's finished searches it has not shown (the newest, and how many more); null for none. show() picks it. */
  cue: UnseenCue | null;
  /** When the dialog opened (Recent searches' ages). */
  now: number;
  /** The Recent searches row selected (the first when none was picked). */
  selectedRecent: SearchEntryView | null;
  dictation: ComposerDictation;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Test seam: SearchService.Watch. */
  watchSearch?: WatchSearchFn;
}

/** What a mode gets from the dialog: the query and the header to draw (the shared field, with what the mode puts beside it). */
export interface SearchModeProps {
  query: string;
  header: (badges: ReactNode) => ReactNode;
  dialog: SearchDialogApi;
  /** Test seams: the daemon's Search and the preview's reads. */
  search?: SearchFn;
  loaders?: PreviewLoaders;
}
