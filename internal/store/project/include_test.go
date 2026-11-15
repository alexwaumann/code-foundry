package project

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCleanIncludes(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string
		err  string
	}{
		{name: "trimmed, repeats dropped", in: []string{" .env* ", "dist/", ".env*"}, want: []string{".env*", "dist/"}},
		{name: "invalid is the store's error", in: []string{"!x"}, err: `invalid argument: pattern "!x" starts with !`},
		{name: "absolute", in: []string{"/x"}, err: "relative to the project"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CleanIncludes(tt.in)
			if tt.err != "" {
				if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || !slices.Equal(got, tt.want) {
				t.Fatalf("= %q, %v", got, err)
			}
		})
	}
}

// A project's patterns are stored, published, kept by a reconcile, reloaded at start,
// cleared by an empty list, and removed with the project.
func TestSetIncludeIgnored(t *testing.T) {
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.IncludeIgnored) != 0 {
		t.Fatalf("a new project has patterns %q", r.IncludeIgnored)
	}
	got, err := h.store.SetIncludeIgnored(ctx, r.ID, []string{" docs/scratch/ ", "*.local.json", "docs/scratch/"})
	if want := []string{"docs/scratch/", "*.local.json"}; err != nil || !slices.Equal(got.IncludeIgnored, want) {
		t.Fatalf("SetIncludeIgnored = %q, %v; want %q", got.IncludeIgnored, err, want)
	}
	h.waitFor("ProjectUpdated with the patterns", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && u.Project.ID == r.ID && len(u.Project.IncludeIgnored) == 2
	})
	if _, err := h.store.SetIncludeIgnored(ctx, r.ID, []string{"../x"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("an invalid pattern: %v", err)
	}
	if _, err := h.store.SetIncludeIgnored(ctx, "nope", []string{"x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown project: %v", err)
	}
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.store.Snapshot().Project(r.ID); len(p.IncludeIgnored) != 2 {
		t.Fatalf("after a reconcile: %q", p.IncludeIgnored)
	}
	h.close()

	h2 := startHarness(t, dbPath, Options{})
	if p, _ := h2.store.Snapshot().Project(r.ID); !slices.Equal(p.IncludeIgnored, []string{"docs/scratch/", "*.local.json"}) {
		t.Fatalf("reloaded: %q", p.IncludeIgnored)
	}
	if got, err := h2.store.SetIncludeIgnored(ctx, r.ID, nil); err != nil || got.IncludeIgnored != nil {
		t.Fatalf("cleared: %q, %v", got.IncludeIgnored, err)
	}
	var rows int
	count := func() int {
		t.Helper()
		if err := h2.store.db.QueryRowContext(ctx, `SELECT count(*) FROM project_include_ignored`).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if n := count(); n != 0 {
		t.Fatalf("%d rows after clearing", n)
	}
	if _, err := h2.store.SetIncludeIgnored(ctx, r.ID, []string{".env*"}); err != nil {
		t.Fatal(err)
	}
	if err := h2.store.Unregister(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 0 {
		t.Fatalf("%d rows after unregistering", n)
	}
	r, err = h2.store.Register(ctx, f.project)
	if err != nil || len(r.IncludeIgnored) != 0 {
		t.Fatalf("registered again: %q, %v", r.IncludeIgnored, err)
	}
}
