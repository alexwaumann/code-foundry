/**
 * Settings pages the GUI draws on its own, after the daemon's schema pages: they show
 * state rather than settings-file fields, so the schema has no page for them. A page that
 * is the GUI's only lists its sections, so the settings search finds them (model.ts
 * searchGuiPages); one that is also a schema page (Plugins) is found by its fields.
 */
import { Puzzle, Sparkles, type LucideIcon } from "lucide-react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { PluginsPage } from "@/components/plugin/settings/PluginsPage";
import { SkillsPage } from "@/components/skill/settings/SkillsPage";

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
  {
    page: {
      id: "skills",
      title: "Skills",
      description: "Claude Code plugins and skills from your organisation's marketplace.",
      sections: [
        { id: "installed", title: "Installed", description: "Claude Code plugins and skills on this Mac: enable, disable, update, run setup, uninstall." },
        { id: "browse", title: "Browse", description: "Search the marketplace's enterprise and community plugins and skills, and install them." },
        { id: "registries", title: "Registries", description: "The marketplaces Claude Code has (claude plugin marketplace), and refreshing them." },
      ],
    },
    icon: Sparkles,
    component: SkillsPage,
  },
];
