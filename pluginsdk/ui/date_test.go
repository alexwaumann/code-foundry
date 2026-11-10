package ui

import (
	"strings"
	"testing"
	"time"
)

func TestDateInput(t *testing.T) {
	form := func(f Field) Node { return Node{Key: "form", Form: &Form{Fields: []Field{f}}} }
	due := DateField("f-due", "due", "Due")
	tests := []struct {
		name    string
		field   Field
		toolbar bool
		want    string // a problem Validate must name; "" when the view is fine
	}{
		{name: "empty", field: due},
		{name: "a value", field: due.WithValue("2026-11-14")},
		{name: "a value in range", field: due.WithValue("2026-11-14").WithDateRange("2026-11-01", "2026-11-30")},
		{name: "on the bounds", field: due.WithValue("2026-11-01").WithDateRange("2026-11-01", "2026-11-01")},
		{name: "open below", field: due.WithValue("1999-01-01").WithDateRange("", "2026-11-30")},
		{name: "open above", field: due.WithValue("2999-01-01").WithDateRange("2026-11-01", "")},
		{name: "a leap day", field: due.WithValue("2028-02-29")},
		{name: "a placeholder and required", field: due.WithPlaceholder("No due date").AsRequired()},
		{name: "a change event, live", field: due.WithChange("due").AsLive()},
		{name: "in a toolbar", field: due.WithChange("since"), toolbar: true},
		{name: "not a date", field: due.WithValue("tomorrow"), want: `input.value: "tomorrow" is not an ISO date`},
		{name: "not a real day", field: due.WithValue("2026-02-30"), want: "input.value: \"2026-02-30\" is not an ISO date"},
		{name: "a time", field: due.WithValue("2026-11-14T10:00:00Z"), want: "is not an ISO date"},
		{name: "short", field: due.WithValue("2026-1-4"), want: "is not an ISO date"},
		{name: "a bad min", field: due.WithDateRange("soon", ""), want: "input.min: \"soon\" is not an ISO date"},
		{name: "a bad max", field: due.WithDateRange("", "2026/11/30"), want: "input.max:"},
		{name: "min after max", field: due.WithDateRange("2026-12-01", "2026-11-01"), want: "input.min: 2026-12-01 is after max 2026-11-01"},
		{name: "before min", field: due.WithValue("2026-10-31").WithDateRange("2026-11-01", ""), want: "input.value: 2026-10-31 is before min 2026-11-01"},
		{name: "after max", field: due.WithValue("2026-12-01").WithDateRange("", "2026-11-30"), want: "input.value: 2026-12-01 is after max 2026-11-30"},
		{name: "a pattern", field: Field{Key: "f", Name: "n", Input: &Input{Kind: InputDate, Pattern: `^\d+$`}}, want: "a date input has no pattern"},
		{name: "WithPattern leaves a date input as it is", field: due.WithPattern(`^\d+$`, "digits")},
		{name: "mono", field: Field{Key: "f", Name: "n", Input: &Input{Kind: InputDate, Mono: true}}, want: "a date input has no pattern, maxLength or mono"},
		{name: "rows", field: Field{Key: "f", Name: "n", Input: &Input{Kind: InputDate, Rows: 4}}, want: "rows are for multiline"},
		{name: "live without a change", field: due.AsLive(), want: "needs a change event"},
		{name: "min on a text input", field: Field{Key: "f", Name: "n", Input: &Input{Min: "2026-11-01"}}, want: "min and max are for date inputs"},
		{name: "a long bad value is cut", field: due.WithValue(strings.Repeat("9", 300)), want: "is not an ISO date"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := View{Nodes: []Node{form(tt.field)}}
			if tt.toolbar {
				v = View{Toolbar: []Node{form(tt.field)}, Nodes: []Node{}}
			}
			err := v.Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate() = %v, want nil", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate() = %v, want it to name %q", err, tt.want)
			}
			if err != nil && len(err.Error()) > 400 {
				t.Errorf("a long problem: %d bytes", len(err.Error()))
			}
		})
	}
}

func TestDateBuilders(t *testing.T) {
	if got := Date(time.Date(2026, 3, 7, 23, 59, 0, 0, time.UTC)); got != "2026-03-07" {
		t.Errorf("Date = %q", got)
	}
	base := DateField("f", "n", "Due")
	r := base.WithDateRange("2026-01-01", "2026-12-31")
	if r.Input.Min != "2026-01-01" || r.Input.Max != "2026-12-31" || base.Input.Min != "" {
		t.Errorf("WithDateRange must set the copy only: %+v, %+v", r.Input, base.Input)
	}
	if f := TextField("f", "n", "Q").WithDateRange("2026-01-01", ""); f.Input.Min != "" {
		t.Errorf("WithDateRange on a text field set min: %+v", f.Input)
	}
	if f := base.WithValue("2026-11-14"); f.Input.Value != "2026-11-14" || f.Input.Kind != InputDate {
		t.Errorf("WithValue: %+v", f.Input)
	}
}
