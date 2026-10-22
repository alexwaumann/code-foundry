package memory

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	return New(filepath.Join(t.TempDir(), "memory.md"), slog.New(slog.DiscardHandler))
}

func texts(t *testing.T, s *Store) []string {
	t.Helper()
	got, err := s.Texts()
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestMissingFileIsEmpty(t *testing.T) {
	s := newStore(t)
	if got := texts(t, s); got != nil {
		t.Errorf("Texts = %q", got)
	}
	got, err := s.Entries()
	if err != nil || len(got) != 0 {
		t.Errorf("Entries = %v, %v", got, err)
	}
	if n, err := s.Clear(); n != 0 || err != nil {
		t.Errorf("Clear = %d, %v", n, err)
	}
}

func TestAdd(t *testing.T) {
	s := newStore(t)
	for _, tt := range []struct {
		name    string
		text    string
		want    Added
		wantErr error
	}{
		{"first", "  Always open PRs as drafts  ", Added{Entry: Entry{1, "Always open PRs as drafts"}}, nil},
		{"second", "Explain git terms when you use them", Added{Entry: Entry{2, "Explain git terms when you use them"}}, nil},
		{"duplicate, any case", "always open prs as DRAFTS", Added{Entry: Entry{1, "Always open PRs as drafts"}, Duplicate: true}, nil},
		{"empty", "   ", Added{}, ErrInvalidArgument},
		{"only a dash", " - ", Added{}, ErrInvalidArgument},
		{"multi-line", "one\ntwo", Added{}, ErrInvalidArgument},
		{"carriage return", "one\rtwo", Added{}, ErrInvalidArgument},
		{"starts with a dash", "- keep the dash", Added{Entry: Entry{3, "- keep the dash"}}, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.Add(tt.text)
			if !errors.Is(err, tt.wantErr) || got != tt.want {
				t.Errorf("Add(%q) = %+v, %v; want %+v, %v", tt.text, got, err, tt.want, tt.wantErr)
			}
		})
	}
	b, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	if want := "- Always open PRs as drafts\n- Explain git terms when you use them\n- - keep the dash\n"; string(b) != want {
		t.Errorf("file = %q, want %q", b, want)
	}
	if fi, err := os.Stat(s.Path()); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, %v", fi.Mode(), err)
	}
	if got := texts(t, s); !slices.Equal(got, []string{"Always open PRs as drafts", "Explain git terms when you use them", "- keep the dash"}) {
		t.Errorf("round trip = %q", got)
	}
}

func TestCaps(t *testing.T) {
	t.Run("entries", func(t *testing.T) {
		s := newStore(t)
		for i := range MaxEntries {
			if _, err := s.Add(fmt.Sprintf("preference %d", i+1)); err != nil {
				t.Fatal(err)
			}
		}
		_, err := s.Add("one more")
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "at most 40 entries") {
			t.Errorf("41st Add = %v", err)
		}
		// A duplicate is still a no-op, not a cap error.
		if a, err := s.Add("preference 7"); err != nil || !a.Duplicate || a.Entry.Index != 7 {
			t.Errorf("duplicate when full = %+v, %v", a, err)
		}
		if n := len(texts(t, s)); n != MaxEntries {
			t.Errorf("entries = %d", n)
		}
	})
	t.Run("bytes", func(t *testing.T) {
		s := newStore(t)
		long := strings.Repeat("x", 1300)
		for i := range 3 { // 3 × 1306 bytes
			if _, err := s.Add(fmt.Sprintf("%d %s", i, long)); err != nil {
				t.Fatal(err)
			}
		}
		_, err := s.Add(strings.Repeat("y", 200))
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "4096 bytes (4 KiB)") {
			t.Errorf("Add over 4 KiB = %v", err)
		}
		if b, _ := os.ReadFile(s.Path()); len(b) > MaxBytes {
			t.Errorf("file has %d bytes", len(b))
		}
		if _, err := s.Add("short"); err != nil {
			t.Errorf("an entry that fits = %v", err)
		}
	})
}

