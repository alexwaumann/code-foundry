/**
 * The view model's figure nodes (pluginsdk/ui charts.go): stats, a row of figure cards,
 * and bars, a small bar chart in a card. docs/notes/plugin-stats-bars.md.
 */
import type { Inline, Status, Tone, ViewAction } from "./plugin";

/** One figure card: a label over a value the plugin formats ("4m 12s"), a subtitle; with an action a toggle. */
export interface StatCard {
  key: string;
  label: string;
  value: string;
  tone?: Tone;
  subtitle?: Inline;
  action?: ViewAction;
  /** A toggle that is on (only with an action). */
  pressed?: boolean;
}

/** 1 to 6 figure cards in a row that wraps onto balanced rows. */
export interface StatsData {
  cards: StatCard[];
}

/** One bar: a finite value ≥ 0, a status or a chart palette series (1..5), its tooltip's title and meta line. */
export interface Bar {
  key: string;
  value: number;
  status?: Status;
  series?: number;
  title: string;
  meta?: Inline;
  action?: ViewAction;
}

export interface BarsReference {
  value: number;
  label?: string;
}

/** Up to 120 bars in a card: title, subtitle, a reference line, the axis' first and last labels. */
export interface BarsData {
  title?: string;
  subtitle?: Inline;
  bars: Bar[];
  reference?: BarsReference;
  startLabel?: string;
  endLabel?: string;
}
