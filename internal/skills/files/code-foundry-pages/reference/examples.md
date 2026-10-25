# Example pages

{{cf.provenance}}

For the code-foundry-pages skill: three complete pages to start from. Each is one file in
`$CODE_FOUNDRY_PAGES`, shown with `code-foundry view.inline <path>`. Check every verb's args
with `code-foundry help <verb>` and its JSON with `--json` before you change them.

What they all do: every `cf.on` passes an `onError` that shows the refusal in the page;
every `cf.run` is caught and its message shown where it happened; a decline (`declined`)
is the user's no, shown muted with the button back, never in the error colour; a success
is said in the page's own words from `json`, never the CLI's `text` sentence.

## A live list with an action: open PRs, merge the green ones

The `gh` source sends the dashboard whole, now and after every change: no polling. The
merge runs from the button's click; the app asks the user before it merges, and `head-sha`
refuses a PR that moved since the page drew it.

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/cf/theme.css">
<script src="/cf/bridge.js"></script>
<style>
  body { margin: 0; padding: 12px; }
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--cf-border); }
  .row a { color: var(--cf-link); flex: 1; }
  .muted { color: var(--cf-text-muted); }
  .ok { color: var(--cf-success-text); } .bad { color: var(--cf-error-text); }
  button { background: var(--cf-accent); color: var(--cf-accent-foreground); border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
<body class="text-body">
<div id="list" class="muted">Loading pull requests…</div>
<p id="err" class="bad" hidden></p>
<script type="module">
  await cf.ready;
  const list = document.getElementById("list");
  const err = document.getElementById("err");
  const green = (pr) => pr.checks.state === "success" && !pr.draft && pr.mergeable !== "conflicting";

  function row(pr) {
    const el = document.createElement("div");
    el.className = "row";
    const link = Object.assign(document.createElement("a"), { href: pr.url, target: "_blank", textContent: `${pr.repoSlug}#${pr.number} ${pr.title}` });
    const state = Object.assign(document.createElement("span"), { textContent: pr.checks.state, className: green(pr) ? "ok" : pr.checks.state === "failure" ? "bad" : "muted" });
    el.append(link, state);
    if (green(pr)) {
      const btn = Object.assign(document.createElement("button"), { textContent: "Merge" });
      btn.addEventListener("click", () => {
        btn.disabled = true;
        // In the click handler, before any await: a merge changes something.
        cf.run("pr.merge", { "repo-slug": pr.repoSlug, number: pr.number, method: "merge", "head-sha": pr.headSha })
          .then(() => { state.textContent = "merged"; state.className = "ok"; btn.remove(); })
          .catch((e) => {
            btn.disabled = false; // the button back either way
            state.textContent = e.code === "declined" ? "not merged" : e.message;
            state.className = e.code === "declined" ? "muted" : "bad";
          });
      });
      el.append(btn);
    }
    return el;
  }

  // A stable order (repository, then number): rows never move under the pointer.
  const byKey = (a, b) => a.repoSlug.localeCompare(b.repoSlug) || a.number - b.number;
  cf.on("gh", (dash) => {
    err.hidden = true;
    if (!dash.authenticated) { list.textContent = "Sign in to GitHub (gh auth login) to see your pull requests."; return; }
    if (dash.authored.length === 0) { list.textContent = "No open pull requests."; return; }
    list.className = "";
    list.replaceChildren(...[...dash.authored].sort(byKey).map(row));
  }, (e) => { err.textContent = e.message; err.hidden = false; });
</script>
```

To merge every green one with one button, start every `cf.run` inside that one click:
`await Promise.allSettled(prs.filter(green).map((pr) => cf.run("pr.merge", {...})))`. The
app asks once per PR.

## A form that creates threads

One `thread.new` per line, all started in the submit handler. The threads are this
thread's children; `sidebar: true` shows them in the user's sidebar. A `request-id` per
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
      cf.run("thread.new", { prompt: line, sidebar: true, "request-id": "spawner-" + key(line) })));
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
