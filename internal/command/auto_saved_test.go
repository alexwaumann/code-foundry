package command

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
)

func TestAutoSavedWords(t *testing.T) {
	day := 24 * time.Hour
	tests := []struct {
		after *durationpb.Duration
		want  string
	}{
		{nil, ""},
		{durationpb.New(0), ""},
		{durationpb.New(day), " automatically, after 1 day without activity"},
		{durationpb.New(3 * day), " automatically, after 3 days without activity"},
		{durationpb.New(7 * day), " automatically, after 1 week without activity"},
		{durationpb.New(14 * day), " automatically, after 2 weeks without activity"},
		{durationpb.New(30 * day), " automatically, after 1 month without activity"},
		{durationpb.New(90 * day), " automatically, after 3 months without activity"},
		{durationpb.New(2 * time.Hour), " automatically, after 2 hours without activity"},
	}
	for _, tt := range tests {
		if got := autoSavedWords(tt.after); got != tt.want {
			t.Errorf("autoSavedWords(%v) = %q, want %q", tt.after.AsDuration(), got, tt.want)
		}
	}
}
