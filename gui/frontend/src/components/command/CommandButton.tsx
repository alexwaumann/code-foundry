import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { isStartable, startCommandNamed } from "@/keys/bindings";
import { useCommandsStore } from "@/stores/commands";

type ButtonProps = ComponentProps<typeof Button>;

interface CommandButtonProps {
  /** Registry command name, e.g. "thread.new". */
  command: string;
  /** The button's icon; omit it when `children` draws the whole content. */
  icon?: LucideIcon;
  /** Tooltip of an icon-only button; defaults to the command's title. A button with content has none. Never a chord: those live in the palette and help. */
  tooltip?: string;
  /** Which side an icon-only button's tooltip floats to; defaults to Tip's. */
  tooltipSide?: ComponentProps<typeof Tip>["side"];
  /** Dim the button although the command is listed: running it here would do nothing. */
  disabled?: boolean;
  /**
   * Content drawn instead of the icon and label (a thread's name, its project and branch).
   * Visible, so the button has no tooltip; its text is its accessible name.
   */
  children?: ReactNode;
  /** When the command is not available here: hide the button (default) or show it disabled. */
  whenUnavailable?: "hide" | "disable";
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** For toggles: rendered as aria-pressed. */
  pressed?: boolean;
  /** For page buttons (view.*): the page is showing; rendered as aria-current="page". */
  current?: boolean;
  "data-testid"?: string;
}

/**
 * A button for a registry command. It does exactly what picking the command in the
 * palette does (startCommand: GUI presenters, arg prompts, confirmation), so it adds no
 * user action of its own. It keeps keyboard focus where it is: the button is skipped by
 * Tab and a click does not move focus, so the sidebar tree and the terminal keep theirs. Availability comes from CommandService.List for the current
 * context (isStartable: available, or presented with a context of its own).
 */
export function CommandButton({
  command,
  icon: Icon,
  children,
  tooltip,
  tooltipSide,
  disabled = false,
  whenUnavailable = "hide",
  variant = "ghost",
  size,
  className,
  pressed,
  current,
  "data-testid": testId,
}: CommandButtonProps) {
  const commandTitle = useCommandsStore((s) => s.commands.find((c) => c.name === command && isStartable(c))?.title ?? null);
  if (commandTitle === null && whenUnavailable === "hide") return null;
  const name = tooltip ?? commandTitle ?? command;
  const dimmed = disabled || commandTitle === null;
  // Visible content names the button itself: no tooltip.
  const visible = children !== undefined;
  const button = (
    <Button
      type="button"
      variant={variant}
      size={size ?? (visible ? "sm" : "icon-xs")}
      className={className}
      disabled={dimmed}
      aria-label={visible ? undefined : name}
      aria-pressed={pressed}
      aria-current={current ? "page" : undefined}
      tabIndex={-1}
      data-command-button={command}
      data-testid={testId}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={() => {
        startCommandNamed(command);
      }}
    >
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </Button>
  );
  if (visible) return button;
  // An icon-only button names itself in a tooltip (and aria-label). A disabled button gets
  // no pointer events, so a disabled one is hovered through a span around it.
  return (
    <Tip label={name} side={tooltipSide}>
      {dimmed ? <span className="inline-flex">{button}</span> : button}
    </Tip>
  );
}
