package plugintest

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Search types query into a picker (ui.Select.Search) of the instance's latest view, as
// the user would: the host sends the search act once query (trimmed) has
// ui.SearchMinChars characters, with the form's values. field is the picker field's key
// (or its search's). The plugin's answer is in Results once its next view arrives.
func (h *Host) Search(ctx context.Context, instance, field, query string) error {
	v, err := h.latest(instance)
	if err != nil {
		return err
	}
	f, form, ok := findField(v, func(f ui.Field) bool {
		return f.Select != nil && f.Select.Search != nil && (f.Key == field || f.Select.Search.Key == field)
	})
	if !ok {
		return fmt.Errorf("plugintest: no picker %q in the view of %s", field, instance)
	}
	q := strings.TrimSpace(query)
	if n := utf8.RuneCountInString(q); n < ui.SearchMinChars || n > ui.MaxSearchQuery {
		return fmt.Errorf("plugintest: the host sends a query of %d to %d characters, not %q", ui.SearchMinChars, ui.MaxSearchQuery, query)
	}
	s := f.Select.Search
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActSearch, Action: s.Event, Key: s.Key, Field: f.Name, Value: q,
		Values: formValues(form, "", nil)})
}

// Results returns what a picker of the instance's latest view lists for query (trimmed),
// as the host shows it: its Results when its Search echoes query, else ok is false (the
// host shows "Searching…").
func (h *Host) Results(instance, field, query string) (results []ui.Option, ok bool) {
	v, err := h.latest(instance)
	if err != nil {
		return nil, false
	}
	f, _, found := findField(v, func(f ui.Field) bool {
		return f.Select != nil && f.Select.Search != nil && (f.Key == field || f.Select.Search.Key == field)
	})
	if !found || f.Select.Search.Query != strings.TrimSpace(query) {
		return nil, false
	}
	return f.Select.Search.Results, true
}

// Pick sets a select's value as the user would in the instance's latest view, and sends
// its change act (the field needs a change event): one value for a single select, the
// whole list for a multiple one ([] clears it). Each value must be an option the field
// shows, not disabled: among its options or, for a picker, its results.
func (h *Host) Pick(ctx context.Context, instance, field string, values ...string) error {
	v, err := h.latest(instance)
	if err != nil {
		return err
	}
	f, form, ok := findField(v, func(f ui.Field) bool { return f.Select != nil && f.Key == field })
	if !ok {
		return fmt.Errorf("plugintest: no select %q in the view of %s", field, instance)
	}
	s := f.Select
	if f.Change == nil || f.Change.Event == "" {
		return fmt.Errorf("plugintest: select %q has no change event (its value goes with the form's submit)", field)
	}
	if !s.Multiple && len(values) != 1 {
		return fmt.Errorf("plugintest: select %q picks one value, not %d", field, len(values))
	}
	if s.Search != nil && len(values) > ui.MaxPicked {
		return fmt.Errorf("plugintest: picker %q holds at most %d values", field, ui.MaxPicked)
	}
	shown := slices.Clone(s.Options)
	if s.Search != nil {
		shown = append(shown, s.Search.Results...)
	}
	for _, val := range values {
		// A value already picked may stay without being shown (picked from an earlier search).
		if slices.Contains(s.Value, val) {
			continue
		}
		i := slices.IndexFunc(shown, func(o ui.Option) bool { return o.Value == val })
		if s.OptionsSource == "" && (i < 0 || shown[i].Disabled) {
			return fmt.Errorf("plugintest: %q is not an option select %q shows (or it is disabled)", val, field)
		}
	}
	var value any = strings.Join(values, ",")
	var picked any = slices.Clone(values)
	if !s.Multiple {
		picked = values[0]
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActChange, Action: f.Change.Event, Key: f.Key, Field: f.Name, Value: value,
		Data: f.Change.Data, Values: formValues(form, f.Name, picked)})
}

// latest decodes the instance's latest view.
func (h *Host) latest(instance string) (ui.View, error) {
	raw, ok := h.View(instance)
	if !ok {
		return ui.View{}, fmt.Errorf("plugintest: %s has no view", instance)
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		return ui.View{}, fmt.Errorf("plugintest: %s's view: %w", instance, err)
	}
	return v, nil
}

// findField finds the first field (in a fieldset too) that match accepts, and its form.
func findField(v ui.View, match func(ui.Field) bool) (ui.Field, *ui.Form, bool) {
	var found ui.Field
	n, ok := findNode(v, func(n ui.Node) bool {
		if n.Form == nil {
			return false
		}
		for _, f := range flatFields(n.Form.Fields) {
			if match(f) {
				found = f
				return true
			}
		}
		return false
	})
	if !ok {
		return ui.Field{}, nil, false
	}
	return found, n.Form, true
}

func flatFields(fs []ui.Field) []ui.Field {
	var out []ui.Field
	for _, f := range fs {
		if f.Fieldset != nil {
			out = append(out, f.Fieldset.Fields...)
			continue
		}
		out = append(out, f)
	}
	return out
}

// formValues are a form's values as the GUI sends them with a change or a search: every
// named, enabled field's value from the view (no secrets), with name's replaced by value.
func formValues(form *ui.Form, name string, value any) map[string]any {
	out := map[string]any{}
	for _, f := range flatFields(form.Fields) {
		if f.Name == "" || f.Disabled || (f.Input != nil && f.Input.Kind == ui.InputSecret) {
			continue
		}
		switch {
		case f.Name == name:
			out[f.Name] = value
		case f.Input != nil:
			out[f.Name] = f.Input.Value
		case f.Select != nil && f.Select.Multiple:
			out[f.Name] = append([]string{}, f.Select.Value...)
		case f.Select != nil:
			first := ""
			if len(f.Select.Value) > 0 {
				first = f.Select.Value[0]
			}
			out[f.Name] = first
		case f.Toggle != nil:
			out[f.Name] = f.Toggle.Value
		}
	}
	return out
}
