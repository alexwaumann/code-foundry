import { PluginSurfaceBody } from "@/components/plugin/PluginSurface";
import { useShotStage } from "./stageStore";

/** The shot page's one surface, filling the window. */
export function Stage() {
  const stage = useShotStage((s) => s.stage);
  if (!stage) return null;
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-cf-surface text-cf-text" data-testid="shot-stage">
      <PluginSurfaceBody key={stage.watchKey} watchKey={stage.watchKey} plugin={stage.target.plugin} surface={stage.target.surface} context={stage.target.context} />
    </div>
  );
}
