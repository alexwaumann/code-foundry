package memory

import (
	"bytes"
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

func add(t *testing.T, s *Store, xs ...string) {
	t.Helper()
	for _, x := range xs {
		if _, err := s.Add(x, ""); err != nil {
			t.Fatal(err)
		}
	}
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
	if n, err := s.Clear(""); n != 0 || err != nil {
		t.Errorf("Clear = %d, %v", n, err)
	}
}

func TestAdd(t *testing.T) {
	s := newStore(t)
	long := strings.Repeat("é", MaxEntryChars) // 500 characters, 1000 bytes
	for _, tt := range []struct {
		name    string
		text    string
		want    Added
		wantErr error
		errHas  string
	}{
		{"first", "  Always open PRs as drafts  ", Added{Entry: Entry{1, "Always open PRs as drafts"}}, nil, ""},
		{"second", "Explain git terms when you use them", Added{Entry: Entry{2, "Explain git terms when you use them"}}, nil, ""},
		{"duplicate, any case", "always open prs as DRAFTS", Added{Entry: Entry{1, "Always open PRs as drafts"}, Duplicate: true}, nil, ""},
		{"duplicate after normalising", "-  Always   open PRs\tas drafts.", Added{Entry: Entry{1, "Always open PRs as drafts"}, Duplicate: true}, nil, ""},
		{"empty", "   ", Added{}, ErrInvalidArgument, "an empty entry"},
		{"only a dash", " - ", Added{}, ErrInvalidArgument, "an empty entry"},
		{"only a period", " . ", Added{}, ErrInvalidArgument, "an empty entry"},
		{"multi-line", "one\ntwo", Added{}, ErrInvalidArgument, "one line"},
		{"carriage return", "one\rtwo", Added{}, ErrInvalidArgument, "one line"},
		{"a list item", "- drop the dash", Added{Entry: Entry{3, "drop the dash"}}, nil, ""},
		{"a full stop", "Say it plainly.", Added{Entry: Entry{4, "Say it plainly"}}, nil, ""},
		{"an ellipsis stays", "Wait for me...", Added{Entry: Entry{5, "Wait for me..."}}, nil, ""},
		{"500 characters", long, Added{Entry: Entry{6, long}}, nil, ""},
		{"501 characters", long + "e", Added{}, ErrInvalidArgument, "at most 500 characters and this one has 501"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.Add(tt.text, "")
			if !errors.Is(err, tt.wantErr) || got != tt.want {
				t.Errorf("Add(%q) = %+v, %v; want %+v, %v", tt.text, got, err, tt.want, tt.wantErr)
			}
			if tt.errHas != "" && (err == nil || !strings.Contains(err.Error(), tt.errHas)) {
				t.Errorf("error %v, want containing %q", err, tt.errHas)
			}
		})
	}
	b, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	want := "- Always open PRs as drafts\n- Explain git terms when you use them\n- drop the dash\n- Say it plainly\n- Wait for me...\n- " + long + "\n"
	if string(b) != want {
		t.Errorf("file = %q, want %q", b, want)
	}
	if fi, err := os.Stat(s.Path()); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, %v", fi.Mode(), err)
	}
	if got := texts(t, s); !slices.Equal(got, []string{"Always open PRs as drafts", "Explain git terms when you use them", "drop the dash", "Say it plainly", "Wait for me...", long}) {
		t.Errorf("round trip = %q", got)
	}
}

func TestCaps(t *testing.T) {
	t.Run("entries", func(t *testing.T) {
		s := newStore(t)
		for i := range MaxEntries {
			add(t, s, fmt.Sprintf("preference %d", i+1))
		}
		_, err := s.Add("one more", "")
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "at most 40 entries") {
			t.Errorf("41st Add = %v", err)
		}
		// A duplicate is still a no-op, not a cap error.
		if a, err := s.Add("preference 7", ""); err != nil || !a.Duplicate || a.Entry.Index != 7 {
			t.Errorf("duplicate when full = %+v, %v", a, err)
		}
		if n := len(texts(t, s)); n != MaxEntries {
			t.Errorf("entries = %d", n)
		}
	})
	t.Run("bytes", func(t *testing.T) {
		s := newStore(t)
		long := strings.Repeat("x", 490)
		for i := range 8 { // 8 × 497 bytes
			add(t, s, fmt.Sprintf("%d %s", i, long))
		}
		_, err := s.Add(strings.Repeat("y", 200), "")
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "4096 bytes (4 KiB)") {
			t.Errorf("Add over 4 KiB = %v", err)
		}
		if b, _ := os.ReadFile(s.Path()); len(b) > MaxBytes {
			t.Errorf("file has %d bytes", len(b))
		}
		if _, err := s.Add("short", ""); err != nil {
			t.Errorf("an entry that fits = %v", err)
		}
	})
}

