/**
 * Settings pages the GUI draws on its own, after the daemon's schema pages: they show
 * state rather than settings-file fields, so the schema has no page for them. A page that
 * is the GUI's only lists its sections, so the settings search finds them (model.ts
 * searchGuiPages); one that is also a schema page (Plugins) is found by its fields.
 */
import { BrainCircuit, Puzzle, Sparkles, type LucideIcon } from "lucide-react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { MemoryPage } from "@/components/memory/settings/MemoryPage";
import { PluginsPage } from "@/components/plugin/settings/PluginsPage";
import { SkillsPage } from "@/components/skill/settings/SkillsPage";

export interface GuiPage {
  page: SettingPageView;
  icon: LucideIcon;
  component: (p: { schema: SettingsSchemaView; page: SettingPageView }) => React.JSX.Element;
}

export const guiPages: readonly GuiPage[] = [
  {
    page: { id: "plugins", title: "Plugins", description: "Programs that add commands, panels and thread options to Code Foundry.", sections: [] },
    icon: Puzzle,
    component: PluginsPage,
  },
  {
    page: {
      id: "skills",
      title: "Skills",
      description: "Claude Code plugins and skills from your organisation's marketplace.",
      sections: [
        { id: "installed", title: "Installed", description: "What's installed on this Mac. Enable, disable, update, run setup or uninstall." },
        { id: "browse", title: "Browse", description: "Search the marketplace and install plugins and skills." },
        { id: "registries", title: "Registries", description: "The marketplaces Claude Code knows about, and refreshing them." },
      ],
    },
    icon: Sparkles,
    component: SkillsPage,
  },
  {
    page: {
      id: "memory",
      title: "Memory",
      description: "What threads have been told to remember about this app and how they work in it.",
      sections: [
        {
          id: "remembered",
          title: "Remembered",
          description: "Every thread in every project reads these before its first action.",
          keywords: ["forget", "preferences", "standing", "remember"],
        },
      ],
    },
    icon: BrainCircuit,
    component: MemoryPage,
  },
];
