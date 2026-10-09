import { createContext } from "react";

/** The editor node name of an inline image chip. */
export const CHIP_NODE = "attachmentChip";

/** The repo whose draft the chips belong to (node views look their attachment up by id). */
export const ChipRepoContext = createContext("");
