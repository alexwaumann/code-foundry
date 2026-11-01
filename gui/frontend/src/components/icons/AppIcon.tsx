import { Folder, type LucideIcon } from "lucide-react";
import { FINDER_BUNDLE_ID } from "@/api/gitops";
import { cn } from "@/lib/utils";
import { useAppIcon } from "@/stores/appIcons";

/** What an icon slot passes: a class, and aria-hidden (the icon always is). */
export interface AppIconSlotProps {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

/**
 * An installed app's real icon (read by the daemon from the bundle; nothing is shipped),
 * or `fallback` while it loads and when the app has none. The icon is an `<svg>` holding
 * the PNG, so every slot that sizes its `svg` children (buttons, menu items, the thread
 * info card's rows) sizes it exactly as it sizes the lucide fallback; alone it is 16px.
 */
export function AppIcon({ bundleId, fallback: Fallback, className }: { bundleId: string; fallback: LucideIcon; className?: string }) {
  const url = useAppIcon(bundleId);
  if (!url) return <Fallback aria-hidden className={className} />;
  return (
    <svg viewBox="0 0 64 64" width={16} height={16} aria-hidden className={cn("shrink-0", className)} data-app-icon={bundleId}>
      <image href={url} width={64} height={64} />
    </svg>
  );
}

/** Finder's icon (a folder until it loads). */
export function FinderIcon({ className }: AppIconSlotProps) {
  return <AppIcon bundleId={FINDER_BUNDLE_ID} fallback={Folder} className={className} />;
}
