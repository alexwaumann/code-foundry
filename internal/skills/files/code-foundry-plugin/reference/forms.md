# Forms

{{cf.provenance}}

```go
url := ui.TextField("f-url", "url", "Server").WithPlaceholder("https://ci.acme.com").AsRequired().
	WithPattern("^https://", "An https URL").WithHint("Your CI server") // also WithValue, WithChange
url.Input.Mono = true
token := ui.SecretField("f-token", "token", "API token", "").WithStore("token") // the host keeps it under "token"
token.Input.HasValue = tokenIsSet
project := ui.Field{Key: "f-project", Name: "project", Label: "Project", Select: &ui.Select{OptionsSource: ui.OptionsProjects}}
env := ui.SelectField("f-env", "env", "Environment", ui.Opt("o-dev", "dev", "Development"), ui.Opt("o-prod", "prod", "Production"))
env.Select.Style, env.Select.Value = ui.SelectList, []string{"dev"}
notify := ui.NewFieldset("f-notify", "Notify me",
	ui.ToggleField("f-fail", "notifyFail", "When a run fails", true),
	ui.ToggleField("f-done", "notifyDone", "When a run finishes", false))
save := ui.EventButton("save", "Save", "save").WithStyle(ui.ButtonAttention)
form := ui.NewForm("settings", &save, url, token, project, env, notify)
form.Form.Secondary = []ui.Button{ui.EventButton("reset", "Reset", "reset")}
form.Form.ResetToken = strconv.Itoa(savedCount)
```

The one way values travel to the plugin. A field has a `key`, a `name` (its key in the
submitted values, or the command arg it fills), a label, a `description`, an `error` (the
plugin's validation message), `required`, `disabled`, and exactly one control:

- `input`: one-line text; `kind: "secret"` masks it, `kind: "multiline"`
  (`ui.MultilineField(key, name, label, rows)`; `rows` 2..12, default 4) is a box where
  Enter adds a line and cmd+Enter submits (not in a toolbar or footer), `kind: "number"`
  (`ui.NumberField`) takes a number that still arrives as a string, so parse it. Check
  `h.HasCapability("view.input.multiline")` (`view.input.number`, `view.input.date`)
  first: an older host refuses the kind. `kind: "date"` (`ui.DateField(key, name, label)`)
  is a day picked from a month calendar (the week starts where the user's locale starts it;
  quick picks Today, Tomorrow, next Monday, Clear): `value` is an ISO date
  (`time.DateOnly`, `ui.Date(t)`), "" for none; `.WithDateRange(min, max)` (ISO dates,
  either "") bounds the days offered. Validate refuses a value that is not an ISO date or
  lies outside the bounds, and the host refuses such a submit or change, so a non-empty
  value always parses with `time.Parse(time.DateOnly, v)`. A date has no `pattern`,
  `maxLength` or `mono`; it fits a toolbar or footer at its own width, and in the body's
  column it is as wide as the form. `value` (never for a secret),
  `placeholder`, `maxLength`, `pattern` (a regular expression, at most 256 characters,
  no quantified group holding a quantifier such as `(a+)+`, `(-[a-z]+)*` or `(a+){30}`
  (a fixed count over bounded ones, `([0-9]{1,3}\.){3}`, is fine): the GUI's JavaScript
  could take exponential time on it) with `patternMessage`, `mono`.
  `required`, `maxLength` and `pattern` are checked by the GUI as the user types;
  `plugin act --values` and other clients skip them, so the plugin validates every value
  again (and answers with a field `error` or an error).
- `select`: `options` (up to 200, each `key`, `value`, `label`, `description` in list
  style, `disabled`), `value` (a list: one value unless `multiple`), `multiple`, `style`
  `dropdown` (default; with `multiple`, a menu of checkboxes) or `list` (radio or
  checkbox rows with descriptions), `placeholder`. `optionsSource: "projects"` or `"threads"` makes the host fill the
  options (values are ids) and keep them current; `options` must then be empty. With
  `search` it is a **picker** the plugin searches (below).
- `toggle`: a switch, `value` true or false.
- `fieldset`: a label, `hint` and `error` over a group of fields (a checkbox group, a
  pair of related inputs). Fieldsets do not nest.

A field with `change: {"event": "…"}` sends a `change` act when the user commits an edit
(a text field on leaving it, a select, toggle or date on each pick; never per keystroke):
`act.Field` its name, `act.Value` the new value, for dependent fields; never for a
secret. `live: true` (`.WithChange("filter").AsLive()`, capability `view.input.live`; without
it the host sends the event on blur) sends it as the user types instead, once they pause
for 300 ms, for a filter that follows the text: one at a time, the latest last, so render
only from the `change` act and do no slow work in it. The **submit** button sends a `submit` act with every field's value in
`act.Values` by name: strings, booleans for toggles, string lists for multiple selects.
It may run a command instead (the fields fill its args by name) unless the form has a
secret field. `secondary` buttons act like any button. `error` shows under the form.
From submit until Act returns, the host disables the form and spins the submit itself;
for work that outlives the act, render the form with `busy` (every field and button
disabled) and the submit button with `busy` (its spinner), and drop both when it ends.

**Pickers.** A select with `search` (capability `view.select.search`) is a dropdown whose
options the plugin looks up as the user types: people, issues, labels.

```go
who := ui.PickerField("f-who", "assignee", "Assignee", "search-people", // the search act's event
	ui.Opt("sel-kim", "kim", "Kim Park").WithAvatar("K").InGroup("Selected"),
	ui.Opt("rec-me", "me", "Me").WithAvatar("A").WithDetail("you").InGroup("Recent"),
	ui.Opt("rec-bot", "bot", "Release bot").WithIcon("bot").AsDisabled().InGroup("Recent"),
).AsMultiple().WithValues("kim").WithChange("assignee").WithSearchPlaceholder("Search people").
	WithResults(query, matches...) // the answer to the last search ("" and none before one)
```

- Before typing it lists `options` under their `group` headings. From 2 characters
  (trimmed), once typing pauses for 250 ms, the host sends a `search` act
  (`pluginsdk.ActSearch`): `act.Key` the search's key (`PickerField` makes it the field's
  key + `-search`), `act.Action` its event, `act.Field` the field's name, `act.Query()` the
  query (2..200 characters), `act.Values` the form's values. One search is in flight at a
  time and the newest goes last; answer each with a view: `WithResults(act.Query(), …)`
  echoes the query in the search's `query` and lists the matches in its `results` (their
  own keys: an option in both lists takes two). The host shows results only while its box holds
  the echoed query, else "Searching…": an answer to an older query never shows. Keep the
  search fast (an index or a cache; the act times out like any other).
