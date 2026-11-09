package ui

import "time"

// DateField returns a date field: the value is an ISO date (time.DateOnly, "2026-11-14"),
// "" for none. The host shows it with a calendar icon and picks it from a month calendar
// with Today, Tomorrow, next Monday and Clear.
func DateField(key, name, label string) Field {
	return Field{Key: key, Name: name, Label: label, Input: &Input{Kind: InputDate}}
}

// WithDateRange returns a date field whose calendar offers only the days from from to to,
// ISO dates; either may be "" (no bound). Another field is left as it is.
func (f Field) WithDateRange(from, to string) Field {
	if f.Input != nil && f.Input.Kind == InputDate {
		in := *f.Input
		in.Min, in.Max = from, to
		f.Input = &in
	}
	return f
}

// Date returns t's day as a date field's value (time.DateOnly in t's location).
func Date(t time.Time) string { return t.Format(time.DateOnly) }

// isoDate reports whether s is a real day written as time.DateOnly.
func isoDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil
}

// dateInput checks a date input's value and bounds (ISO dates, min not after max, the
// value between them) and refuses the text options it has no use for; on another input
// it refuses min and max.
func (c *checker) dateInput(p string, in *Input) {
	if in.Kind != InputDate {
		if in.Min != "" || in.Max != "" {
			c.bad(p, "min and max are for date inputs")
		}
		return
	}
	ok := true
	for _, d := range []struct{ name, v string }{{"value", in.Value}, {"min", in.Min}, {"max", in.Max}} {
		if d.v != "" && !isoDate(d.v) {
			c.bad(p+"."+d.name, "%.40q is not an ISO date (YYYY-MM-DD)", d.v)
			ok = false
		}
	}
	if !ok {
		return
	}
	// ISO dates compare as strings.
	switch {
	case in.Min != "" && in.Max != "" && in.Min > in.Max:
		c.bad(p+".min", "%s is after max %s", in.Min, in.Max)
	case in.Value != "" && in.Min != "" && in.Value < in.Min:
		c.bad(p+".value", "%s is before min %s", in.Value, in.Min)
	case in.Value != "" && in.Max != "" && in.Value > in.Max:
		c.bad(p+".value", "%s is after max %s", in.Value, in.Max)
	}
	if in.Pattern != "" || in.MaxLength != 0 || in.Mono {
		c.bad(p, "a date input has no pattern, maxLength or mono (the host writes its value)")
	}
}
