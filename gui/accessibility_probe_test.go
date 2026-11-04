package main

import (
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAccessibilityProbeArgs(t *testing.T) {
	tests := []struct {
		name          string
		args          []string
		probe, prompt bool
	}{
		{name: "no arguments"},
		{name: "probe", args: []string{"--accessibility-probe"}, probe: true},
		{name: "probe and prompt", args: []string{"--accessibility-probe", "--prompt"}, probe: true, prompt: true},
		{name: "prompt alone", args: []string{"--prompt"}},
		{name: "prompt first", args: []string{"--prompt", "--accessibility-probe"}},
		{name: "another second argument", args: []string{"--accessibility-probe", "--yes"}},
		{name: "a third argument", args: []string{"--accessibility-probe", "--prompt", "x"}},
		{name: "not exact", args: []string{"--accessibility-probe=1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probe, prompt := accessibilityProbeArgs(tt.args)
			if probe != tt.probe || prompt != tt.prompt {
				t.Errorf("got %t %t, want %t %t", probe, prompt, tt.probe, tt.prompt)
			}
		})
	}
}

func TestAccessibilityListName(t *testing.T) {
	for version, want := range map[string]string{
		"26.4":    "Accessibility",
		"15.1.1":  "Accessibility",
		"27.0.1":  "Device Control and Data Access",
		"28":      "Device Control and Data Access",
		"unknown": "Accessibility",
	} {
		if got := accessibilityListName(version); got != want {
			t.Errorf("accessibilityListName(%q) = %q, want %q", version, got, want)
		}
	}
}

func TestTapDecision(t *testing.T) {
	tests := []struct {
		name                    string
		trusted, listen, prompt bool
		create                  bool
		why                     string
	}{
		{name: "nothing granted never risks a prompt", why: "only --prompt may prompt"},
		{name: "nothing granted with --prompt", prompt: true, create: true, why: "may prompt"},
		{name: "Accessibility alone is tried", trusted: true, create: true, why: "Accessibility alone"},
		{name: "Input Monitoring", listen: true, create: true},
		{name: "both", trusted: true, listen: true, create: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			create, why := tapDecision(tt.trusted, tt.listen, tt.prompt)
			if create != tt.create {
				t.Errorf("create = %t, want %t", create, tt.create)
			}
			if (tt.why == "") != (why == "") || !strings.Contains(why, tt.why) {
				t.Errorf("why = %q, want it to include %q", why, tt.why)
			}
		})
	}
}

func TestAltReportLine(t *testing.T) {
	tests := []struct {
		report altReport
		want   string
	}{
		{altReport{Kind: altReportDown, Side: altRight}, "alt down: right"},
		{altReport{Kind: altReportUp, Side: altLeft}, "alt up: left"},
		{altReport{Kind: altReportBoth, Side: altBothSides}, "alt both: down within 80 ms"},
		{altReport{Kind: altReportStarted, Side: altLeft}, "hold started: left"},
		{altReport{Kind: altReportDiscarded, Why: "why"}, "hold discarded: why"},
		{altReport{Kind: altReportCounted, Side: altBothSides, Held: 512 * time.Millisecond}, "hold counted as a dictation: both, held 512 ms"},
	}
	for _, tt := range tests {
		if got := altReportLine(tt.report); got != tt.want {
			t.Errorf("got %q, want %q", got, tt.want)
		}
	}
}

func TestWaitExitCode(t *testing.T) {
	tests := []struct {
		name   string
		status syscall.WaitStatus
		want   int
	}{
		{"exit 0", 0, 0},
		{"exit 3", 3 << 8, 3},
		{"killed by SIGTERM", syscall.WaitStatus(syscall.SIGTERM), 128 + 15},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := waitExitCode(tt.status); got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}
