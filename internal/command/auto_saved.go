package command

import (
	"fmt"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
)

// autoSavedWords is what thread.get adds after "saved for later" for a thread auto-tidy saved
// (Thread.auto_saved_after; docs/notes/auto-tidy.md): " automatically, after 3 days without
// activity"; "" for one the user saved.
func autoSavedWords(after *durationpb.Duration) string {
	if after == nil || after.AsDuration() <= 0 {
		return ""
	}
	return " automatically, after " + spanWords(after.AsDuration()) + " without activity"
}

// spanWords says a span of auto-tidy's settings in words: whole months (30 days), weeks or
// days ("1 month", "2 weeks", "3 days"), else hours or minutes.
func spanWords(d time.Duration) string {
	const day = 24 * time.Hour
	for _, u := range []struct {
		len       time.Duration
		one, many string
	}{{30 * day, "month", "months"}, {7 * day, "week", "weeks"}, {day, "day", "days"}, {time.Hour, "hour", "hours"}} {
		if d >= u.len && d%u.len == 0 {
			n := int64(d / u.len)
			if n == 1 {
				return "1 " + u.one
			}
			return fmt.Sprintf("%d %s", n, u.many)
		}
	}
	return d.Round(time.Minute).String()
}
