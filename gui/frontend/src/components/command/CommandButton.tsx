import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { isStartable, startCommandNamed } from "@/keys/bindings";
import { useCommandsStore } from "@/stores/commands";

type ButtonProps = ComponentProps<typeof Button>;

interface CommandButtonProps {
  /** Registry command name, e.g. "session.new". */
  command: string;
  /** The button's icon; omit it when `children` draws the whole content. */
  icon?: LucideIcon;
  /** Visible text. Omit for an icon-only button; the command's title is then its label. */
  label?: string;
  /** Tooltip of an icon-only button; defaults to the command's title. A button with a label has none. Never a chord: those live in the palette and help. */
  tooltip?: string;
  /**
   * Content drawn instead of the icon and label (a thread's name, its project and branch).
   * Visible, so the button has no tooltip; its text is its accessible name.
   */
  children?: ReactNode;
  /**
   * When the command is not available here: hide the button (default), show it disabled,
   * or show `children` as plain, non-interactive text (a span with `className`).
   */
  whenUnavailable?: "hide" | "disable" | "plain";
  /**
   * Keep keyboard focus where it is (default): the button is skipped by Tab and a click
   * does not move focus, so the sidebar tree and the terminal keep theirs.
   */
  keepFocus?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** For toggles: rendered as aria-pressed. */
  pressed?: boolean;
  /** For page buttons (view.*): the page is showing; rendered as aria-current="page". */
  current?: boolean;
  /** A small number after the icon (e.g. how many items the command shows); part of the label. */
  count?: number;
  "data-testid"?: string;
}

/**
 * A button for a registry command. It does exactly what picking the command in the
 * palette does (startCommand: GUI presenters, arg prompts, confirmation), so it adds no
 * user action of its own. Availability comes from CommandService.List for the current
 * context (isStartable: available, or presented with a context of its own).
 */
export function CommandButton({
  command,
  icon: Icon,
  label,
  children,
  tooltip,
  whenUnavailable = "hide",
  keepFocus = true,
  variant = "ghost",
  size,
  className,
  pressed,
  current,
  count,
  "data-testid": testId,
}: CommandButtonProps) {
  const commandTitle = useCommandsStore((s) => s.commands.find((c) => c.name === command && isStartable(c))?.title ?? null);
  if (commandTitle === null && whenUnavailable === "hide") return null;
  if (commandTitle === null && whenUnavailable === "plain")
    return (
      <span className={className} data-command-plain={command} data-testid={testId}>
        {children}
      </span>
    );
  const name = tooltip ?? commandTitle ?? label ?? command;
  // Visible text (a label or custom content) names the button itself: no tooltip.
  const visible = Boolean(label) || children !== undefined;
  const button = (
    <Button
      type="button"
      variant={variant}
      size={size ?? (visible ? "sm" : count !== undefined ? "xs" : "icon-xs")}
      className={className}
      disabled={commandTitle === null}
      aria-label={visible ? undefined : count !== undefined ? `${name} (${String(count)})` : name}
      aria-pressed={pressed}
      aria-current={current ? "page" : undefined}
      tabIndex={keepFocus ? -1 : undefined}
      data-command-button={command}
      data-testid={testId}
      onMouseDown={
        keepFocus
          ? (e) => {
              e.preventDefault();
            }
          : undefined
      }
      onClick={() => {
        startCommandNamed(command);
      }}
    >
      {Icon && <Icon aria-hidden className={label ? undefined : "size-3.5"} />}
      {count !== undefined && (
        <span className="text-caption-sm font-medium text-inherit tabular-nums" aria-hidden data-count>
          {count}
        </span>
      )}
      {label}
      {children}
    </Button>
  );
  if (visible) return button;
  // An icon-only button names itself in a tooltip (and aria-label). A disabled button gets
  // no pointer events, so a disabled one is hovered through a span around it.
  return <Tip label={name}>{commandTitle === null ? <span className="inline-flex">{button}</span> : button}</Tip>;
}
