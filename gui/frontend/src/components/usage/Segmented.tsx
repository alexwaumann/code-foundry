import { cn } from "@/lib/utils";

interface SegmentedProps<T extends string | number> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  /** Each option's test id is `${testId}-${value}`. */
  "data-testid"?: string;
  className?: string;
}

/** A small segmented control (the Usage page's range and Tokens / Cost): pressed buttons in a bordered strip. */
export function Segmented<T extends string | number>({ options, value, onChange, className, "aria-label": label, "data-testid": testId }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex gap-0.5 rounded-md border border-cf-border p-0.5 text-caption-sm font-medium [--wails-draggable:no-drag]", className)} data-testid={testId}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            className={cn("rounded-sm px-2 py-0.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50", on ? "bg-cf-surface-sunken text-cf-text" : "text-cf-text-muted hover:text-cf-text")}
            onClick={() => {
              onChange(o.value);
            }}
            data-testid={testId ? `${testId}-${String(o.value)}` : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
