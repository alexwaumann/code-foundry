import type { ComponentType } from "react";
import { DictationModelRow } from "./DictationSettings";
import { BrowseThemesRow } from "./LinkRow";

/**
 * Rows at the end of a section's card, by "<page>/<section>": a section that leads to a
 * page of its own (a link row), or one that shows state after its fields (Dictation's Model).
 */
export const sectionLinks: Readonly<Partial<Record<string, ComponentType<{ className?: string | undefined }>>>> = {
  "appearance/theme": BrowseThemesRow,
  "general/dictation": DictationModelRow,
};

/**
 * What the settings search finds of a section's own rows, by "<page>/<section>" (the
 * fields are found by their title, description and key): a hit opens the page at the section.
 */
export const sectionRowSearch: Readonly<Partial<Record<string, { description: string; keywords: readonly string[] }>>> = {
  "general/dictation": {
    description: "Model: Whisper Large v3 Turbo, English, transcribed on this Mac. Download or remove it.",
    keywords: ["voice", "speech", "microphone", "whisper", "model", "transcribe", "download"],
  },
};
