# Thread info card: MCP row

(The trigger zone below is gone: since `docs/notes/thread-info-row-menus.md` the whole row
opens the menu, whose first item is Open MCP panel.)

The card's MCP row read `2 connected · 1 needs login · 1 failed` on one line, and only the
chevron opened its Refresh / Reconnect menu. The attention counts now sit in the row's
value column, and the value and the chevron are one menu trigger.

## Decisions

- **Left text is the connected count.** `2 connected`, the number in the text colour and
  `connected` muted, as the clean state styles it. The clean state is unchanged:
  `6 servers connected`, no value.
- **Value column holds the attention counts.** `1 needs login` (`text-cf-warning-text`)
  then `1 failed` (`text-cf-error-text`), each only when above zero, `gap-1.5`, no dot
  separators. They are spans with `ti-mcp-needs-login` / `ti-mcp-failed` inside the Row's
  `ti-mcp-meta`. The plug keeps its worst-state colour.
- **One trigger zone.** `Row` gained `menuOnMeta` (with `menuOnChevron`, a `meta` and a
  chevron): the value and the chevron render inside one span (`<testId>-menu-zone`) that
  carries `data-row-chevron` and the hover tint (`hover:bg-cf-text/10`, `rounded-md`, the
  row's full height via `self-stretch`, `-mr-1` so it reaches the row's right edge). The
  existing `fromChevron` check (`closest("[data-row-chevron]")`) then covers the value
  with no other change: a press there opens the menu, a press anywhere else is the row's
  click (the MCP tab). The chevron inside a zone drops its own marker and tint and turns
  `text-cf-text` on the zone's hover (`group-hover/zone`). The zone keeps `gap-2` between
  value and chevron and `pl-2`, so the value's right edge stays on the other rows' value
  line (the e2e test pins it against Usage's value).
- **Other rows render exactly as before.** Without `menuOnMeta` (or with no value, as in
  the clean state) Row emits the same DOM as it did: meta, trailing, chevron. Only the MCP
  row sets it.
- **Keyboard unchanged.** Enter and Space on the row open the MCP tab; ArrowDown opens the
  menu (Radix's trigger key handling, untouched).
- **Reconnect stays failed-only.** A server needing a login cannot be fixed headlessly, so
  the menu does not offer it.

## Tests

- `e2e/thread-info.spec.ts`: a new test over s-r1 (two connected, linear needs a login,
  playwright failed): text, value and their colours; value alignment with Usage's value;
  zone hover tint; value press opens the menu and not the tab; Reconnect playwright
  reaches the mock (`mcp-reconnect s-r1 playwright`) and the row updates to
  `3 connected` / `1 needs login`; chevron and ArrowDown open the menu; a press on the text
  opens the MCP tab. The single-project test asserts the left text exactly.
- `e2e/mcp-panel.spec.ts`: the card-row click targets the text span, since the row's
  centre can now land in the value zone.
