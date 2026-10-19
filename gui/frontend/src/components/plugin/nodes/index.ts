/** Every node kind's renderer (registry.ts). */
import type { NodeRenderers } from "../registry";
import { ActionsNode } from "./ActionsNode";
import { ChipsNode } from "./ChipsNode";
import { ColumnsNode } from "./ColumnsNode";
import { EmptyNode } from "./EmptyNode";
import { FormNode } from "./FormNode";
import { ListNode } from "./ListNode";
import { LogNode } from "./LogNode";
import { MarkdownNode } from "./MarkdownNode";
import { NoticeNode } from "./NoticeNode";
import { PairsNode } from "./PairsNode";
import { PaneNode } from "./PaneNode";
import { ProgressNode } from "./ProgressNode";
import { SectionNode } from "./SectionNode";
import { TerminalNode } from "./TerminalNode";
import { TextNode } from "./TextNode";
import { ThreadNode } from "./ThreadNode";

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
  thread: ThreadNode,
  terminal: TerminalNode,
  columns: ColumnsNode,
  pane: PaneNode,
};
