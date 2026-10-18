/**
 * The plugin view's node renderers, keyed by node kind (docs/notes/plugins-5-gui.md). A
 * renderer is one component in nodes/ that takes the node and its kind's data; nodes/index.ts
 * lists them. A new node kind adds its file and one line there; `thread` and `terminal`
 * render a placeholder until PR 6 replaces those two lines with real renderers.
 */
import type { ComponentType } from "react";
import type { NodeData, NodeKind, ViewNode } from "@/api/plugin";

/** What a node renderer gets: the node (its key) and its kind's data. */
export interface NodeProps<K extends NodeKind> {
  node: ViewNode;
  data: NodeData[K];
}

export type NodeRenderer<K extends NodeKind> = ComponentType<NodeProps<K>>;

/** One renderer per kind: the type makes a missing kind a compile error. */
export type NodeRenderers = { readonly [K in NodeKind]: NodeRenderer<K> };
