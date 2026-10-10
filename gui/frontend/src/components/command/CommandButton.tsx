import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStartable, startCommandNamed } from "@/keys/bindings";
import { useCommandsStore } from "@/stores/commands";

type ButtonProps = ComponentProps<typeof Button>;

interface CommandButtonProps {
  /** Registry command name, e.g. "session.new". */
  command: string;
  icon: LucideIcon;
  /** Visible text. Omit for an icon-only button; the command's title is then its label. */
  label?: string;
  /** Tooltip; defaults to the command's title. Never a chord: those live in the palette and help. */
  title?: string;
  /** When the command is not available here: hide the button (default) or show it disabled. */
  whenUnavailable?: "hide" | "disable";
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
  title,
  whenUnavailable = "hide",
  keepFocus = true,
  variant = "ghost",
  size,
  className,
  pressed,
  count,
  "data-testid": testId,
}: CommandButtonProps) {
  const commandTitle = useCommandsStore((s) => s.commands.find((c) => c.name === command && isStartable(c))?.title ?? null);
  if (commandTitle === null && whenUnavailable === "hide") return null;
  const name = title ?? commandTitle ?? label ?? command;
  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (label ? "sm" : count !== undefined ? "xs" : "icon-xs")}
      className={className}
      disabled={commandTitle === null}
      title={name}
      aria-label={label ? undefined : count !== undefined ? `${name} (${String(count)})` : name}
      aria-pressed={pressed}
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
      <Icon aria-hidden className={label ? undefined : "size-3.5"} />
      {count !== undefined && (
        <span className="text-[11px] font-medium tabular-nums" aria-hidden data-count>
          {count}
        </span>
      )}
      {label}
    </Button>
  );
}
