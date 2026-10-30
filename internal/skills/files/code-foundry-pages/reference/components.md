# @cf/ui: the app's components

{{cf.provenance}}

For the code-foundry-pages skill: every export of `@cf/ui` (`/cf/ui.js`), the components the
app draws itself with (shadcn on Radix), and the props worth knowing. A name not on this
list does not exist: the import fails and the page shows the error. Each also takes
`className` (Tailwind classes, merged with `cn`) and its HTML element's or Radix part's props.
Icons come from `@cf/icons`: any lucide-react name (`Archive`, `GitPullRequest`, `Check`), sized
by `className="size-4"`; inside a Button they size themselves.

```tsx
import { Button, Dialog, DialogContent, DialogTitle } from "@cf/ui";
import { Archive } from "@cf/icons";
```

## Actions and text

- `Button`: `variant` default, secondary, outline, ghost, destructive or link; `size` default, xs, sm, lg, icon, icon-xs, icon-sm or icon-lg; `disabled`, `onClick`; `asChild` renders its child (an `<a>`) as the button.
- `buttonVariants`: the Button's classes as a function, `buttonVariants({ variant: "outline", size: "sm" })`, for a link that looks like a button.
- `Badge`: a small label; `variant` default, secondary, outline or destructive; `asChild`.
- `badgeVariants`: the Badge's classes as a function, like `buttonVariants`.
- `Kbd`: a key cap (`<Kbd>⌘K</Kbd>`); `variant` default or inherit (on a button: takes its colour); `size` default or sm.
- `KbdGroup`: a row of `Kbd`s.
- `Label`: a form label; `htmlFor`.
- `Separator`: a line; `orientation` horizontal or vertical.
- `Skeleton`: a pulsing placeholder block; size it with `className` (`h-4 w-32`).
- `Progress`: a bar; `value` 0 to 100, none for a sliding indeterminate bar.

## Layout

- `Card`: a raised, bordered box (flex column, gap and vertical padding built in); holds the parts below.
- `CardHeader`: title, description and an optional `CardAction` on the right.
- `CardTitle`: the card's heading.
- `CardDescription`: muted text under the title.
- `CardAction`: a button or menu at the header's right.
- `CardContent`: the body, padded on the sides.
- `CardFooter`: a row at the bottom.
- `Tabs`: `defaultValue` or `value` + `onValueChange`; holds a `TabsList` and a `TabsContent` per value.
- `TabsList`: the row of triggers.
- `TabsTrigger`: one tab; `value`.
- `TabsContent`: what a tab shows; `value`.
- `Collapsible`: show and hide a part; `open` + `onOpenChange` or `defaultOpen`.
- `CollapsibleTrigger`: what toggles it (`asChild` to use your own button).
- `CollapsibleContent`: what it shows and hides.

## Tables

- `Table`: a full-width table in a sideways-scrolling box.
- `TableHeader`: the `<thead>`.
- `TableBody`: the `<tbody>`.
- `TableFooter`: the `<tfoot>`, muted.
- `TableRow`: a row, highlighted on hover; `data-state="selected"` marks it.
- `TableHead`: a header cell.
- `TableCell`: a cell (no wrapping: add `whitespace-normal` for long text).
- `TableCaption`: a caption under the table.

## Forms

- `Input`: a text box; `value` + `onChange`, `placeholder`, `type` (password for a token).
- `Textarea`: a multi-line box, grows with its text.
- `Checkbox`: `checked` + `onCheckedChange(checked)`; pair with a `Label`; `checked="indeterminate"` draws a dash (some of a list ticked).
- `Switch`: `checked` + `onCheckedChange(checked)`; `size` default or sm.
- `RadioGroup`: `value` + `onValueChange`; `variant` default (a column of `RadioGroupItem`s) or segmented (a segmented control of `RadioGroupChoice`s).
- `RadioGroupItem`: a round radio; `value`.
- `RadioGroupChoice`: a segment or tile in a segmented group; `value`; `variant` segment or tile; children are its text and icon.
- `Slider`: `value` + `onValueChange` (arrays: `[50]`), `min`, `max`, `step`; act on `onValueCommit`, not on every move.
- `Toggle`: a pressable button; `pressed` + `onPressedChange`; `variant` default or outline; `size` default, xs, sm or lg.
- `Select`: `value` + `onValueChange`; holds a `SelectTrigger` (with a `SelectValue`) and a `SelectContent` of `SelectItem`s.
- `SelectTrigger`: the box that opens it; `size` default or sm.
- `SelectValue`: the chosen item's text; `placeholder`.
- `SelectContent`: the open list.
- `SelectItem`: one choice; `value` (a non-empty string).
- `SelectGroup`: a group of items.
- `SelectLabel`: a group's heading.
- `SelectSeparator`: a line between groups.
- `SelectScrollUpButton`: the list's scroll arrow (SelectContent has it already).
- `SelectScrollDownButton`: likewise.

