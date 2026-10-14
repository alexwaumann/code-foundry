package main

import (
	"slices"
	"testing"
)

func TestBadgeLabel(t *testing.T) {
	tests := []struct {
		count int
		want  string
	}{
		{-1, ""}, {0, ""}, {1, "1"}, {42, "42"}, {99, "99"}, {100, "99+"}, {12345, "99+"},
	}
	for _, tt := range tests {
		if got := badgeLabel(tt.count); got != tt.want {
			t.Errorf("badgeLabel(%d) = %q, want %q", tt.count, got, tt.want)
		}
	}
}

func TestDockBadge(t *testing.T) {
	tests := []struct {
		name  string
		steps []string // a label to set, or "launch"
		want  []string // labels applied, in order
	}{
		{"nothing before launch", []string{"launch"}, nil},
		{"last label before launch is applied at launch", []string{"1", "3", "launch"}, []string{"3"}},
		{"cleared before launch applies nothing", []string{"2", "", "launch"}, nil},
		{"after launch applies each change", []string{"launch", "1", "2", ""}, []string{"1", "2", ""}},
		{"repeats are skipped", []string{"launch", "4", "4", "4"}, []string{"4"}},
		{"a repeat of the pre-launch label is skipped", []string{"5", "launch", "5", "6"}, []string{"5", "6"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			b := &dockBadge{apply: func(l string) { got = append(got, l) }}
			for _, s := range tt.steps {
				if s == "launch" {
					b.didLaunch()
				} else {
					b.set(s)
				}
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("applied %q, want %q", got, tt.want)
			}
		})
	}
}
