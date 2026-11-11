import type { TableMeter } from "@/api/pluginTable";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { meterFill, meterFillClass, meterPercent, meterShowsLabel } from "../meter";

/**
 * A table cell's meter (docs/notes/plugin-table-meter.md): a 6 px track the cell's width
 * with a fill of its value in its tone, then the plugin's label in a fixed slot so a
 * column's tracks line up. Below METER_LABEL_MIN_CELL_PX (`width`, its column's) the label
 * goes and the track's tooltip shows it instead.
 */
export function MeterCell({ meter, width }: { meter: TableMeter; width: number | null }) {
  const fill = meterFill(meter.value);
  const label = meter.label ?? "";
  const shows = meterShowsLabel(meter, width);
  const track = (
    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-cf-text/10" data-testid="plugin-meter-track">
      <div className={cn("h-full rounded-full", meterFillClass(meter.tone))} style={fill} data-testid="plugin-meter-fill" data-tone={meter.tone || undefined} />
    </div>
  );
  return (
    <div
      role="meter"
      aria-valuenow={meterPercent(meter.value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={label || undefined}
      className="flex h-full min-w-0 flex-1 items-center gap-2"
      data-testid="plugin-meter"
    >
      {shows ? track : <Tip label={label}>{track}</Tip>}
      {shows && (
        <Tip label={label} whenTruncated>
          <span className="w-10 shrink-0 truncate text-right text-caption tabular-nums" data-testid="plugin-meter-label">
            {label}
          </span>
        </Tip>
      )}
    </div>
  );
}