## Overlays

These draw inside the page's card, never over the app: give the page room for a dialog or a long menu with a root `min-h-112` (448px; sizes go in 4px steps, `min-h-96` is 384px). An arbitrary value (`min-h-[420px]`) does nothing without `/cf/tailwind.js`.

- `Dialog`: `open` + `onOpenChange`, or a `DialogTrigger` inside it.
- `DialogTrigger`: what opens it (`asChild` around a `Button`).
- `DialogContent`: the panel, no padding of its own: `className="max-w-md p-5 flex flex-col gap-4"`. In a page it stops at the card's bottom edge and scrolls, so a long one keeps its buttons in reach.
- `DialogHeader`: title and description, stacked.
- `DialogTitle`: required for accessibility.
- `DialogDescription`: muted text under the title.
- `DialogFooter`: the buttons' row, at the end.
- `DialogClose`: closes it (`asChild` around a `Button`).
- `Popover`: `open` + `onOpenChange` or uncontrolled.
- `PopoverTrigger`: what opens it (`asChild`).
- `PopoverAnchor`: positions it against another element.
- `PopoverContent`: the floating panel, 240px wide, no padding of its own: `className="p-3"` (`w-72` wider); `align`, `side`, `sideOffset`.
- `DropdownMenu`: a menu on a button.
- `DropdownMenuTrigger`: what opens it (`asChild` around a `Button`).
- `DropdownMenuContent`: the menu; `align` start, center or end.
- `DropdownMenuItem`: an entry; `onSelect`; `variant` destructive; `disabled`.
- `DropdownMenuCheckboxItem`: a ticked entry; `checked` + `onCheckedChange`.
- `DropdownMenuLabel`: a heading in the menu.
- `DropdownMenuSeparator`: a line.
- `DropdownMenuShortcut`: a key hint at an entry's right.
- `DropdownMenuSub`: a submenu inside a menu.
- `DropdownMenuSubTrigger`: the entry that opens it (a chevron at its right).
- `DropdownMenuSubContent`: the submenu's entries.
- `ContextMenu`: a right-click menu around an area.
- `ContextMenuTrigger`: the area.
- `ContextMenuContent`: the menu.
- `ContextMenuItem`: an entry; `onSelect`; `variant` destructive.
- `ContextMenuSub`: a submenu.
- `ContextMenuSubTrigger`: the entry that opens it.
- `ContextMenuSubContent`: its menu.
- `ContextMenuLabel`: a heading.
- `ContextMenuSeparator`: a line.
- `TooltipProvider`: wrap the page's root in one, or no tooltip opens.
- `Tooltip`: `TooltipTrigger` + `TooltipContent` inside.
- `TooltipTrigger`: what it describes (`asChild`).
- `TooltipContent`: the tip, no padding of its own: `className="px-2.5 py-1.5 text-body-sm"`; `side`. Prefer `Tip`, which has it.
- `Tip`: the one-liner, `<Tip label="Archive"><Button size="icon" …/></Tip>`; `side`; only for what the trigger hides (an icon button).
- `Command`: a filterable list (cmdk): `CommandInput`, then a `CommandList` of `CommandGroup`s of `CommandItem`s.
- `CommandInput`: the search box; `placeholder`.
- `CommandList`: the scrolling list.
- `CommandEmpty`: what shows when nothing matches.
- `CommandGroup`: a group; `heading`.
- `CommandItem`: an entry; `onSelect`; `value` (what the filter matches).
- `CommandSeparator`: a line.
- `CommandShortcut`: a key hint.
- `Toaster`: sonner's toasts, drawn inside the page (not the app's): render one `<Toaster />` once, then call `toast`.
- `toast`: `toast("Archived")`, `toast.success(…)`, `toast.error(e.message)`; needs a `Toaster`.

## Helpers

- `cn`: joins class names and resolves Tailwind conflicts, knowing the type roles (`cn("text-caption", active && "text-cf-text")`).
