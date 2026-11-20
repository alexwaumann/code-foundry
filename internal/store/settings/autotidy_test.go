package settings

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// Auto-tidy's two settings (docs/notes/auto-tidy.md): off by default, on General › Snooze
// right after Default snooze, every value one TidyAfter reads.
func TestAutoTidySettings(t *testing.T) {
	d := Defaults()
	if d.Threads.AutoSaveAfter != TidyOff || d.Threads.AutoArchiveAfter != TidyOff {
		t.Errorf("defaults = %q, %q; want both off", d.Threads.AutoSaveAfter, d.Threads.AutoArchiveAfter)
	}
	i := slices.IndexFunc(staticFields, func(f Field) bool { return f.Key == KeyDefaultSnooze })
	if i < 0 || i+2 >= len(staticFields) || staticFields[i+1].Key != KeyAutoSaveAfter || staticFields[i+2].Key != KeyAutoArchiveAfter {
		t.Fatalf("the two fields do not follow %s", KeyDefaultSnooze)
	}
	for _, key := range []string{KeyAutoSaveAfter, KeyAutoArchiveAfter} {
		f := field(t, key)
		if f.Page != PageGeneral || f.Section != "snooze" || f.Type != Enum || f.Default != TidyOff || len(f.EnumLabels) != len(f.Enum) || f.EnumLabels[0] != "Off" {
			t.Errorf("%s = %+v; want a General › Snooze dropdown, Off by default, every value labelled", key, f)
		}
		if strings.Contains(strings.ToLower(f.Description), "opened") {
			t.Errorf("%s says opened: the app does not know when a thread was looked at", key)
		}
		for i, v := range f.Enum {
			if v == TidyOff {
				continue
			}
			if TidyAfter(v) <= 0 {
				t.Errorf("%s value %q (%s) reads as no time", key, v, f.EnumLabels[i])
			}
		}
	}
}

func TestTidyAfter(t *testing.T) {
	day := 24 * time.Hour
	tests := []struct {
		v    string
		want time.Duration
	}{
		{"off", 0}, {"", 0}, {"1d", day}, {"3d", 3 * day}, {"1w", 7 * day}, {"2w", 14 * day},
		{"1mo", 30 * day}, {"3mo", 90 * day}, {"0d", 0}, {"-1d", 0}, {"xd", 0}, {"3", 0}, {"3y", 0},
	}
	for _, tt := range tests {
		if got := TidyAfter(tt.v); got != tt.want {
			t.Errorf("TidyAfter(%q) = %v, want %v", tt.v, got, tt.want)
		}
	}
}
