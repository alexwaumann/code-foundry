package command

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// snoozeHour is the local hour a snooze to a day (tomorrow, next-week, a weekday, a
// date without a time) wakes at.
const snoozeHour = 9

// SnoozeUntilHelp lists the forms parseSnoozeUntil accepts (session.snooze's until).
const SnoozeUntilHelp = "a duration (1h, 3h, 90m, 1h30m), tomorrow, next-week, a weekday (mon..sun), " +
	"a date (2026-10-20, 9:00 AM), a local date and time (2026-10-20 14:00) or RFC 3339"

var errSnoozeUntil = errors.New("unrecognized snooze time")

// parseSnoozeUntil turns session.snooze's until into an absolute time, for now in loc
// (the daemon's local zone). It accepts, case-insensitively:
//
//   - a positive Go duration: 1h, 3h, 90m, 1h30m (now plus it, an absolute instant);
//   - tomorrow: 9:00 AM tomorrow;
//   - next-week (or "next week"): 9:00 AM next Monday, a week ahead on a Monday;
//   - a weekday, mon..sun or monday..sunday: 9:00 AM on its next occurrence, never
//     today (a week ahead on that day, like next-week);
//   - 2026-10-20: 9:00 AM that day; 2026-10-20 14:00 or 2026-10-20T14:00: that local
//     time; RFC 3339 (2026-10-20T14:00:00Z, with any offset): that instant.
//
// Day forms are wall-clock times in loc, so they stay 9:00 AM across a DST change; a
// local time that does not exist (inside a spring-forward gap) is moved forward by the
// gap (wallTime). The result must be after now.
func parseSnoozeUntil(s string, now time.Time, loc *time.Location) (time.Time, error) {
	in := strings.ToLower(strings.TrimSpace(s))
	if in == "" {
		return time.Time{}, fmt.Errorf("%w: empty; want %s", errSnoozeUntil, SnoozeUntilHelp)
	}
	local := now.In(loc)
	day := func(offset int) time.Time {
		return wallTime(local.Year(), local.Month(), local.Day()+offset, snoozeHour, 0, loc)
	}
	// daysUntil is how many days ahead the next wd is, 1..7 (never today).
	daysUntil := func(wd time.Weekday) int {
		d := (int(wd) - int(local.Weekday()) + 7) % 7
		if d == 0 {
			d = 7
		}
		return d
	}
	var t time.Time
	switch in {
	case "tomorrow":
		t = day(1)
	case "next-week", "next week", "nextweek":
		t = day(daysUntil(time.Monday))
	default:
		if wd, ok := weekdays[in]; ok {
			t = day(daysUntil(wd))
			break
		}
		if d, err := time.ParseDuration(in); err == nil {
			if d <= 0 {
				return time.Time{}, fmt.Errorf("%w: duration %q is not positive", errSnoozeUntil, s)
			}
			t = now.Add(d)
			break
		}
		var err error
		if t, err = parseSnoozeDate(strings.TrimSpace(s), loc); err != nil {
			return time.Time{}, fmt.Errorf("%w: %q; want %s", errSnoozeUntil, s, SnoozeUntilHelp)
		}
	}
	if !t.After(now) {
		return time.Time{}, fmt.Errorf("%w: %s is in the past", errSnoozeUntil, formatSnoozeTime(t, now, loc))
	}
	return t, nil
}

// weekdays maps the accepted weekday names to their day.
var weekdays = func() map[string]time.Weekday {
	m := map[string]time.Weekday{}
	for wd := time.Sunday; wd <= time.Saturday; wd++ {
		name := strings.ToLower(wd.String())
		m[name], m[name[:3]] = wd, wd
	}
	return m
}()

// parseSnoozeDate parses the absolute forms: RFC 3339 (any offset), a local date and
// time, or a local date (9:00 AM).
func parseSnoozeDate(s string, loc *time.Location) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, strings.ToUpper(s)); err == nil {
		return t, nil
	}
	// Parsed in UTC for the fields only: wallTime places them in loc.
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04"} {
		if t, err := time.Parse(layout, s); err == nil {
			return wallTime(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), loc), nil
		}
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, err
	}
	return wallTime(t.Year(), t.Month(), t.Day(), snoozeHour, 0, loc), nil
}

// wallTime is the local time h:mi on that day in loc. time.Date may resolve a time in a
// spring-forward gap (02:30 on the night clocks jump from 2:00 to 3:00) to either side;
// this always moves it forward by the gap (03:30), as calendars do.
func wallTime(y int, mo time.Month, d, h, mi int, loc *time.Location) time.Time {
	t := time.Date(y, mo, d, h, mi, 0, 0, loc)
	if t.Hour() == h && t.Minute() == mi {
		return t
	}
	// The instant h:mi names under the offset in force before the gap: past the gap.
	_, before := t.Add(-12 * time.Hour).Zone()
	return time.Date(y, mo, d, h, mi, 0, 0, time.FixedZone("", before)).In(loc)
}

// formatSnoozeTime is a snooze time for messages: "Thu Oct 15 9:00 AM" in loc, with
// the year when it is not now's.
func formatSnoozeTime(t, now time.Time, loc *time.Location) string {
	t = t.In(loc)
	if t.Year() != now.In(loc).Year() {
		return t.Format("Mon Jan 2 2006 3:04 PM")
	}
	return t.Format("Mon Jan 2 3:04 PM")
}
