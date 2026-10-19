/** Every node kind's renderer (registry.ts). */
import type { NodeRenderers } from "../registry";
import { ActionsNode } from "./ActionsNode";
import { ChipsNode } from "./ChipsNode";
import { ColumnsNode } from "./ColumnsNode";
import { ContainerNode } from "./ContainerNode";
import { DividerNode } from "./DividerNode";
import { EmptyNode } from "./EmptyNode";
import { FormNode } from "./FormNode";
import { GridNode } from "./GridNode";
import { GroupNode } from "./GroupNode";
import { ListNode } from "./ListNode";
import { LogNode } from "./LogNode";
import { MasterDetailNode } from "./MasterDetailNode";
import { MarkdownNode } from "./MarkdownNode";
import { NoticeNode } from "./NoticeNode";
import { PairsNode } from "./PairsNode";
import { PaneNode } from "./PaneNode";
import { ProgressNode } from "./ProgressNode";
import { SectionNode } from "./SectionNode";
import { SpacerNode } from "./SpacerNode";
import { TabsNode } from "./TabsNode";
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
  grid: GridNode,
  divider: DividerNode,
  spacer: SpacerNode,
  group: GroupNode,
  container: ContainerNode,
  masterDetail: MasterDetailNode,
  tabs: TabsNode,
};
