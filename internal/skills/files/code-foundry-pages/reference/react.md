# React pages, mockups and Tailwind

{{cf.provenance}}

For the code-foundry-pages skill: a page as a React app with the app's own components, no
build step; a mockup that looks like another product; the Tailwind runtime. Everything is
served by Code Foundry under `/cf/`, offline: never a CDN, never npm.

## What a page can load

| In the page | What it is |
|---|---|
| `<link rel="stylesheet" href="/cf/theme.css">` | the user's theme: `--cf-*` variables, type roles; follows theme switches |
| `<link rel="stylesheet" href="/cf/ui.css">` | the components' styles and the app's Tailwind utilities, after theme.css |
| `<script src="/cf/bridge.js"></script>` | `window.cf`; sizes the card to the page |
| `<script src="/cf/jsx.js"></script>` | the import map below, then compiles and runs every `text/tsx` script |
| `<script src="/cf/tailwind.js"></script>` | optional: any Tailwind utility, generated in the page |

Imports (`/cf/jsx.js` maps them; nothing else resolves, no other package exists):

- `react` and `react-dom/client` (`createRoot`): React 19, the app's own.
- `react-dom` (`createPortal`, `flushSync`); `react/jsx-runtime` is what JSX compiles to.
- `@cf/ui`: the components, `cn` and `toast`; `reference/components.md` lists every one.
- `@cf/icons`: all of lucide-react by name (`import { Archive, Check } from "@cf/icons"`).

## How /cf/jsx.js runs a page

- Put the code in `<script type="text/tsx">` (`text/jsx` and `text/babel` work too) after
  `/cf/jsx.js` in `<head>`. TypeScript and JSX are compiled in the page (types stripped,
  not checked); each script runs as a module, in document order, top-level `await` allowed.
  Scripts share no variables: write the app as one script.
- A syntax error, a failed import (a name `@cf/ui` does not export) or an uncaught error
  shows in a red box at the top of the page and in the console. The card shows it to the
  user too: fix the file, the card reloads.
- No charting or other library: draw charts as SVG in JSX (`<rect>`, `<path>`), coloured
  with `var(--cf-chart-1)` … `var(--cf-chart-6)`.
- `/cf/ui.css` has the components' own classes and everyday utilities (flex, grid, gap,
  padding, margin, `bg-cf-*`, `text-cf-*`, `border-cf-*`, the type roles, `rounded-*`, and
  `w-`, `h-`, `min-h-`, `max-h-` … in 4px steps up to 160: `min-h-112` is 448px).
  An arbitrary value (`min-h-[420px]`, `w-[217px]`, `grid-cols-[2fr_1fr]`) does nothing with
  it alone (view.inline warns): use the scale or a `style={{…}}`, or add `/cf/tailwind.js`
  for any utility (`ui.css` still first; it compiles in the page, about 130 ms).
- `dark:` follows the app's scheme. Paint with the cf colours (`bg-cf-surface-raised`,
  `text-cf-text-muted`, `border-cf-border`, `text-cf-success-text`), never `bg-white` or a
  hex: the user's theme decides, dark or light.

## The bridge in React

- Subscribe in an effect and return what `cf.on` returns: `useEffect(() => cf.on("gh",
  setDash, (e) => setError(e.message)), [])`. Await `cf.ready` at the top of the script,
  before `createRoot`.
- Call `cf.run` straight from the `onClick` (a press counts for 5 seconds): no `confirm()`,
  no Dialog that asks before merging or archiving: the app's own dialog does.
- Keep the row's id from when it was drawn, as in plain pages; rows stay put.
- `Dialog`, `Popover`, menus and toasts draw inside the card, not over the app: give the
  root a `min-h-112` when a dialog opens. Wrap the app in `<TooltipProvider>` for
  tooltips and render one `<Toaster />` for `toast`.

## Light only, or bigger

- **One scheme always** ("make it light only"): link `/cf/theme.css?scheme=light` (or
  `dark`). It serves the user's theme when it is of that scheme, else the default one, and
  the bridge keeps it when the app switches. Never redeclare `--cf-*` slots as hex: a page
  that sets some keeps the other scheme in the rest (inputs, controls, menus), and the
  components read names (`--primary`, `--card`) resolved from the slots on `:root`.
- **Bigger text** ("larger", "for a screen across the room"): `<html style="font-size: 18px">`
  (16px is normal). The type roles and every size and spacing utility are in rem, so the
  whole page scales together; never `font-size: … !important` on the roles.

