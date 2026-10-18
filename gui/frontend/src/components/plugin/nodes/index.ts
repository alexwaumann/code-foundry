/**
 * Every node kind's renderer (registry.ts). PR 6 replaces the thread and terminal
 * placeholders with real renderers here.
 */
import type { NodeRenderers } from "../registry";
import { ActionsNode } from "./ActionsNode";
import { ChipsNode } from "./ChipsNode";
import { EmptyNode } from "./EmptyNode";
import { FormNode } from "./FormNode";
import { ListNode } from "./ListNode";
import { LogNode } from "./LogNode";
import { MarkdownNode } from "./MarkdownNode";
import { NoticeNode } from "./NoticeNode";
import { TerminalPlaceholder, ThreadPlaceholder } from "./OwnedPlaceholder";
import { PairsNode } from "./PairsNode";
import { ProgressNode } from "./ProgressNode";
import { SectionNode } from "./SectionNode";
import { TextNode } from "./TextNode";

export const renderers: NodeRenderers = {
  text: TextNode,
  markdown: MarkdownNode,
  pairs: PairsNode,
  list: ListNode,
  chips: ChipsNode,
  log: LogNode,
  actions: ActionsNode,
  progress: ProgressNode,
  notice: NoticeNode,
  empty: EmptyNode,
  section: SectionNode,
  form: FormNode,
  thread: ThreadPlaceholder,
  terminal: TerminalPlaceholder,
};
