# Sidebar footer: on the pane's bottom edge, dot + version only

2026-10-19. Two feedback items on the sidebar's status row (`SidebarStatus.tsx`,
`DaemonStatus.tsx`).

## Alignment

The content pane floats a shell gap (12px) above the window's bottom edge; the status row
(24px tall) ended 6px above it, so its text and 14px glyphs straddled the pane's bottom
line. The row now ends 7px up (`pb-1.75`): a glyph box is 24px around a 14px glyph, so its
glyph ends exactly on the pane's bottom edge, the vertical twin of the Settings button's
`-mr-1.25` on the right edge (docs/notes/design-system-2-shell.md, "Edge icon buttons").
`layout.spec.ts` asserts `settings.bottom - 5 === pane.bottom`.

## Daemon status

The row showed "● daemon · pid N · version · up T", clipped at narrow widths with the
tooltip as a fallback. It now shows the dot and the version only; the tooltip (always,
`align="start"`) carries "daemon · pid N · up T", or "daemon unreachable · <error>" with a
red dot and no version (health is null then), or "connecting" with an amber dot. The dot
carries `data-status` for tests; the row's `aria-label` is the same string as the tooltip.
"syncing events…" (events stream not open) still shows inline after the version: it is a
transient warning, not daemon identity.

Gotcha: the first isolated daemon (CODE_FOUNDRY_HOME=/tmp/…) outlived the GUI relaunch and
served the second screenshot; `daemon.stop` through the CLI did not take it down, `kill`
did. Check `pgrep -f "bin/code-foundry daemon"` after a screenshot session.
