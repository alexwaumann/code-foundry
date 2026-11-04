/**
 * A quiet row: dimmed until hovered, selected or under the cursor. On the row itself (the
 * PRs tables), or on the content of a `group/row` row (the sidebar's Snoozed and Archived),
 * which keeps its own hover and selection background at full strength.
 */
export const QUIET = "opacity-60 hover:opacity-100 aria-selected:opacity-100 group-hover/row:opacity-100 group-aria-selected/row:opacity-100 group-data-cursor/row:opacity-100";
