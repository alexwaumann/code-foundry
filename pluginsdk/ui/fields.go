package ui

// With… helpers for form fields: each returns a copy of the field with one option set,
// so a field reads as one expression:
//
//	ui.TextField("f-branch", "branch", "Branch").WithPlaceholder("main").AsRequired().
//		WithPattern(`^[\w./-]+$`, "A branch name")
//
// An option the field's control does not have (a pattern on a toggle) leaves it as it is.

// WithValue returns f with its current value: a text input's text, a select's one
// selected option value, a toggle's state ("true"). A secret input never carries one.
func (f Field) WithValue(v string) Field {
	switch {
	case f.Input != nil && f.Input.Kind != InputSecret:
		in := *f.Input
		in.Value = v
		f.Input = &in
	case f.Select != nil:
		s := *f.Select
		s.Value = []string{v}
		f.Select = &s
	case f.Toggle != nil:
		f.Toggle = &Toggle{Value: v == "true"}
	}
	return f
}

// WithPlaceholder returns f with placeholder text (a text or secret input, a select).
func (f Field) WithPlaceholder(p string) Field {
	switch {
	case f.Input != nil:
		in := *f.Input
		in.Placeholder = p
		f.Input = &in
	case f.Select != nil:
		s := *f.Select
		s.Placeholder = p
		f.Select = &s
	}
	return f
}

// WithHint returns f with a one-line hint under it (a fieldset's hint for a fieldset).
func (f Field) WithHint(text string) Field {
	if f.Fieldset != nil {
		fs := *f.Fieldset
		fs.Hint = Plain(text)
		f.Fieldset = &fs
		return f
	}
	f.Description = Plain(text)
	return f
}

// AsRequired returns f marked required: the panel does not submit the form while it is
// empty and says so under the field.
func (f Field) AsRequired() Field { f.Required = true; return f }

// WithPattern returns f with a regular expression its text must match (a text input),
// checked by the panel on submit, and the message shown under it when it does not.
func (f Field) WithPattern(pattern, message string) Field {
	if f.Input != nil {
		in := *f.Input
		in.Pattern, in.PatternMessage = pattern, message
		f.Input = &in
	}
	return f
}

// WithStore returns a secret input that the host stores on submit under key in the
// plugin's secrets (permission secrets): the submit carries {key, stored: true}.
func (f Field) WithStore(key string) Field {
	if f.Input != nil && f.Input.Kind == InputSecret {
		in := *f.Input
		in.Store = key
		f.Input = &in
	}
	return f
}

// WithChange returns f sending event to the plugin when its value changes (a change
// act with the field's name and value).
func (f Field) WithChange(event string) Field { f.Change = EventAction(event, ""); return f }