// A file edited past the caps keeps every entry for show and remove, but a thread's
// prompt gets the first ones within them.
func TestInjectedCaps(t *testing.T) {
	many := make([]string, 45)
	for i := range many {
		many[i] = fmt.Sprintf("preference %d", i+1)
	}
	big := make([]string, 6)
	for i := range big {
		big[i] = fmt.Sprintf("%d %s", i, strings.Repeat("z", 900)) // 905 bytes a line
	}
	for _, tt := range []struct {
		name    string
		entries []string
		want    int
		warn    bool
	}{
		{"within the caps", many[:3], 3, false},
		{"exactly 40", many[:40], 40, false},
		{"past 40 entries", many, 40, true},
		{"past 4 KiB", big, 4, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var logs bytes.Buffer
			s := New(filepath.Join(t.TempDir(), "memory.md"), slog.New(slog.NewTextHandler(&logs, nil)))
			if err := os.WriteFile(s.Path(), []byte(Render(tt.entries)), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := s.Injected()
			if err != nil || !slices.Equal(got, tt.entries[:tt.want]) {
				t.Errorf("Injected = %d entries, %v; want %d", len(got), err, tt.want)
			}
			if all := texts(t, s); len(all) != len(tt.entries) {
				t.Errorf("Texts = %d entries, want all %d", len(all), len(tt.entries))
			}
			if warned := strings.Contains(logs.String(), "level=WARN"); warned != tt.warn {
				t.Errorf("warned = %v, want %v: %s", warned, tt.warn, logs.String())
			}
		})
	}
}

func TestRemove(t *testing.T) {
	seed := []string{"Always open PRs as drafts", "Explain git terms", "Never open the side panel on your own", "Draft commit messages in English",
		"Use tabs", "Use tabs in Go files", "Keep 2 blank lines"}
	without := func(i int) []string { return slices.Delete(slices.Clone(seed), i, i+1) }
	for _, tt := range []struct {
		name    string
		ref     string
		want    Entry
		wantErr error
		errHas  string
		left    []string
	}{
		{"by index", "2", Entry{2, "Explain git terms"}, nil, "", without(1)},
		{"by index with spaces", " 4 ", Entry{4, seed[3]}, nil, "", without(3)},
		{"by unique substring", "SIDE PANEL", Entry{3, seed[2]}, nil, "", without(2)},
		{"exact text before substring", "use tabs", Entry{5, "Use tabs"}, nil, "", without(4)},
		{"exact text normalised", "- Use tabs.", Entry{5, "Use tabs"}, nil, "", without(4)},
		{"digits out of range as text", "2 blank", Entry{7, seed[6]}, nil, "", without(6)},
		{"ambiguous substring", "draft", Entry{}, ErrInvalidArgument, "\"draft\" is in 2 entries; give the number of one:\n  1. Always open PRs as drafts\n  4. Draft commit", seed},
		{"no match", "rebase", Entry{}, ErrNotFound, `no entry contains "rebase"`, seed},
		{"index zero", "0", Entry{}, ErrInvalidArgument, "the entries are 1 to 7", seed},
		{"index past the end", "9", Entry{}, ErrInvalidArgument, "the entries are 1 to 7", seed},
		{"negative is text", "-1", Entry{}, ErrNotFound, "", seed},
		{"empty", " ", Entry{}, ErrInvalidArgument, "", seed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := newStore(t)
			add(t, s, seed...)
			got, err := s.Remove(tt.ref, "")
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
	t.Run("digits that are in an entry's text", func(t *testing.T) {
		s := newStore(t)
		add(t, s, "Keep lines under 100 characters")
		if got, err := s.Remove("100", ""); err != nil || got.Index != 1 {
			t.Errorf("Remove(100) = %+v, %v", got, err)
		}
	})
	t.Run("empty memory", func(t *testing.T) {
		_, err := newStore(t).Remove("1", "")
		if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "the memory is empty") {
			t.Errorf("Remove on empty = %v", err)
		}
	})
	t.Run("last entry removes the file", func(t *testing.T) {
		s := newStore(t)
		add(t, s, "only")
		if _, err := s.Remove("1", ""); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(s.Path()); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("file after the last remove: %v", err)
		}
	})
}

