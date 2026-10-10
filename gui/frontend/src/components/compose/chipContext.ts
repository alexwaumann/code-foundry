import { createContext } from "react";

/** The editor node name of an inline image chip. */
export const CHIP_NODE = "attachmentChip";

/** The draft (draftKey) the chips belong to (node views look their attachment up by id). */
export const ChipDraftContext = createContext("");
