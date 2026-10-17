import { Button } from "@/components/ui/button";
import { openThemes } from "@/stores/views";
import type { EditorProps, SettingEditor } from "./editor";
import { EnumEditor } from "./editors";

/**
 * appearance.theme_dark / appearance.theme_light: the enum select, and "Choose…", which
 * opens the Themes page (theme.pick) on this slot to preview the themes first. Closing that
 * page comes back here. No " (default)" after a name: it would not fit beside the button.
 */
function slotEditor(slot: "dark" | "light"): SettingEditor {
  return function ThemeSlotEditor(props: EditorProps) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <EnumEditor {...props} markDefault={false} />
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Choose ${slot} theme`}
          onClick={() => {
            openThemes(slot, "settings");
          }}
          data-testid={`choose-theme-${slot}`}
        >
          Choose…
        </Button>
      </div>
    );
  };
}

export const ThemeDarkEditor = slotEditor("dark");
export const ThemeLightEditor = slotEditor("light");
