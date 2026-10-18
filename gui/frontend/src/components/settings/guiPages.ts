/**
 * Settings pages the GUI draws on its own, after the daemon's schema pages: they show
 * state rather than settings-file fields, so the schema has no page for them.
 */
import { Puzzle, type LucideIcon } from "lucide-react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { PluginsPage } from "@/components/plugin/settings/PluginsPage";

export interface GuiPage {
  page: SettingPageView;
  icon: LucideIcon;
  component: (p: { schema: SettingsSchemaView; page: SettingPageView }) => React.JSX.Element;
}

export const guiPages: readonly GuiPage[] = [
  {
    page: { id: "plugins", title: "Plugins", description: "Separate programs that add commands, panel surfaces, thread flags and environment to Code Foundry.", sections: [] },
    icon: Puzzle,
    component: PluginsPage,
  },
];
