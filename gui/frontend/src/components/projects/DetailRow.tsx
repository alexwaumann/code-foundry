import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useCopied } from "@/lib/useCopied";
import { cn } from "@/lib/utils";

/**
 * One fact of a Details-like card (a project's Details, a workspace's Instructions and
 * skills): label | value | its controls at the right. The row carries its own 12px padding
 * (the card has none), so the dividers run edge to edge. A truncated value shows in full in a
 * tooltip (`full`, when the value says it shorter: a tildified path), and only then. `icon`
 * goes before the label; `detail` follows the value, muted, after a dot ("· kept by the app").
 */
export function DetailRow({
  label,
  icon,
  value,
  full,
  detail,
  right,
  testId,
  valueTestId,
  data,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  full?: string;
  detail?: string;
  right?: React.ReactNode;
  testId: string;
  /** The value's test id; `<testId>-value` without one. */
  valueTestId?: string;
  data?: Record<`data-${string}`, string | undefined>;
}) {
  const shown = full ?? value;
  return (
    <div className="grid min-h-10 grid-cols-[8.25rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-cf-divider px-3 py-1 last:border-b-0" data-testid={testId} {...data}>
      {icon ? (
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-cf-text-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
          {icon}
          <span className="truncate" data-testid={`${testId}-label`}>
            {label}
          </span>
        </span>
      ) : (
        <span className="truncate text-caption text-cf-text-muted">{label}</span>
      )}
      <Tip label={detail ? `${shown} · ${detail}` : shown} whenTruncated>
        <span className="min-w-0 truncate text-body-sm text-cf-text-secondary" data-testid={valueTestId ?? `${testId}-value`}>
          {value}
          {detail && <span className="text-cf-text-muted"> · {detail}</span>}
        </span>
      </Tip>
      <span className="flex shrink-0 items-center gap-1">{right}</span>
    </div>
  );
}

/** The path's copy button: a check in the success colour for a moment after (lib/useCopied), no toast. */
export function CopyPath({ path, testId = "details-copy-path" }: { path: string; testId?: string }) {
  const { copied, copy } = useCopied();
  return (
    <Tip label={copied ? "Copied" : "Copy path"}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        tabIndex={-1}
        className={cn("size-7 [&_svg]:size-3.5", copied ? "text-cf-success-text hover:text-cf-success-text" : "text-cf-text-muted hover:text-cf-text")}
        aria-label="Copy path"
        data-testid={testId}
        data-copied={copied || undefined}
        onClick={() => void copy(path)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </Tip>
  );
}

/**
 * A Details row's text button at the right (View, Edit instructions, Browse marketplace): the
 * height and words of Open in Finder beside it. Other props (a Tip's trigger props, data-*)
 * pass through to the button.
 */
export function DetailButton({ testId, busy, className, children, ...props }: Omit<React.ComponentProps<typeof Button>, "variant" | "size"> & { testId: string; busy?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      tabIndex={-1}
      disabled={busy}
      className={cn("h-7 px-2 text-body-sm text-cf-text-secondary hover:text-cf-text", className)}
      data-testid={testId}
      {...props}
    >
      {children}
    </Button>
  );
}
