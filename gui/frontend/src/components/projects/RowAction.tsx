import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A small icon button for a row action, named by its tooltip (mouse; the keyboard reaches the same commands through the palette). */
export function RowAction({
  label,
  onClick,
  children,
  destructive,
  disabled,
  testId,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const button = (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text disabled:hover:bg-transparent [&_svg]:size-3.5",
        destructive && "hover:text-cf-error-text",
        className,
      )}
      onDoubleClick={(e) => {
        // Quick repeated clicks must not open the row's panel tab.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
  // A disabled button gets no pointer events: its tooltip hangs on a span around it.
  return <Tip label={label}>{disabled ? <span className="flex shrink-0">{button}</span> : button}</Tip>;
}
