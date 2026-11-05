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

- `input`: one-line text; `kind: "secret"` masks it. `value` (never for a secret),
  `placeholder`, `maxLength`, `pattern` (a regular expression, at most 256 characters,
  no quantified group holding a quantifier such as `(a+)+` or `(-[a-z]+)*`: the GUI's
  JavaScript could take exponential time on it) with `patternMessage`, `mono`.
  `required`, `maxLength` and `pattern` are checked by the GUI as the user types;
  `plugin act --values` and other clients skip them, so the plugin validates every value
  again (and answers with a field `error` or an error).
- `select`: `options` (up to 200, each `key`, `value`, `label`, `description` in list
  style, `disabled`), `value` (a list: one value unless `multiple`), `multiple`, `style`
  `dropdown` (default; with `multiple`, a menu of checkboxes) or `list` (radio or
  checkbox rows with descriptions), `placeholder`. `optionsSource: "projects"` or `"threads"` makes the host fill the
  options (values are ids) and keep them current; `options` must then be empty.
- `toggle`: a switch, `value` true or false.
- `fieldset`: a label, `hint` and `error` over a group of fields (a checkbox group, a
  pair of related inputs). Fieldsets do not nest.

A field with `change: {"event": "…"}` sends a `change` act when the user commits an edit
(a text field on leaving it, a select or toggle on each pick; never per keystroke):
`act.Field` its name, `act.Value` the new value, for dependent fields; never for a
secret. The **submit** button sends a `submit` act with every field's value in
`act.Values` by name: strings, booleans for toggles, string lists for multiple selects.
It may run a command instead (the fields fill its args by name) unless the form has a
secret field. `secondary` buttons act like any button. `error` shows under the form.
From submit until Act returns, the host disables the form and spins the submit itself;
for work that outlives the act, render the form with `busy` (every field and button
disabled) and the submit button with `busy` (its spinner), and drop both when it ends.

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

