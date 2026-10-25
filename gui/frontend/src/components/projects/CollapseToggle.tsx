import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * The chevron at the left of a project or workspace header. Mouse-down keeps the focus
 * where it is (the list, so the arrow keys keep working); disabled while the filter shows
 * everything that matches expanded.
 */
export function CollapseToggle({ collapsed, disabled, onToggle, testId, label }: { collapsed: boolean; disabled: boolean; onToggle: () => void; testId: string; label: string }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      disabled={disabled}
      data-testid={testId}
      className="-ml-1 flex size-[18px] shrink-0 items-center justify-center rounded-sm text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-3.5"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onDoubleClick={(e) => {
        // Quick toggles must not open the row's panel tab.
        e.stopPropagation();
      }}
      onClick={onToggle}
    >
      <Chevron aria-hidden />
    </button>
  );
}
