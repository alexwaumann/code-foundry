package skills

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// PlaceWelcome writes the embedded page on start, rewrites a stale one, leaves a current
// one alone, and keeps the rest of the pages root as it was.
func TestPlaceWelcome(t *testing.T) {
	page, err := static.ReadFile(welcomeSource)
	if err != nil {
		t.Fatal(err)
	}
	rendered, err := Render(Sources{})
	if err != nil {
		t.Fatal(err)
	}
	if string(rendered[Pages+"/reference/"+WelcomeFile]) != string(page) {
		t.Fatal("the skill's copy of welcome.html differs from the page PlaceWelcome writes")
	}
	tests := []struct {
		name      string
		root      bool   // the pages root exists
		existing  string // welcome.html's content before; "" for none
		wantWrote bool
	}{
		{name: "no pages root yet", wantWrote: true},
		{name: "first start", root: true, wantWrote: true},
		{name: "an older build's page", root: true, existing: "<p>old</p>", wantWrote: true},
		{name: "this build's page", root: true, existing: string(page)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "pages")
			thread := filepath.Join(root, "s-1", "board.html")
			if tt.root {
				if err := os.MkdirAll(filepath.Dir(thread), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(thread, []byte("mine"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if tt.existing != "" {
				if err := os.WriteFile(WelcomePath(root), []byte(tt.existing), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			wrote, err := PlaceWelcome(root)
			if err != nil {
				t.Fatal(err)
			}
			if wrote != tt.wantWrote {
				t.Errorf("wrote = %v, want %v", wrote, tt.wantWrote)
			}
			got := tree(t, root)
			want := map[string]string{WelcomeFile: string(page)}
			if tt.root {
				want["s-1/board.html"] = "mine"
			}
			if len(got) != len(want) {
				t.Errorf("pages root = %d files %v, want %d", len(got), slices.Sorted(maps.Keys(got)), len(want))
			}
			for p, w := range want {
				if got[p] != w {
					t.Errorf("%s = %.40q, want %.40q", p, got[p], w)
				}
			}
		})
	}
	if _, err := PlaceWelcome(""); err == nil {
		t.Error("PlaceWelcome(\"\") = nil error, want one")
	}
}