- An option takes a `group`, a `detail` (muted at the row's end, 40 characters), an
  `avatar` (one or two initials on a colour the host picks from the value) or an `icon`,
  and `disabled`; these are a picker's only. Up to 8 groups in `options` and 8 in
  `results`.
- A pick sends the field's `change` act like any select's (a multiple picker's value is
  the whole list, at most 20). A single picker closes on a pick; picking its value again
  clears it unless `required`. A multiple one stays open, shows the picks as tokens in its
  box (× or Backspace removes one). The trigger names picks by their labels: keep every
  picked value in `options` (a "Selected" group) so a later view still names it.
- In the body the trigger is the dropdown's. In a toolbar it is compact, the label then the
  picks ("Assignee  Me, Kim"); a toolbar form of only pickers is as wide as its triggers.
  The popover is the trigger's width in the body, 288 px from a toolbar; both fit the
  narrowest pane (480 px).

**Drafts.** The host keeps what the user typed (per instance and tab) across new views,
so re-rendering does not wipe a half-filled form. A submit the plugin takes drops the
form's drafts (the fields show the next view's values); a refused one keeps them: Act
returned an error (toasted), or the view after it has a field `error` or the form's
`error`. So answer bad values with field errors and the user's text stays under them.
Change `resetToken` to drop the drafts and show the view's values (a reset). The plugin
cannot read drafts: to follow what the user enters before submit, give the field a
`change` event.

**Secrets.** A secret input never carries a value. With `store: "<key>"` (letters, digits,
`.`, `_`, `-`, at most 64; permission `secrets`) the host writes the submitted value into the plugin's Keychain namespace
(before the plugin sees the submit, even if the plugin then refuses the other fields) and
`act.Values[name]` is `{"key": "<key>", "stored": true}`: `sk, ok := act.Stored(name)`.
The plugin reads the value with `h.Secrets().Get(ctx, key)` when it needs it. A secret left
empty on submit is left out (the stored one stays). Set `hasValue` to show "Saved · type
to replace". Without `store` the value reaches the plugin in the submit only.

