import { TriangleAlert } from "lucide-react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { focusSetting } from "@/components/settings/focus";
import { pageSections } from "@/components/settings/model";
import { SettingsSection } from "@/components/settings/SectionCard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePluginRegistryStore } from "@/stores/pluginRegistry";
import { REGISTRIES_SETTING, registryErrorWords, registryLine, shortSource } from "./registry";

/** Each configured registry: when it was read, and a failure in words. */
function RegistryNotices() {
  const registries = usePluginRegistryStore((s) => s.browse?.registries);
  if (!registries || registries.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-cf-border">
      {registries.map((r, i) => (
        <div key={r.url} className={cn("flex min-w-0 flex-col gap-0.5 px-3 py-2.5", i > 0 && "border-t border-cf-border")} data-testid="registry-status" data-error={r.error ? "true" : undefined}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-caption-sm text-cf-text">{shortSource(r.url)}</span>
            <span className="ml-auto shrink-0 text-caption-sm">{registryLine(r)}</span>
          </div>
          {r.error && (
            <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-warning-text" role="alert">
              <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {registryErrorWords(r.error)}
                {r.cached ? " Showing what it listed last time." : ""}
              </span>
            </p>
          )}
          {r.issues.map((i2) => (
            <p key={i2} className="text-caption-sm break-words text-cf-warning-text">
              {i2}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Settings → Plugins' Registries, from the page's ⋯ menu: each registry as last read, and the
 * page's own settings (plugins.registries). `focusField` puts the caret in that setting: a
 * "no registry" line's link opens the dialog to add one.
 */
export function RegistriesDialog({ schema, page, focusField, onClose }: { schema: SettingsSchemaView; page: SettingPageView; focusField: boolean; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] max-w-2xl flex-col overflow-y-auto p-5"
        data-testid="plugin-registries"
        onOpenAutoFocus={(e) => {
          if (focusField && focusSetting(REGISTRIES_SETTING)) e.preventDefault();
        }}
      >
        <div className="mb-3 space-y-0.5">
          <DialogTitle>Registries</DialogTitle>
          <DialogDescription>Where Browse all reads its plugins from. Installing asks for your consent before anything runs.</DialogDescription>
        </div>
        <RegistryNotices />
        {pageSections(schema, page).map((sf) => (
          <SettingsSection key={sf.section.id} schema={schema} pageId={page.id} section={sf} bare />
        ))}
      </DialogContent>
    </Dialog>
  );
}
