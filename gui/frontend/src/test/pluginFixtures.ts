/**
 * The hello demo's captured views (internal/store/plugin/testdata/hello-demo, written by
 * PR 6's end to end): every node kind, tabs, a fieldset, an options source, both log forms,
 * the plugin's own thread (assistant) and terminal (shell), columns and panes (layout,
 * captured by plugins-layout-1), and a master-detail with nothing chosen (run-list,
 * plugins-layout-4).
 * Imported from the repository so the GUI's tests and the daemon's tests share them.
 */
import { parseView, type PluginViewModel } from "@/api/plugin";
import assistant from "../../../../internal/store/plugin/testdata/hello-demo/assistant.json?raw";
import layout from "../../../../internal/store/plugin/testdata/hello-demo/layout.json?raw";
import form from "../../../../internal/store/plugin/testdata/hello-demo/form.json?raw";
import log from "../../../../internal/store/plugin/testdata/hello-demo/log.json?raw";
import overview from "../../../../internal/store/plugin/testdata/hello-demo/overview.json?raw";
import shell from "../../../../internal/store/plugin/testdata/hello-demo/shell.json?raw";
import runList from "../../../../internal/store/plugin/testdata/hello-demo/run-list.json?raw";

export type DemoTab = "overview" | "form" | "log" | "assistant" | "shell" | "layout" | "run-list";

const json: Record<DemoTab, string> = { overview, form, log, assistant, shell, layout, "run-list": runList };

export function demoJson(tab: DemoTab): string {
  return json[tab];
}

export function demoView(tab: DemoTab): PluginViewModel {
  const v = parseView(json[tab]);
  if (!v) throw new Error(`${tab}.json is not a view`);
  return v;
}
