import { useEffect, useState } from "react";
import type { InstalledSkillView } from "@/api/skill";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { PageHead } from "@/components/settings/PageHead";
import { openSkillMarketplace } from "@/stores/skill";
import { BrowseSection } from "./BrowseSection";
import { ConfirmSkillDialog } from "./ConfirmSkillDialog";
import { InstalledSection } from "./InstalledSection";
import type { ConfirmAction } from "./model";
import { RegistriesSection } from "./RegistriesSection";

/**
 * Settings → Skills (docs/notes/skills-4-gui.md): Claude Code plugins and standalone skills
 * from the marketplaces Claude Code has. Installed (enable, disable, update, run setup,
 * uninstall or remove), Browse (a search with chips, install and update) and Registries.
 * The page holds the marketplace open (stores/skill.ts), so a new epoch re-reads it.
 */
export function SkillsPage({ page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  const [confirm, setConfirm] = useState<{ action: ConfirmAction; row: InstalledSkillView } | null>(null);
  useEffect(() => openSkillMarketplace(), []);
  return (
    <>
      <PageHead page={page} />
      <InstalledSection
        onConfirm={(action, row) => {
          setConfirm({ action, row });
        }}
      />
      <BrowseSection />
      <RegistriesSection />
      {confirm && (
        <ConfirmSkillDialog
          action={confirm.action}
          row={confirm.row}
          onClose={() => {
            setConfirm(null);
          }}
        />
      )}
    </>
  );
}
