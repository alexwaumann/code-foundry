package plugintest

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// PickDate sends the change act the host sends when the user picks day (an ISO date,
// "2026-11-14"; "" is Clear) in the date field with key in the instance's latest view:
// Kind change, the field's event and data, Field its name, Value the day, and Values its
// form's fields (as the view holds them, secrets left out) with the day in place. It
// refuses what the host refuses: no such date field, no change event, not an ISO date,
// a day outside the field's min..max. A test of a submit puts the day in the submit's
// Values instead.
func (h *Host) PickDate(ctx context.Context, instance, key, day string) error {
	raw, ok := h.View(instance)
	if !ok {
		return fmt.Errorf("plugintest: instance %q has no view", instance)
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		return fmt.Errorf("plugintest: the view: %w", err)
	}
	f, form, found := dateField(v, key)
	if !found {
		return fmt.Errorf("plugintest: no date field %q in the view", key)
	}
	if f.Change == nil || f.Change.Event == "" {
		return fmt.Errorf("plugintest: date field %q has no change event (a pick reaches the plugin in its form's submit)", key)
	}
	if day != "" {
		if _, err := time.Parse(time.DateOnly, day); err != nil {
			return fmt.Errorf("plugintest: %q is not an ISO date (YYYY-MM-DD)", day)
		}
		if in := f.Input; (in.Min != "" && day < in.Min) || (in.Max != "" && day > in.Max) {
			return fmt.Errorf("plugintest: %s is outside %q..%q (the calendar does not offer it)", day, in.Min, in.Max)
		}
	}
	values := formValues(form)
	values[f.Name] = day
	return h.Act(ctx, pluginsdk.SurfaceAct{
		Instance: instance, Kind: pluginsdk.ActChange, Action: f.Change.Event, Data: f.Change.Data,
		Key: f.Key, Field: f.Name, Value: day, Values: values,
	})
}

// dateField finds the date field with key (in a fieldset too) and its form.
func dateField(v ui.View, key string) (ui.Field, *ui.Form, bool) {
	var walk func(ns []ui.Node) (ui.Field, *ui.Form, bool)
	walk = func(ns []ui.Node) (ui.Field, *ui.Form, bool) {
		for _, n := range ns {
			if n.Form != nil {
				for _, f := range flat(n.Form.Fields) {
					if f.Key == key && f.Input != nil && f.Input.Kind == ui.InputDate {
						return f, n.Form, true
					}
				}
			}
			for _, l := range n.Children() {
				if f, form, ok := walk(l); ok {
					return f, form, true
				}
			}
		}
		return ui.Field{}, nil, false
	}
	for _, l := range v.NodeLists() {
		if f, form, ok := walk(l); ok {
			return f, form, true
		}
	}
	return ui.Field{}, nil, false
}

// flat is a form's fields with each fieldset's fields in its place.
func flat(fs []ui.Field) []ui.Field {
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

// formValues are a form's named fields as the view holds them, as the GUI sends them in a
// change: text as strings, a select's one value or its list, a toggle's bool; secrets and
// disabled fields left out.
func formValues(form *ui.Form) map[string]any {
	out := map[string]any{}
	for _, f := range flat(form.Fields) {
		switch {
		case f.Name == "" || f.Disabled:
		case f.Input != nil && f.Input.Kind != ui.InputSecret:
			out[f.Name] = f.Input.Value
		case f.Select != nil && f.Select.Multiple:
			out[f.Name] = append([]string{}, f.Select.Value...)
		case f.Select != nil:
			v := ""
			if len(f.Select.Value) > 0 {
				v = f.Select.Value[0]
			}
			out[f.Name] = v
		case f.Toggle != nil:
			out[f.Name] = f.Toggle.Value
		}
	}
	return out
}