func TestClear(t *testing.T) {
	s := newStore(t)
	add(t, s, "a", "b", "c")
	if n, err := s.Clear(""); n != 3 || err != nil {
		t.Errorf("Clear = %d, %v", n, err)
	}
	if got := texts(t, s); got != nil {
		t.Errorf("after Clear = %q", got)
	}
}

// A memory file that is a symbolic link is written through: the link stays, its target
// changes; a link to nothing is refused with an error naming both.
func TestSymlink(t *testing.T) {
	for _, tt := range []struct {
		name   string
		op     func(*Store) error
		target string // the target's content after op
	}{
		{"add", func(s *Store) error { _, err := s.Add("b", ""); return err }, "- a\n- b\n"},
		{"remove the last", func(s *Store) error { _, err := s.Remove("a", ""); return err }, ""},
		{"clear", func(s *Store) error { _, err := s.Clear(""); return err }, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "dotfiles", "cf-memory.md")
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("- a\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(dir, "memory.md")
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			s := New(link, slog.New(slog.DiscardHandler))
			if err := tt.op(s); err != nil {
				t.Fatal(err)
			}
			if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
				t.Errorf("the link was replaced: %v, %v", fi.Mode(), err)
			}
			if b, err := os.ReadFile(target); err != nil || string(b) != tt.target {
				t.Errorf("target = %q, %v; want %q", b, err, tt.target)
			}
		})
	}
	t.Run("dangling", func(t *testing.T) {
		dir := t.TempDir()
		link := filepath.Join(dir, "memory.md")
		if err := os.Symlink(filepath.Join(dir, "gone.md"), link); err != nil {
			t.Fatal(err)
		}
		s := New(link, slog.New(slog.DiscardHandler))
		_, err := s.Add("a", "")
		if err == nil || !strings.Contains(err.Error(), "is a symbolic link to "+filepath.Join(dir, "gone.md")+", which does not exist") {
			t.Errorf("Add through a dangling link = %v", err)
		}
		if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
			t.Errorf("the link was replaced: %v", err)
		}
	})
}

// A read error names the file once.
func TestReadErrorNamesPathOnce(t *testing.T) {
	s := newStore(t)
	if err := os.Mkdir(s.Path(), 0o700); err != nil { // a directory: reading it fails
		t.Fatal(err)
	}
	_, err := s.Texts()
	if err == nil || strings.Count(err.Error(), s.Path()) != 1 || !strings.HasPrefix(err.Error(), "memory: read "+s.Path()+": ") {
		t.Errorf("Texts = %v", err)
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
			if _, err := s.Add(fmt.Sprintf("entry %02d", i), ""); err != nil {
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
		{"CRLF", "- a\r\n- b\r\n", []string{"a", "b"}},
		{"headings", "# Preferences\n## Git\n- a\n#hashtag kept\n", []string{"a", "#hashtag kept"}},
		{"comments", "<!-- one -->\n- a <!-- inline --> b\n<!--\n- hidden\n-->\n- c\n", []string{"a b", "c"}},
		{"an open comment runs to the end", "- a\n<!-- - b\n- c\n", []string{"a"}},
		{"normalised", "-   Always   open\tPRs as drafts.\n", []string{"Always open PRs as drafts"}},
		{"repeats count once", "- Use tabs\n- use tabs.\n- b\n", []string{"Use tabs", "b"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := Parse(tt.file); !slices.Equal(got, tt.want) {
				t.Errorf("Parse(%q) = %q, want %q", tt.file, got, tt.want)
			}
		})
	}
}

func TestNormalize(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"  a  ", "a"},
		{"a \t  b", "a b"},
		{"- a", "a"},
		{"-a", "-a"},
		{"- - a", "- a"},
		{"a.", "a"},
		{"a...", "a..."},
		{"a..", "a.."},
		{"-", ""},
		{".", ""},
	} {
		if got := Normalize(tt.in); got != tt.want {
			t.Errorf("Normalize(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
