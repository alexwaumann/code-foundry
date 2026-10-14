package command

import (
	"errors"
	"testing"
	"time"
	_ "time/tzdata" // America/Chicago without relying on the system's zoneinfo
)

func TestParseSnoozeUntil(t *testing.T) {
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	at := func(y int, mo time.Month, d, h, mi int) time.Time { return time.Date(y, mo, d, h, mi, 0, 0, loc) }
	utc := func(y int, mo time.Month, d, h, mi int) time.Time { return time.Date(y, mo, d, h, mi, 0, 0, time.UTC) }
	wed := at(2026, time.October, 14, 15, 4)  // Wednesday afternoon, CDT
	mon := at(2026, time.October, 19, 8, 0)   // Monday morning
	sun := at(2026, time.October, 18, 23, 30) // Sunday night
	// DST ends Sunday Nov 1 2026 at 2:00 CDT (UTC-5) -> 1:00 CST (UTC-6); it began
	// Sunday Mar 8 2026 at 2:00 CST -> 3:00 CDT.
	beforeFallBack := at(2026, time.October, 31, 22, 0)
	inFallBack := utc(2026, time.November, 1, 6, 30) // 1:30 CDT, the first 1:30
	beforeSpring := at(2026, time.March, 7, 12, 0)

	tests := []struct {
		name string
		now  time.Time
		in   string
		want time.Time // zero: an error
	}{
		{name: "hours", now: wed, in: "1h", want: wed.Add(time.Hour)},
		{name: "upper case hours", now: wed, in: "3H", want: wed.Add(3 * time.Hour)},
		{name: "minutes", now: wed, in: "90m", want: wed.Add(90 * time.Minute)},
		{name: "compound, padded", now: wed, in: "  1h30m ", want: wed.Add(90 * time.Minute)},
		{name: "zero duration", now: wed, in: "0m"},
		{name: "negative duration", now: wed, in: "-1h"},
		{name: "days are not a duration", now: wed, in: "2d"},

		{name: "tomorrow", now: wed, in: "tomorrow", want: at(2026, time.October, 15, 9, 0)},
		{name: "Tomorrow", now: wed, in: "Tomorrow", want: at(2026, time.October, 15, 9, 0)},
		{name: "tomorrow just after midnight", now: at(2026, time.October, 15, 0, 5), in: "tomorrow", want: at(2026, time.October, 16, 9, 0)},
		{name: "tomorrow at the end of a month", now: at(2026, time.October, 31, 12, 0), in: "tomorrow", want: at(2026, time.November, 1, 9, 0)},

		{name: "next-week from a Wednesday", now: wed, in: "next-week", want: at(2026, time.October, 19, 9, 0)},
		{name: "next week, spaced", now: wed, in: "next week", want: at(2026, time.October, 19, 9, 0)},
		{name: "next-week on a Monday is the following Monday", now: mon, in: "next-week", want: at(2026, time.October, 26, 9, 0)},
		{name: "next-week on a Sunday is tomorrow", now: sun, in: "next-week", want: at(2026, time.October, 19, 9, 0)},

		{name: "mon", now: wed, in: "mon", want: at(2026, time.October, 19, 9, 0)},
		{name: "thu is tomorrow", now: wed, in: "thu", want: at(2026, time.October, 15, 9, 0)},
		{name: "friday", now: wed, in: "friday", want: at(2026, time.October, 16, 9, 0)},
		{name: "Sun", now: wed, in: "Sun", want: at(2026, time.October, 18, 9, 0)},
		{name: "today's weekday is a week ahead", now: wed, in: "wed", want: at(2026, time.October, 21, 9, 0)},
		{name: "today's weekday before 9 AM is still a week ahead", now: mon, in: "mon", want: at(2026, time.October, 26, 9, 0)},
		{name: "tue from a Monday", now: mon, in: "tue", want: at(2026, time.October, 20, 9, 0)},
		{name: "not a weekday", now: wed, in: "wedn"},

		{name: "a date is 9 AM", now: wed, in: "2026-10-20", want: at(2026, time.October, 20, 9, 0)},
		{name: "a local date and time", now: wed, in: "2026-10-20 14:00", want: at(2026, time.October, 20, 14, 0)},
		{name: "a local date and time with T", now: wed, in: "2026-10-20T14:00", want: at(2026, time.October, 20, 14, 0)},
		{name: "later today", now: wed, in: "2026-10-14 16:00", want: at(2026, time.October, 14, 16, 0)},
		{name: "RFC 3339 UTC", now: wed, in: "2026-10-20T14:00:00Z", want: utc(2026, time.October, 20, 14, 0)},
		{name: "RFC 3339 lower case", now: wed, in: "2026-10-20t14:00:00z", want: utc(2026, time.October, 20, 14, 0)},
		{name: "RFC 3339 with an offset", now: wed, in: "2026-10-20T14:00:00+02:00", want: utc(2026, time.October, 20, 12, 0)},
		{name: "next year", now: wed, in: "2027-01-05", want: at(2027, time.January, 5, 9, 0)},

		{name: "today 9 AM has passed", now: wed, in: "2026-10-14"},
		{name: "now is not the future", now: wed, in: "2026-10-14 15:04"},
		{name: "a past RFC 3339 time", now: wed, in: "2026-10-14T20:00:00Z"},
		{name: "last year", now: wed, in: "2025-01-01"},
		{name: "empty", now: wed, in: "  "},
		{name: "gibberish", now: wed, in: "soon"},
		{name: "a bad month", now: wed, in: "2026-13-01"},
		{name: "a date with seconds is not a form", now: wed, in: "2026-10-20 14:00:00"},

		// DST: day forms stay 9:00 AM local; durations are absolute.
		{name: "tomorrow across the fall back", now: beforeFallBack, in: "tomorrow", want: utc(2026, time.November, 1, 15, 0)},
		{name: "next-week across the fall back", now: beforeFallBack, in: "next-week", want: utc(2026, time.November, 2, 15, 0)},
		{name: "a weekday across the fall back", now: beforeFallBack, in: "sun", want: utc(2026, time.November, 1, 15, 0)},
		{name: "an hour across the fall back is an hour", now: inFallBack, in: "1h", want: utc(2026, time.November, 1, 7, 30)},
		{name: "tomorrow across the spring forward", now: beforeSpring, in: "tomorrow", want: utc(2026, time.March, 8, 14, 0)},
		{name: "a date across the spring forward", now: beforeSpring, in: "2026-03-09", want: utc(2026, time.March, 9, 14, 0)},
		{name: "a local time in the spring-forward gap moves forward", now: beforeSpring, in: "2026-03-08 02:30", want: utc(2026, time.March, 8, 8, 30)},
		{name: "a local time before the spring forward", now: beforeSpring, in: "2026-03-08 01:30", want: utc(2026, time.March, 8, 7, 30)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSnoozeUntil(tt.in, tt.now, loc)
			if tt.want.IsZero() {
				if !errors.Is(err, errSnoozeUntil) {
					t.Fatalf("parseSnoozeUntil(%q) = %v, %v; want an error", tt.in, got, err)
				}
				return
			}
			if err != nil || !got.Equal(tt.want) {
				t.Fatalf("parseSnoozeUntil(%q) = %v, %v; want %v", tt.in, got.In(loc), err, tt.want.In(loc))
			}
		})
	}
}

func TestFormatSnoozeTime(t *testing.T) {
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.October, 14, 15, 4, 0, 0, loc)
	tests := []struct {
		t    time.Time
		want string
	}{
		{time.Date(2026, time.October, 15, 9, 0, 0, 0, loc), "Thu Oct 15 9:00 AM"},
		{time.Date(2026, time.October, 14, 21, 30, 0, 0, time.UTC), "Wed Oct 14 4:30 PM"},
		{time.Date(2027, time.January, 5, 9, 0, 0, 0, loc), "Tue Jan 5 2027 9:00 AM"},
	}
	for _, tt := range tests {
		if got := formatSnoozeTime(tt.t, now, loc); got != tt.want {
			t.Errorf("formatSnoozeTime(%v) = %q, want %q", tt.t, got, tt.want)
		}
	}
}