## A board with actions: threads you can archive

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<link rel="stylesheet" href="/cf/ui.css">
<script src="/cf/bridge.js"></script>
<script src="/cf/jsx.js"></script>
<body class="text-body">
<div id="root"></div>
<script type="text/tsx">
  import { useEffect, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell,
    TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger } from "@cf/ui";
  import { Archive } from "@cf/icons";

  await cf.ready;

  type Thread = { id: string; name: string; status: string; archivedAtMs: number | null; lastActivityAtMs: number };

  function Row({ t }: { t: Thread }) {
    const [state, setState] = useState<{ busy?: boolean; note?: string; tone?: string }>({});
    const archive = () => {
      setState({ busy: true });
      // In the click, before any await: archiving changes something; the app asks when busy.
      cf.run("thread.archive", { id: t.id })
        .then(() => setState({ note: "archived" }))
        .catch((e) => setState({ note: e.code === "declined" ? "kept" : e.message, tone: e.code === "declined" ? "" : "text-cf-error-text" }));
    };
    return (
      <TableRow>
        <TableCell className="max-w-64 truncate">{t.name}</TableCell>
        <TableCell><Badge variant={t.status === "error" ? "destructive" : "secondary"}>{t.status}</Badge></TableCell>
        <TableCell className="text-right">
          {state.note ? <span className={state.tone || "text-cf-text-muted"}>{state.note}</span>
            : <Button size="sm" variant="outline" disabled={state.busy} onClick={archive}><Archive /> Archive</Button>}
        </TableCell>
      </TableRow>
    );
  }

  function App() {
    const [threads, setThreads] = useState<Thread[]>([]);
    const [error, setError] = useState("");
    useEffect(() => cf.on("thread-list", (list: Thread[]) => { setThreads(list); setError(""); }, (e) => setError(e.message)), []);
    // Stable order (by id), live ones only, never this page's own thread.
    const live = threads.filter((t) => !t.archivedAtMs && t.id !== cf.thread.id).sort((a, b) => a.id.localeCompare(b.id));
    const groups = { all: live, attention: live.filter((t) => t.status === "attention" || t.status === "error") };
    return (
      <Card className="m-3">
        <CardHeader><CardTitle>Threads</CardTitle><CardDescription>{live.length} open</CardDescription></CardHeader>
        <CardContent>
          {error && <p className="text-cf-error-text">{error}</p>}
          <Tabs defaultValue="all">
            <TabsList><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="attention">Needs you</TabsTrigger></TabsList>
            {Object.entries(groups).map(([key, rows]) => (
              <TabsContent key={key} value={key}>
                <Table>
                  <TableHeader><TableRow><TableHead>Thread</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>{rows.map((t) => <Row key={t.id} t={t} />)}</TableBody>
                </Table>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    );
  }

  createRoot(document.getElementById("root")!).render(<App />);
</script>
```

## A mockup of another product

When the user wants a screen of something else ("mock up the dashboard of a habit app, make it
look like a real product, not like Code Foundry"), the page brings its own look:

- Leave out `/cf/theme.css` and `/cf/ui.css`: no cf colours, no type roles, no `@cf/ui`
  (its components are unstyled without them). Pick a palette and a font stack of its own.
- Set the page's own background and `color-scheme` on `html`: without them the frame's
  default shows through.
- React, `@cf/icons` and `/cf/tailwind.js` still work; with the runtime, name the palette in
  a `<style type="text/tailwindcss">` `@theme` block (`--color-brand: #ff6b35;` gives
  `bg-brand`, `text-brand`). No `@import` in it: the runtime brings Tailwind.
- Keep `/cf/bridge.js` so the card fits the page's height; it changes nothing else here.

```html
<!doctype html>
<meta charset="utf-8">
<script src="/cf/bridge.js"></script>
<script src="/cf/tailwind.js"></script>
<script src="/cf/jsx.js"></script>
<style type="text/tailwindcss">
  @theme { --color-brand: #ff6b35; --color-ink: #1d1b16; --color-paper: #fbf7f0; --font-display: "Avenir Next", system-ui, sans-serif; }
  html { color-scheme: light; background: var(--color-paper); color: var(--color-ink); font-family: var(--font-display); }
</style>
<body>
<div id="root"></div>
<script type="text/tsx">
  import { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { Flame, Check } from "@cf/icons";

  function App() {
    const [done, setDone] = useState(false);
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="flex items-center gap-2 text-3xl font-bold"><Flame className="size-7 text-brand" /> Streaks</h1>
        <button onClick={() => setDone(!done)} className="mt-6 flex items-center gap-2 rounded-2xl bg-brand px-5 py-3 font-semibold text-white">
          <Check className="size-5" /> {done ? "Done today" : "Mark today"}
        </button>
      </main>
    );
  }
  createRoot(document.getElementById("root")!).render(<App />);
</script>
```

A mockup has no data of the user's: invent it, and say in the reply that it is a mockup.
