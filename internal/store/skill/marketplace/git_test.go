package marketplace_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
)

func TestHistory(t *testing.T) {
	ctx := context.Background()
	dir := marketplacetest.Checkout(t)
	var g marketplace.Git
	h, err := g.History(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if h.Shallow || h.Head != marketplacetest.Git(t, dir, time.Time{}, "rev-parse", "HEAD") {
		t.Errorf("head %q shallow %v", h.Head, h.Shallow)
	}
	tests := []struct {
		dir  string
		want time.Time
		ok   bool
	}{
		{"", marketplacetest.Catalog, true},
		{".", marketplacetest.Catalog, true},
		{"enterprise", marketplacetest.Catalog, true},
		{"enterprise/skills", marketplacetest.PRReview, true},
		{"./enterprise/skills/pr-review", marketplacetest.PRReview, true},
		{"enterprise/skills/data/sql-helper", marketplacetest.Initial, true},
		{"community", marketplacetest.Initial, true},
		{"nowhere", time.Time{}, false},
	}
	for _, tt := range tests {
		c, ok := h.Dir(tt.dir)
		if ok != tt.ok || !c.At.Equal(tt.want) || ok && len(c.SHA) != 40 {
			t.Errorf("Dir(%q) = %+v, %v; want %v, %v", tt.dir, c, ok, tt.want, tt.ok)
		}
	}

	// Cached while HEAD is the same; read again once it moves.
	if again, _ := g.History(ctx, dir); again != h {
		t.Error("unchanged HEAD read the log again")
	}
	later := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	marketplacetest.Commit(t, dir, later, map[string]string{"community/skills/haiku-writer/SKILL.md": "# new\n"})
	h2, err := g.History(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := h2.Dir("community/skills/haiku-writer"); h2 == h || !c.At.Equal(later) {
		t.Errorf("after a commit: %+v (same %v)", c, h2 == h)
	}
	var nilHist *marketplace.History
	if _, ok := nilHist.Dir("x"); ok {
		t.Error("nil history has dates")
	}
}

func TestHistoryShallow(t *testing.T) {
	ctx := context.Background()
	origin := marketplacetest.Checkout(t)
	dir := filepath.Join(t.TempDir(), "clone")
	marketplacetest.Git(t, filepath.Dir(dir), time.Time{}, "clone", "-q", "--depth", "1", "file://"+origin, dir)
	var g marketplace.Git
	h, err := g.History(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := h.Dir("enterprise/skills/data/sql-helper"); !h.Shallow || !c.At.Equal(marketplacetest.Catalog) {
		t.Errorf("shallow %v, sql-helper %v: want every dir at the boundary commit", h.Shallow, c.At)
	}
	if err := g.Unshallow(ctx, dir); err != nil {
		t.Fatal(err)
	}
	h, err = g.History(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := h.Dir("enterprise/skills/data/sql-helper"); h.Shallow || !c.At.Equal(marketplacetest.Initial) {
		t.Errorf("after unshallow: shallow %v, sql-helper %v", h.Shallow, c.At)
	}
}

func TestHistoryNotGit(t *testing.T) {
	ctx := context.Background()
	var g marketplace.Git
	plain := t.TempDir()
	if _, err := g.History(ctx, plain); !errors.Is(err, marketplace.ErrNotGit) {
		t.Errorf("plain dir: %v", err)
	}
	// A directory inside another work tree is not a checkout of its own.
	outer := marketplacetest.Checkout(t)
	inner := filepath.Join(outer, "community")
	if _, err := g.History(ctx, inner); !errors.Is(err, marketplace.ErrNotGit) {
		t.Errorf("dir inside a work tree: %v", err)
	}
	if _, err := g.History(ctx, filepath.Join(plain, "missing")); err == nil {
		t.Error("missing dir read")
	}
	g.Path = filepath.Join(plain, "no-git")
	if _, err := g.History(ctx, outer); err == nil || errors.Is(err, marketplace.ErrNotGit) {
		t.Errorf("missing git: %v", err)
	}
	_ = os.Remove(plain)
}
