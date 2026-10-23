package theme

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func TestReportCheck(t *testing.T) {
	issue := ContrastIssue{Slot: "--cf-warning-text", Against: "--cf-warning-surface", Label: "--cf-warning-text on --cf-warning-surface over --cf-surface", Ratio: 3.9, Required: 4.5}
	pin := StalePin{Slot: "--cf-sidebar", Pinned: "#0b141c", Basis: "#11111b", Derived: "#181825cc"}
	with := func(edit func(*Report)) Report {
		r := Report{ID: "ocean-dusk", Version: "0123abcd", Issues: []ContrastIssue{issue}, Stale: []StalePin{pin}}
		edit(&r)
		return r
	}
	tests := []struct {
		name    string
		r       Report
		wantErr string // substring; "" ok
	}{
		{"ok", with(func(*Report) {}), ""},
		{"empty report", Report{ID: "ocean-dusk", Version: "ab"}, ""},
		{"bad id", with(func(r *Report) { r.ID = "Ocean" }), "is not a theme id"},
		{"no version", with(func(r *Report) { r.Version = "" }), "is not a file version"},
		{"upper-case version", with(func(r *Report) { r.Version = "ABCD" }), "is not a file version"},
		{"not a slot", with(func(r *Report) { r.Issues[0].Slot = "--cf-txet" }), "is not a pair of slots"},
		{"against not a slot", with(func(r *Report) { r.Issues[0].Against = "surface" }), "is not a pair of slots"},
		{"control in label", with(func(r *Report) { r.Issues[0].Label = "a\nb" }), "control characters"},
		{"long label", with(func(r *Report) { r.Issues[0].Label = strings.Repeat("a", 300) }), "longer than"},
		{"NaN ratio", with(func(r *Report) { r.Issues[0].Ratio = math.NaN() }), "contrast ratios"},
		{"ratio under 1", with(func(r *Report) { r.Issues[0].Ratio = 0.5 }), "contrast ratios"},
		{"required over 21", with(func(r *Report) { r.Issues[0].Required = 30 }), "contrast ratios"},
		{"stale not a slot", with(func(r *Report) { r.Stale[0].Slot = "--cf-x" }), "is not a slot"},
		{"stale bad colour", with(func(r *Report) { r.Stale[0].Derived = "red" }), "colours are"},
		{"too many issues", with(func(r *Report) { r.Issues = make([]ContrastIssue, MaxReportIssues+1) }), "issues (at most"},
		{"too many stale", with(func(r *Report) { r.Stale = make([]StalePin, MaxReportStale+1) }), "stale pins (at most"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.r.Check()
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatal(err)
			case tt.wantErr != "" && (!errors.Is(err, ErrBadReport) || !strings.Contains(err.Error(), tt.wantErr)):
				t.Fatalf("err = %v, want %q", err, tt.wantErr)
			}
		})
	}
}

func TestReportsPublishWait(t *testing.T) {
	r := NewReports()
	if _, ok := r.Get("a"); ok {
		t.Fatal("empty set has a report")
	}
	// A refused report keeps nothing, not even the good ones beside it.
	if err := r.Publish(Report{ID: "a", Version: "1"}, Report{ID: "B", Version: "1"}); err == nil {
		t.Fatal("bad id kept")
	}
	if _, ok := r.Get("a"); ok {
		t.Fatal("kept a report from a refused batch")
	}
	if err := r.Publish(Report{ID: "a", Version: "1"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if rep, ok := r.Wait(ctx, "a", "1"); !ok || rep.At.IsZero() {
		t.Fatalf("wait for a report there = %+v, %v", rep, ok)
	}
	// A report on another version is not waited for; the next one is.
	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = r.Publish(Report{ID: "b", Version: "2"})
		time.Sleep(20 * time.Millisecond)
		_ = r.Publish(Report{ID: "a", Version: "2", Issues: []ContrastIssue{{Slot: "--cf-text", Against: "--cf-surface", Ratio: 6, Required: 7}}})
	}()
	rep, ok := r.Wait(ctx, "a", "2")
	if !ok || len(rep.Issues) != 1 {
		t.Fatalf("wait = %+v, %v", rep, ok)
	}
	short, cancelShort := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelShort()
	if _, ok := r.Wait(short, "a", "3"); ok {
		t.Fatal("waited past the deadline")
	}
}

func TestReportsKeepTheNewest(t *testing.T) {
	r := NewReports()
	now := time.Unix(0, 0)
	r.now = func() time.Time { now = now.Add(time.Second); return now }
	for i := range MaxReports + 2 {
		if err := r.Publish(Report{ID: fmt.Sprintf("t-%d", i), Version: "1"}); err != nil {
			t.Fatal(err)
		}
	}
	_, first := r.Get("t-0")
	_, second := r.Get("t-1")
	_, last := r.Get(fmt.Sprintf("t-%d", MaxReports+1))
	if first || second || !last || len(r.m) != MaxReports {
		t.Errorf("t-0 %v, t-1 %v, last %v, %d kept", first, second, last, len(r.m))
	}
}

func TestFileVersionAndSameColours(t *testing.T) {
	f, ok := Curated("catppuccin-mocha")
	if !ok {
		t.Fatal("no mocha")
	}
	f.ID, f.Name, f.Pair, f.Source = "ocean-dusk", "Ocean Dusk", "", ""
	v := f.Version()
	if len(v) != 32 || !versionPattern.MatchString(v) || v != f.Clone().Version() {
		t.Fatalf("version %q", v)
	}
	edit := func(e func(*File)) File {
		g := f.Clone()
		e(&g)
		return g
	}
	tests := []struct {
		name string
		g    File
		same bool
	}{
		{"unchanged", f.Clone(), true},
		{"pair", edit(func(g *File) { g.Pair = "ocean-dawn" }), true},
		{"name, from and source", edit(func(g *File) { g.Name, g.From, g.Source, g.CreatedBy = "Ocean", "nord", "x", "s-1" }), true},
		{"a base colour", edit(func(g *File) { g.Base.Accent = "#000000" }), false},
		{"an ANSI colour", edit(func(g *File) { g.Base.Terminal.ANSI[3] = "#000000" }), false},
		{"a pin", edit(func(g *File) { g.Overrides = map[string]string{"--cf-sidebar": "#000000"} }), false},
		{"the scheme", edit(func(g *File) { g.Scheme = SchemeLight }), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SameColours(f, tt.g); got != tt.same {
				t.Errorf("SameColours = %v, want %v", got, tt.same)
			}
			if (tt.g.Version() == v) != (tt.name == "unchanged") {
				t.Errorf("version %q vs %q", tt.g.Version(), v)
			}
		})
	}
}
