// The parts of Sucrase's parser src/pagelib/source.ts reads: its deep ESM modules, which ship
// no types beside them. Only what source.ts uses.
declare module "sucrase/dist/esm/parser/index.js" {
  export interface SucraseToken {
    type: number;
    contextualKeyword: number;
    start: number;
    end: number;
  }
  export function parse(input: string, jsx: boolean, typescript: boolean, flow: boolean): { tokens: SucraseToken[] };
}
declare module "sucrase/dist/esm/parser/traverser/base.js" {
  import type { SucraseToken } from "sucrase/dist/esm/parser/index.js";
  /** The parser's state: tokens holds what it read before a syntax error. */
  export const state: { tokens: SucraseToken[] } | undefined;
}
declare module "sucrase/dist/esm/parser/tokenizer/types.js" {
  export const TokenType: Record<"string" | "name" | "parenL" | "colon" | "dot" | "slash" | "jsxName" | "jsxTagStart" | "jsxTagEnd" | "_import", number>;
}
declare module "sucrase/dist/esm/parser/tokenizer/keywords.js" {
  export const ContextualKeyword: Record<"_from", number>;
}
