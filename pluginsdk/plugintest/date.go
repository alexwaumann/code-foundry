package plugintest

import (
	"context"
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
	v, err := h.latest(instance)
	if err != nil {
		return err
	}
	f, form, found := findField(v, func(f ui.Field) bool { return f.Key == key && f.Input != nil && f.Input.Kind == ui.InputDate })
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
	return h.Act(ctx, pluginsdk.SurfaceAct{
		Instance: instance, Kind: pluginsdk.ActChange, Action: f.Change.Event, Data: f.Change.Data,
		Key: f.Key, Field: f.Name, Value: day, Values: formValues(form, f.Name, day),
	})
}
