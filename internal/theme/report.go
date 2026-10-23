package theme

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// The GUI's contrast report on the user's themes (docs/notes/theme-followups.md). The
// daemon derives no colour, so it cannot tell which pairs of a theme fall short: the GUI
// resolves every user theme it is sent, measures it against its pair list
// (src/themes/contrastPairs.ts) and publishes what it found (UiService.PublishThemeReport),
// keyed by the file's Version. theme save waits briefly for the report on the file it
// wrote; theme check prints the latest.

// Report bounds: far above the GUI's pair list (a few hundred pairs) and the pin cap.
const (
	MaxReportIssues = 1024
	MaxReportStale  = MaxOverrides
	// MaxReports is how many themes' reports are kept; the oldest goes first.
	MaxReports    = 1024
	maxLabelBytes = 256
)

// ContrastIssue is one pair of resolved slots that falls short.
type ContrastIssue struct {
	// Slot is drawn on Against; Label is the pair in words ("--cf-warning-text on
	// --cf-warning-surface over --cf-surface").
	Slot     string  `json:"slot"`
	Against  string  `json:"against"`
	Label    string  `json:"label"`
	Ratio    float64 `json:"ratio"`
	Required float64 `json:"required"`
}

// StalePin is a pinned slot whose rule now derives another colour than when it was
// pinned: the base moved under it.
type StalePin struct {
	Slot    string `json:"slot"`
	Pinned  string `json:"pinned"`
	Basis   string `json:"basis"`
	Derived string `json:"derived"`
}

// Report is the GUI's report on one version of one user theme.
type Report struct {
	ID      string          `json:"id"`
	Version string          `json:"version"`
	Issues  []ContrastIssue `json:"issues"`
	Stale   []StalePin      `json:"stale"`
	// At is when the daemon got it.
	At time.Time `json:"at"`
}

// ErrBadReport wraps every reason Reports.Publish refuses a report.
var ErrBadReport = errors.New("bad theme report")

var versionPattern = regexp.MustCompile(`^[0-9a-f]{1,64}$`)

// Check is why r cannot be kept, or nil.
func (r Report) Check() error {
	bad := func(format string, a ...any) error {
		return fmt.Errorf("%w: theme %q: %s", ErrBadReport, r.ID, fmt.Sprintf(format, a...))
	}
	switch {
	case !ValidID(r.ID):
		return fmt.Errorf("%w: %q is not a theme id", ErrBadReport, r.ID)
	case !versionPattern.MatchString(r.Version):
		return bad("version %q is not a file version (lowercase hex)", r.Version)
	case len(r.Issues) > MaxReportIssues:
		return bad("%d issues (at most %d)", len(r.Issues), MaxReportIssues)
	case len(r.Stale) > MaxReportStale:
		return bad("%d stale pins (at most %d)", len(r.Stale), MaxReportStale)
	}
	for i, is := range r.Issues {
		switch {
		case !IsSlot(is.Slot) || !IsSlot(is.Against):
			return bad("issue %d: %q on %q is not a pair of slots", i, is.Slot, is.Against)
		case len(is.Label) > maxLabelBytes || strings.ContainsFunc(is.Label, unicode.IsControl):
			return bad("issue %d: the label is longer than %d bytes or has control characters", i, maxLabelBytes)
		case !ratio(is.Ratio) || !ratio(is.Required):
			return bad("issue %d: %v and %v are not both contrast ratios (1 to 21)", i, is.Ratio, is.Required)
		}
	}
	for i, p := range r.Stale {
		switch {
		case !IsSlot(p.Slot):
			return bad("stale pin %d: %q is not a slot", i, p.Slot)
		case !anyHexPattern.MatchString(p.Pinned) || !anyHexPattern.MatchString(p.Basis) || !anyHexPattern.MatchString(p.Derived):
			return bad("stale pin %d (%s): colours are lowercase #rrggbb or #rrggbbaa", i, p.Slot)
		}
	}
	return nil
}

// ratio: a WCAG contrast ratio, 1 to 21 (a little slack for rounding).
func ratio(v float64) bool { return !math.IsNaN(v) && v >= 1 && v <= 21.01 }

// Reports keeps the last report per theme id, in memory. Safe for concurrent use.
type Reports struct {
	mu sync.Mutex
	m  map[string]Report
	// wake is closed and replaced at every Publish, waking Wait.
	wake chan struct{}
	now  func() time.Time
}

// NewReports returns an empty set.
func NewReports() *Reports {
	return &Reports{m: map[string]Report{}, wake: make(chan struct{}), now: time.Now}
}

// Publish keeps each report, replacing its theme's last one. Nothing is kept when any is
// refused (ErrBadReport).
func (r *Reports) Publish(reps ...Report) error {
	for _, rep := range reps {
		if err := rep.Check(); err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	for _, rep := range reps {
		rep.At = now
		rep.Issues = append([]ContrastIssue{}, rep.Issues...)
		rep.Stale = append([]StalePin{}, rep.Stale...)
		r.m[rep.ID] = rep
	}
	for len(r.m) > MaxReports {
		oldest := ""
		for id, rep := range r.m {
			if o, ok := r.m[oldest]; !ok || rep.At.Before(o.At) || (rep.At.Equal(o.At) && id < oldest) {
				oldest = id
			}
		}
		delete(r.m, oldest)
	}
	close(r.wake)
	r.wake = make(chan struct{})
	return nil
}

// Get is the theme's last report.
func (r *Reports) Get(id string) (Report, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rep, ok := r.m[id]
	return rep, ok
}

// Wait returns the report on version of theme id: at once when it is there, else when it
// arrives, else (false) when ctx ends.
func (r *Reports) Wait(ctx context.Context, id, version string) (Report, bool) {
	for {
		r.mu.Lock()
		rep, ok := r.m[id]
		wake := r.wake
		r.mu.Unlock()
		if ok && rep.Version == version {
			return rep, true
		}
		select {
		case <-ctx.Done():
			return Report{}, false
		case <-wake:
		}
	}
}
