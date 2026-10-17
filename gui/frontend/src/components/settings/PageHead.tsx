import type { ReactNode } from "react";
import type { SettingPageView } from "@/api/settings";

/** A settings page's title and description, with an optional control at the right (Bound only). */
export function PageHead({ page, description = page.description, aside }: { page: SettingPageView; description?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-title">{page.title}</h2>
        {description && (
          <p className="mt-0.5 text-caption" data-testid="settings-page-description">
            {description}
          </p>
        )}
      </div>
      {aside}
    </div>
  );
}
