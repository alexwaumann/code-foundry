/**
 * The hello demo's captured views (internal/store/plugin/testdata/hello-demo, written by
 * PR 2's end to end): every node kind, tabs, a fieldset, an options source, both log forms.
 * Imported from the repository so the GUI's tests and the daemon's tests share them.
 */
import { parseView, type PluginViewModel } from "@/api/plugin";
import form from "../../../../internal/store/plugin/testdata/hello-demo/form.json?raw";
import log from "../../../../internal/store/plugin/testdata/hello-demo/log.json?raw";
import overview from "../../../../internal/store/plugin/testdata/hello-demo/overview.json?raw";

export type DemoTab = "overview" | "form" | "log";

const json: Record<DemoTab, string> = { overview, form, log };

export function demoJson(tab: DemoTab): string {
  return json[tab];
}

export function demoView(tab: DemoTab): PluginViewModel {
  const v = parseView(json[tab]);
  if (!v) throw new Error(`${tab}.json is not a view`);
  return v;
}