func TestRemove(t *testing.T) {
	seed := []string{"Always open PRs as drafts", "Explain git terms", "Never open the side panel on your own", "Draft commit messages in English"}
	for _, tt := range []struct {
		name    string
		ref     string
		want    Entry
		wantErr error
		errHas  string
		left    []string
	}{
		{"by index", "2", Entry{2, "Explain git terms"}, nil, "", []string{seed[0], seed[2], seed[3]}},
		{"by index with spaces", " 4 ", Entry{4, seed[3]}, nil, "", seed[:3]},
		{"by unique substring", "SIDE PANEL", Entry{3, seed[2]}, nil, "", []string{seed[0], seed[1], seed[3]}},
		{"ambiguous substring", "draft", Entry{}, ErrInvalidArgument, "\"draft\" is in 2 entries; give the number of one:\n  1. Always open PRs as drafts\n  4. Draft commit", seed},
		{"no match", "rebase", Entry{}, ErrNotFound, `no entry contains "rebase"`, seed},
		{"index zero", "0", Entry{}, ErrInvalidArgument, "the entries are 1 to 4", seed},
		{"index past the end", "5", Entry{}, ErrInvalidArgument, "the entries are 1 to 4", seed},
		{"negative is text", "-1", Entry{}, ErrNotFound, "", seed},
		{"empty", " ", Entry{}, ErrInvalidArgument, "", seed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := newStore(t)
			for _, x := range seed {
				if _, err := s.Add(x); err != nil {
					t.Fatal(err)
				}
			}
			got, err := s.Remove(tt.ref)
			if !errors.Is(err, tt.wantErr) || got != tt.want {
				t.Fatalf("Remove(%q) = %+v, %v; want %+v, %v", tt.ref, got, err, tt.want, tt.wantErr)
			}
			if tt.errHas != "" && !strings.Contains(err.Error(), tt.errHas) {
				t.Errorf("error %q, want containing %q", err, tt.errHas)
			}
			if left := texts(t, s); !slices.Equal(left, tt.left) {
				t.Errorf("left = %q, want %q", left, tt.left)
			}
		})
	}
	t.Run("empty memory", func(t *testing.T) {
		_, err := newStore(t).Remove("1")
		if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "the memory is empty") {
			t.Errorf("Remove on empty = %v", err)
		}
	})
	t.Run("last entry removes the file", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Add("only"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Remove("1"); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(s.Path()); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("file after the last remove: %v", err)
		}
	})
}

func TestClear(t *testing.T) {
	s := newStore(t)
	for _, x := range []string{"a", "b", "c"} {
		if _, err := s.Add(x); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := s.Clear(); n != 3 || err != nil {
		t.Errorf("Clear = %d, %v", n, err)
	}
	if got := texts(t, s); got != nil {
		t.Errorf("after Clear = %q", got)
	}
}

// Writes go through a temporary file and a rename: concurrent adds lose nothing, a
// reader never sees a partial file, and no temporary file is left behind.
func TestAtomicWrites(t *testing.T) {
	s := newStore(t)
	const n = 30
	var wg sync.WaitGroup
	stop := make(chan struct{})
	readErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				readErr <- nil
				return
			default:
			}
			b, err := os.ReadFile(s.Path())
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				readErr <- err
				return
			}
			if len(b) > 0 && !strings.HasSuffix(string(b), "\n") {
				readErr <- fmt.Errorf("partial file %q", b)
				return
			}
		}
	}()
	for i := range n {
		wg.Go(func() {
			if _, err := s.Add(fmt.Sprintf("entry %02d", i)); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	close(stop)
	if err := <-readErr; err != nil {
		t.Fatal(err)
	}
	if got := texts(t, s); len(got) != n {
		t.Errorf("%d entries after %d concurrent adds", len(got), n)
	}
	des, err := os.ReadDir(filepath.Dir(s.Path()))
	if err != nil {
		t.Fatal(err)
	}
	if len(des) != 1 || des[0].Name() != "memory.md" {
		var names []string
		for _, d := range des {
			names = append(names, d.Name())
		}
		t.Errorf("directory holds %q, want only memory.md", names)
	}
}

func TestParse(t *testing.T) {
	for _, tt := range []struct {
		name, file string
		want       []string
	}{
		{"empty", "", nil},
		{"entries", "- a\n- b\n", []string{"a", "b"}},
		{"blank lines and spaces", "\n  - a  \n\n-   b\n", []string{"a", "b"}},
		{"a line without a dash", "- a\nhand written\n", []string{"a", "hand written"}},
		{"a lone dash", "-\n- a\n", []string{"a"}},
		{"no trailing newline", "- a", []string{"a"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := Parse(tt.file); !slices.Equal(got, tt.want) {
				t.Errorf("Parse(%q) = %q, want %q", tt.file, got, tt.want)
			}
		})
	}
}
