# Wake sources

{{cf.provenance}}

## In the manifest

A wake source is an event an agent's thread waits for instead of polling: the agent runs
`code-foundry thread subscribe --plugin <name>/<source> [--arg k=v ...] [--repeat]`, the
host sends the plugin `wake/subscribed`, and the plugin fires the source (`h.FireWake`,
below) when the event happens; every subscribed thread whose args the fire's
match covers gets a `[code-foundry wake]` message. No permission is needed: a wake only
reaches threads that asked for it. `code-foundry plugin wakes <name>` lists them.

```json
"wakes": [
  {
    "name": "checks-done",
    "title": "Checks done",
    "description": "Every check on the pull request's head completed; the payload has the conclusion and the failed jobs.",
    "scope": "pr",
    "args": [
      { "name": "pr", "context": "pr", "required": true, "description": "owner/name#123" },
      { "name": "conclusion", "type": "enum", "enum": ["success", "failure"], "description": "Only this outcome" }
    ]
  }
]
```

| Field | Rules |
|---|---|
| `name` | Required, `[a-z0-9-]{1,64}`, unique. The subscription's target is `<plugin>/<name>`. |
| `title` | Required, up to 80 characters; `plugin wakes` and `thread subscriptions` show it. |
| `description` | Up to 300 characters: when it fires, what the payload carries. |
| `scope` | `global` (default), `thread`, `pr` or `project`: what one subscription is about. Descriptive; the args say which one. |
| `args` | Up to 16. Each: `name` (kebab case), `type` `string` (default), `int`, `bool`, `enum` (with `enum`) or `duration` (Go, over 0: `10s`), `description`, `required`, `default`, `context`. |

An arg with `context` (string args only) takes the subscribing thread's value when the
agent does not give it: `thread` its id, `project` its project's id, `pr` its pull request
as `owner/name#123` (lower-case slug; an agent may also give `#123`, `123` or the URL).
Otherwise the `default` is kept; a `required` arg left without a value refuses the
subscription, naming it. An optional arg without a value is absent, so that
subscription matches every fire of the source. Values are one line, at most 512 bytes.

`plugin wakes` prints each arg's type, `required`, and its default after it ("default
this thread's id", "… pull request", "… project" for a context arg, else the `default`
value), so an arg's `description` says what it selects ("Only this outcome"), never its
default.

## In the plugin: FireWake

A wake source lets an agent's thread wait for an event
instead of polling. The host keeps the subscriptions; the plugin watches for each one's
event and fires:

```go
pluginsdk.Plugin{
	// Sent when a thread subscribes, and again for every live subscription after each
	// start with s.Rearm set (the plugin re-arms here). Key state by s.Subscription; a
	// repeat is the same one.
	OnWakeSubscribed: func(ctx context.Context, h *pluginsdk.Host, s pluginsdk.WakeSubscription) {
		w.arm(s.Subscription, s.Source, s.Args["pr"]) // s.Context: the subscriber's thread, project
	},
	// Unsubscribed, a one-shot that fired, its thread archived: stop watching.
	OnWakeUnsubscribed: func(ctx context.Context, h *pluginsdk.Host, u pluginsdk.WakeUnsubscribed) {
		w.disarm(u.Subscription)
	},
	// Once per start, after the replay (count of them, 0 too): a subscription the plugin
	// saved in its data dir that was not replayed ended while it was down; drop it.
	OnWakeArmed: func(ctx context.Context, h *pluginsdk.Host, count int) {
		w.dropNotRearmed()
	},
}

// When the event happens: every subscription to the source whose args all equal the
// match's values is woken (fewer args match more broadly). It returns how many threads.
n, err := h.FireWake(ctx, "checks-done", map[string]string{"pr": "octo/app#12", "conclusion": "failure"},
	"3 of 12 checks failed", map[string]any{"failed": []string{"lint", "e2e"}})
```

- **Match**: name only the source's args. A subscription without an arg (an optional one
  the agent left out) matches any value of it. Fire once per distinct value set: one fire
  for `pr=octo/app#12` reaches every thread waiting on that pull request.
- The thread gets `[code-foundry wake] <display name>: <source> — <title>` and a JSON
  block `{kind: "plugin", subscription_id, plugin, source, args, title, payload,
  fired_at}`. Title: one line, at most 200 characters; payload: any JSON, at most 8 KiB
  (send ids and counts, not logs). At most 20 fires a second.
- A one-shot subscription (the default) goes after the first fire that reaches it (the
  plugin then gets `wake/unsubscribed`); `--repeat` stays. Each thread gets at most 60
  wakes an hour, whatever their source.
- Disabling, uninstalling or replacing the plugin, or an update that drops a source, ends
  its subscriptions with a last wake `… — source gone (<reason>)` (payload null).
- **Ordering.** Every wake notification, like everything else the host sends, reaches
  the plugin after `Init` has returned, in order: a re-arm finds what Init loaded. Keep
  only in-memory state, or save it in the data dir and let `OnWakeArmed` prune it; a timer
  to forget a subscription is not needed.
- **Advertise the source.** End every message, notice or timeline text the plugin sends
  about an event with `h.WakeHint(source, args)` (or `pluginsdk.WakeHint(plugin, source,
  args)`): the exact `code-foundry thread subscribe --plugin … --arg …` line, so an agent
  that reads "checks failed" waits for the next run instead of polling it. Never a flag
  reason: it is one line of at most 80 characters and the line does not fit; the
  failure's message or the surface's notice carries it.

