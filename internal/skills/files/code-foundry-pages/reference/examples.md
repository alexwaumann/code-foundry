# Example pages

{{cf.provenance}}

For the code-foundry-pages skill: complete pages to start from. Each is one file in
`$CODE_FOUNDRY_PAGES`, shown with `code-foundry view.inline <path>`. Check every verb's args
with `code-foundry help <verb>` and its JSON with `--json` before you change them. A list
with actions, a dashboard or a board is React with `@cf/ui` (the first, and `react.md`);
plain HTML is for something small (the others).

What they all do: every `cf.on` passes an `onError` that shows the refusal in the page;
every `cf.run` is caught and its message shown where it happened; a decline (`declined`)
is the user's no, shown muted with the button back, never in the error colour; a success
is said in the page's own words from `json`, never the CLI's `text` sentence.

## A dashboard with an action: open PRs, merge the green ones (React)

The `gh` source sends the dashboard whole, now and after every change: no polling. The
merge runs from the button's click; the app asks the user before it merges, and `head-sha`
refuses a PR that moved since the page drew it. Each row keeps its own state, so a merge
in flight or a decline stays on its row while the list updates.

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
    TableHead, TableHeader, TableRow } from "@cf/ui";
  import { GitMerge } from "@cf/icons";

  await cf.ready;

  type PR = { repoSlug: string; number: number; title: string; url: string; draft: boolean; mergeable: string;
    headSha: string; checks: { state: string } };
  const green = (pr: PR) => pr.checks.state === "success" && !pr.draft && pr.mergeable !== "conflicting";
  const tone = (state: string) => (state === "success" ? "default" : state === "failure" ? "destructive" : "secondary");

  function Row({ pr }: { pr: PR }) {
    const [note, setNote] = useState<{ text: string; tone: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const merge = () => {
      setBusy(true);
      // In the click handler, before any await: a merge changes something.
      cf.run("pr.merge", { "repo-slug": pr.repoSlug, number: pr.number, method: "merge", "head-sha": pr.headSha })
        .then(() => setNote({ text: "merged", tone: "text-cf-success-text" }))
        .catch((e) => setNote(e.code === "declined" ? { text: "not merged", tone: "muted" } : { text: e.message, tone: "text-cf-error-text" }))
        .finally(() => setBusy(false)); // the button back either way
    };
    return (
      <TableRow>
        <TableCell className="max-w-96 truncate"><a className="text-link" href={pr.url} target="_blank">{pr.repoSlug}#{pr.number} {pr.title}</a></TableCell>
        <TableCell><Badge variant={tone(pr.checks.state)}>{pr.checks.state}</Badge></TableCell>
        <TableCell className="text-right">
          {note && <span className={note.tone === "muted" ? "mr-2 text-cf-text-muted" : `mr-2 ${note.tone}`}>{note.text}</span>}
          {green(pr) && note?.text !== "merged" && <Button size="sm" disabled={busy} onClick={merge}><GitMerge /> Merge</Button>}
        </TableCell>
      </TableRow>
    );
  }

  // A stable order (repository, then number): rows never move under the pointer.
  const byKey = (a: PR, b: PR) => a.repoSlug.localeCompare(b.repoSlug) || a.number - b.number;

  function App() {
    const [dash, setDash] = useState<{ authenticated: boolean; authored: PR[] } | null>(null);
    const [error, setError] = useState("");
    useEffect(() => cf.on("gh", (d) => { setDash(d); setError(""); }, (e) => setError(e.message)), []);
    const prs = [...(dash?.authored ?? [])].sort(byKey);
    return (
      <Card className="m-3">
        <CardHeader>
          <CardTitle>My pull requests</CardTitle>
          <CardDescription>{dash ? `${prs.length} open, ${prs.filter(green).length} ready to merge` : "Loading…"}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && <p className="text-cf-error-text">{error}</p>}
          {dash && !dash.authenticated && <p className="text-cf-text-muted">Sign in to GitHub (gh auth login) to see your pull requests.</p>}
          {dash?.authenticated && prs.length === 0 && <p className="text-cf-text-muted">No open pull requests.</p>}
          {prs.length > 0 && (
            <Table>
              <TableHeader><TableRow><TableHead>Pull request</TableHead><TableHead>Checks</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{prs.map((pr) => <Row key={`${pr.repoSlug}#${pr.number}`} pr={pr} />)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    );
  }

  createRoot(document.getElementById("root")!).render(<App />);
</script>
```

To merge every green one with one button, start every `cf.run` inside that one click:
`await Promise.allSettled(prs.filter(green).map((pr) => cf.run("pr.merge", {...})))`. The
app asks once per PR.

## Something small in plain HTML: one live figure

A single number that follows the app needs no React: plain DOM and the theme's classes.

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script>
<body class="text-body">
<p class="text-overline">Ready to merge</p>
<p id="n" class="text-display">…</p>
<p id="err" class="text-caption" hidden></p>
<script type="module">
  await cf.ready;
  const n = document.getElementById("n");
  const err = document.getElementById("err");
  cf.on("gh", (dash) => {
    err.hidden = true;
    n.textContent = dash.authored.filter((pr) => pr.checks.state === "success" && !pr.draft).length;
  }, (e) => { err.textContent = e.message; err.hidden = false; });
</script>
```

## A form that creates threads

One `thread.new` per line, all started in the submit handler. The threads are this
thread's children, out of the user's sidebar (its thread info card lists them). A `request-id` per
line makes a second submit of the same line start nothing: it resolves with the thread
made the first time, which is a success, not an error.

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script>
<style>
  body { margin: 0; padding: 12px; }
  textarea { width: 100%; min-height: 120px; box-sizing: border-box; background: var(--cf-input); color: var(--cf-text); border: 1px solid var(--cf-border); border-radius: 6px; padding: 8px; font: inherit; }
  button { margin-top: 8px; background: var(--cf-accent); color: var(--cf-accent-foreground); border: 0; border-radius: 6px; padding: 6px 12px; }
  li.bad { color: var(--cf-error-text); }
</style>
<body class="text-body">
<form id="f">
  <label class="text-label" for="tasks">One task per line</label>
  <textarea id="tasks"></textarea>
  <button>Start a thread for each</button>
</form>
<ul id="done" class="text-body-sm"></ul>
<script type="module">
  await cf.ready;
  const draft = cf.storage("spawner");
  const tasks = document.getElementById("tasks");
  tasks.value = draft.get("text") ?? "";
  tasks.addEventListener("input", () => draft.set("text", tasks.value));
  // The same line gives the same key (at most 128 characters).
  const key = (line) => line.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 100);

  document.getElementById("f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const lines = tasks.value.split("\n").map((s) => s.trim()).filter(Boolean);
    // Every call starts here, inside the submit: an await between them would lose the gesture.
    const results = await Promise.allSettled(lines.map((line) =>
      cf.run("thread.new", { prompt: line, "request-id": "spawner-" + key(line) })));
    const out = document.getElementById("done");
    results.forEach((r, i) => {
      const li = document.createElement("li");
      // json is the thread (its --json); a repeated request-id resolves with the same one.
      if (r.status === "fulfilled") li.textContent = `Started: ${r.value.json?.name || lines[i]}`;
      else { li.textContent = `${lines[i]}: ${r.reason.message}`; li.className = "bad"; }
      out.append(li);
    });
  });
</script>
```

## A page that needs a token: an external API

The frame cannot sign in (no SSO or OAuth redirects, none of the browser's cookies), so the
page asks for an API token once and keeps it in `cf.storage`. `cf.fetch` sends the request
from Code Foundry, so it works whether or not the API allows the page's origin (most
company APIs do not). Linear's GraphQL API takes a personal API key in `Authorization`.

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script>
<style>
  body { margin: 0; padding: 12px; }
  input { background: var(--cf-input); color: var(--cf-text); border: 1px solid var(--cf-border); border-radius: 6px; padding: 4px 8px; }
  button { background: var(--cf-accent); color: var(--cf-accent-foreground); border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button.quiet { background: transparent; color: var(--cf-text-muted); }
  button:disabled { opacity: .5; cursor: default; }
  .muted { color: var(--cf-text-muted); } .bad { color: var(--cf-error-text); }
  ul { padding-left: 18px; } a { color: var(--cf-link); }
</style>
<body class="text-body">
<form id="ask" hidden>
  <p class="muted">Paste a Linear personal API key (Linear › Settings › Security & access).</p>
  <input id="key" type="password" autocomplete="off"> <button>Save</button>
</form>
<div id="bar" hidden>
  <button id="refresh">Refresh</button> <button id="forget" class="quiet">Forget the key</button>
  <span id="status" class="muted"></span>
</div>
<ul id="list"></ul>
<script type="module">
  await cf.ready;
  const store = cf.storage("linear");
  const $ = (id) => document.getElementById(id);
  const query = "{ viewer { assignedIssues(first: 50, filter: {state: {type: {nin: [\"completed\", \"canceled\"]}}}) { nodes { identifier title url state { name } } } } }";
  const say = (text, cls = "muted") => { $("status").textContent = text; $("status").className = cls; };

  function row(i) {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("a"), { href: i.url, target: "_blank", textContent: `${i.identifier} ${i.title}` }), ` · ${i.state.name}`);
    return li;
  }

  async function load() {
    const key = store.get("key");
    $("ask").hidden = !!key;
    $("bar").hidden = !key;
    if (!key) return;
    $("refresh").disabled = true;
    say("Loading…");
    try {
      // Code Foundry makes the request: no CORS. An object body is sent as JSON.
      const res = await cf.fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: key }, body: { query } });
      if (res.status === 401 || res.status === 403) {
        await store.remove("key");
        $("list").replaceChildren();
        $("ask").hidden = false;
        $("bar").hidden = false;
        say("Linear refused the key: paste a new one.", "bad");
        return;
      }
      const body = res.json(); // the body came back whole: no await needed
      if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? `${res.status} ${res.statusText}`);
      const issues = body.data.viewer.assignedIssues.nodes;
      $("list").replaceChildren(...issues.map(row));
      say(`${issues.length} open · updated ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      say(`Linear: ${e.message}`, "bad"); // failed (no answer), timeout, or the API's own error
    } finally {
      $("refresh").disabled = false;
    }
  }

  $("ask").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await store.set("key", $("key").value.trim());
    $("key").value = "";
    load();
  });
  $("refresh").addEventListener("click", load);
  $("forget").addEventListener("click", async () => {
    await store.remove("key");
    $("list").replaceChildren();
    load();
  });
  load();
</script>
```

`cf.fetch` needs no click (it changes nothing in Code Foundry), but refresh such a list
from a button the user clicks, not on a timer: a page runs only while it is on screen.
