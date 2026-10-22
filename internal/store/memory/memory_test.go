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
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

var t0 = time.Date(2026, 10, 22, 14, 3, 11, 0, time.UTC)

// clock is a Now that starts at t0 and moves a second per call.
func clock() func() time.Time {
	var mu sync.Mutex
	now := t0
	return func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(time.Second)
		return now
	}
}

func newStore(t *testing.T) *Store {
	t.Helper()
	return New(Options{Dir: filepath.Join(t.TempDir(), "memory"), Log: slog.New(slog.DiscardHandler), Now: clock()})
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
		if _, err := s.Add(x, Origin{}); err != nil {
			t.Fatal(err)
		}
	}
}

// files are the directory's names, sorted.
func files(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for _, d := range des {
		out = append(out, d.Name())
	}
	return out
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func write(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestMissingDirIsEmpty(t *testing.T) {
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
	if _, err := os.Stat(s.Dir()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("reading made the directory: %v", err)
	}
}

// An entry is a file with its provenance in frontmatter; the index lists every entry.
func TestLayout(t *testing.T) {
	s := newStore(t)
	a, err := s.Add("Always open PRs as drafts", Origin{ThreadID: "s-abc", ThreadName: "fix: the PR flow"})
	if err != nil {
		t.Fatal(err)
	}
	want := Entry{Index: 1, Text: "Always open PRs as drafts", File: "always-open-prs-as-drafts.md",
		Created: t0.Add(time.Second), ThreadID: "s-abc", ThreadName: "fix: the PR flow", Injected: true}
	if id := a.Entry.ID(); id != "always-open-prs-as-drafts" {
		t.Errorf("ID = %q", id)
	}
	if a.Entry != want {
		t.Errorf("Add = %+v, want %+v", a.Entry, want)
	}
	add(t, s, "Explain [git] terms")
	if got := files(t, s.Dir()); !slices.Equal(got, []string{"MEMORY.md", "always-open-prs-as-drafts.md", "explain-git-terms.md"}) {
		t.Errorf("directory = %q", got)
	}
	if got, want := read(t, filepath.Join(s.Dir(), "always-open-prs-as-drafts.md")),
		"---\ncreated: 2026-10-22T14:03:12.000Z\nthread: s-abc\nthread_name: \"fix: the PR flow\"\n---\nAlways open PRs as drafts\n"; got != want {
		t.Errorf("entry file = %q, want %q", got, want)
	}
	if got, want := read(t, filepath.Join(s.Dir(), "explain-git-terms.md")),
		"---\ncreated: 2026-10-22T14:03:13.000Z\n---\nExplain [git] terms\n"; got != want {
		t.Errorf("user's entry file = %q, want %q", got, want)
	}
	if got, want := read(t, filepath.Join(s.Dir(), IndexFile)),
		"- [Always open PRs as drafts](always-open-prs-as-drafts.md)\n- [Explain \\[git\\] terms](explain-git-terms.md)\n"; got != want {
		t.Errorf("index = %q, want %q", got, want)
	}
	for _, name := range files(t, s.Dir()) {
		if fi, err := os.Stat(filepath.Join(s.Dir(), name)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %v, %v", name, fi.Mode(), err)
		}
	}
	if fi, err := os.Stat(s.Dir()); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("directory mode = %v, %v", fi.Mode(), err)
	}
	got, err := s.Entries()
	if err != nil || len(got) != 2 || got[0] != want || got[1].ThreadID != "" || got[1].Index != 2 {
		t.Errorf("Entries = %+v, %v", got, err)
	}
}

func TestAdd(t *testing.T) {
	s := newStore(t)
	long := strings.Repeat("é", MaxEntryChars) // 500 characters, 1000 bytes
	for _, tt := range []struct {
		name    string
		text    string
		want    int // the entry's index; 0 for an error
		dup     bool
		wantErr error
		errHas  string
	}{
		{"first", "  Always open PRs as drafts  ", 1, false, nil, ""},
		{"second", "Explain git terms when you use them", 2, false, nil, ""},
		{"duplicate, any case", "always open prs as DRAFTS", 1, true, nil, ""},
		{"duplicate after normalising", "-  Always   open PRs\tas drafts.", 1, true, nil, ""},
		{"empty", "   ", 0, false, ErrInvalidArgument, "an empty entry"},
		{"only a dash", " - ", 0, false, ErrInvalidArgument, NoLetter},
		{"only a period", " . ", 0, false, ErrInvalidArgument, NoLetter},
		{"only stars", "***", 0, false, ErrInvalidArgument, NoLetter},
		{"a bullet and punctuation", "* ---", 0, false, ErrInvalidArgument, NoLetter},
		{"an emoji alone", "🚀🎉", 0, false, ErrInvalidArgument, NoLetter},
		{"multi-line", "one\ntwo", 0, false, ErrInvalidArgument, "one line"},
		{"carriage return", "one\rtwo", 0, false, ErrInvalidArgument, "one line"},
		{"a list item", "- drop the dash", 3, false, nil, ""},
		{"a full stop", "Say it plainly.", 4, false, nil, ""},
		{"an ellipsis stays", "Wait for me...", 5, false, nil, ""},
		{"500 characters", long, 6, false, nil, ""},
		{"501 characters", long + "e", 0, false, ErrInvalidArgument, "at most 500 characters and this one has 501"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.Add(tt.text, Origin{})
			if !errors.Is(err, tt.wantErr) || got.Entry.Index != tt.want || got.Duplicate != tt.dup {
				t.Errorf("Add(%q) = %+v, %v; want #%d dup %v, %v", tt.text, got, err, tt.want, tt.dup, tt.wantErr)
			}
			if tt.errHas != "" && (err == nil || !strings.Contains(err.Error(), tt.errHas)) {
				t.Errorf("error %v, want containing %q", err, tt.errHas)
			}
		})
	}
	want := []string{"Always open PRs as drafts", "Explain git terms when you use them", "drop the dash", "Say it plainly", "Wait for me...", long}
	if got := texts(t, s); !slices.Equal(got, want) {
		t.Errorf("round trip = %q", got)
	}
	if got := files(t, s.Dir()); len(got) != len(want)+1 || !slices.Contains(got, strings.Repeat("e", maxSlug)+".md") {
		t.Errorf("directory = %q (the all-é entry is e…e.md)", got)
	}
}

// Entries keep the order they were added in, also several in one millisecond.
func TestOrder(t *testing.T) {
	s := New(Options{Dir: filepath.Join(t.TempDir(), "memory"), Log: slog.New(slog.DiscardHandler),
		Now: func() time.Time { return t0 }})
	add(t, s, "zebra", "apple", "mango")
	got, err := s.Entries()
	if err != nil {
		t.Fatal(err)
	}
	var created []time.Time
	for _, e := range got {
		created = append(created, e.Created)
	}
	if !slices.Equal(texts(t, s), []string{"zebra", "apple", "mango"}) ||
		!slices.Equal(created, []time.Time{t0, t0.Add(time.Millisecond), t0.Add(2 * time.Millisecond)}) {
		t.Errorf("entries = %+v", got)
	}
}

func TestSlug(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"Always open PRs as drafts", "always-open-prs-as-drafts"},
		{"  --Don't   use `git push -f`!  ", "don-t-use-git-push-f"},
		{"Café crème", "cafe-creme"},
		{"naïve café", "naive-cafe"},
		{"Mañana, ÉTÉ", "manana-ete"},
		{"Straße Æsir Œuvre Łódź", "strasse-aesir-oeuvre-lodz"},
		{"Prefer “smart quotes” and naïve café émoji 🚀 in docs", "prefer-smart-quotes-and-naive-cafe-emoji-in-docs"},
		{"日本語", "entry"},
		{"!!!", "entry"},
		{strings.Repeat("abcdefgh ", 10), "abcdefgh-abcdefgh-abcdefgh-abcdefgh-abcdefgh"},
		{strings.Repeat("x", 60), strings.Repeat("x", 48)},
	} {
		if got := slug(tt.in); got != tt.want {
			t.Errorf("slug(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// A slug taken (another entry's, a hand-made file's, the index's) gets a number.
func TestFileNameDeduplicates(t *testing.T) {
	s := newStore(t)
	add(t, s, "Use tabs", "Use tabs!", "use-tabs 2", "Memory", "memory?")
	if got := files(t, s.Dir()); !slices.Equal(got, []string{"MEMORY.md", "memory-2.md", "memory-3.md", "use-tabs-2-2.md", "use-tabs-2.md", "use-tabs.md"}) {
		t.Errorf("directory = %q", got)
	}
	// A rename is a new file: the old one goes with remove.
	if _, err := s.Remove("Use tabs!", ""); err != nil {
		t.Fatal(err)
	}
	add(t, s, "Use tabs everywhere")
	if got := files(t, s.Dir()); !slices.Contains(got, "use-tabs-everywhere.md") || slices.Contains(got, "use-tabs-2.md") {
		t.Errorf("directory = %q", got)
	}
}

func TestCaps(t *testing.T) {
	t.Run("entries", func(t *testing.T) {
		s := newStore(t)
		for i := range MaxEntries {
			add(t, s, fmt.Sprintf("preference %d", i+1))
		}
		_, err := s.Add("one more", Origin{})
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "at most 40 entries") {
			t.Errorf("41st Add = %v", err)
		}
		// A duplicate is still a no-op, not a cap error.
		if a, err := s.Add("preference 7", Origin{}); err != nil || !a.Duplicate || a.Entry.Index != 7 {
			t.Errorf("duplicate when full = %+v, %v", a, err)
		}
		if n := len(texts(t, s)); n != MaxEntries {
			t.Errorf("entries = %d", n)
		}
	})
	t.Run("bytes", func(t *testing.T) {
		s := newStore(t)
		long := strings.Repeat("x", 490)
		for i := range 8 { // 8 × 495 bytes rendered
			add(t, s, fmt.Sprintf("%d %s", i, long))
		}
		_, err := s.Add(strings.Repeat("y", 200), Origin{})
		if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "4096 bytes (4 KiB)") {
			t.Errorf("Add over 4 KiB = %v", err)
		}
		if _, err := s.Add("short", Origin{}); err != nil {
			t.Errorf("an entry that fits = %v", err)
		}
		if snap := s.Snapshot(); snap.Injected != 9 || snap.InjectedBytes != 8*495+len("- short\n") {
			t.Errorf("snapshot injected %d, %d bytes", snap.Injected, snap.InjectedBytes)
		}
	})
}

// A directory edited past the caps keeps every entry for show and remove, but a
// thread's prompt gets the first ones within them.
func TestInjectedCaps(t *testing.T) {
	many := make([]string, 45)
	for i := range many {
		many[i] = fmt.Sprintf("preference %02d", i+1)
	}
	big := make([]string, 10)
	for i := range big {
		big[i] = fmt.Sprintf("%d %s", i, strings.Repeat("z", 450)) // 455 bytes a line: 9 fit
	}
	long := "a " + strings.Repeat("y", MaxEntryChars) // 502 characters
	reasons := func(n int, at map[int]string) []string {
		out := make([]string, n)
		for i, r := range at {
			out[i] = r
		}
		return out
	}
	tail := func(from, n int, r string) map[int]string {
		m := map[int]string{}
		for i := from; i < n; i++ {
			m[i] = r
		}
		return m
	}
	for _, tt := range []struct {
		name    string
		entries []string
		want    []string // injected
		leftOut []string // per entry
		warn    bool
	}{
		{"within the caps", many[:3], many[:3], reasons(3, nil), false},
		{"exactly 40", many[:40], many[:40], reasons(40, nil), false},
		{"past 40 entries", many, many[:40], reasons(45, tail(40, 45, LeftOutEntries)), true},
		{"past 4 KiB", big, big[:9], reasons(10, tail(9, 10, LeftOutBytes)), true},
		{"too long is left out alone", []string{"one", long, "two"}, []string{"one", "two"}, reasons(3, map[int]string{1: LeftOutTooLong}), true},
		{"too long does not count towards 40", append([]string{long}, many[:40]...), many[:40],
			reasons(41, map[int]string{0: LeftOutTooLong}), true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var logs bytes.Buffer
			dir := filepath.Join(t.TempDir(), "memory")
			s := New(Options{Dir: dir, Log: slog.New(slog.NewTextHandler(&logs, nil))})
			for i, e := range tt.entries {
				write(t, filepath.Join(dir, fmt.Sprintf("e%02d.md", i)), renderEntry(e, t0.Add(time.Duration(i)*time.Second), Origin{}))
			}
			got, err := s.Injected()
			if err != nil || !slices.Equal(got, tt.want) {
				t.Errorf("Injected = %d entries, %v; want %d", len(got), err, len(tt.want))
			}
			if all := texts(t, s); len(all) != len(tt.entries) {
				t.Errorf("Texts = %d entries, want all %d", len(all), len(tt.entries))
			}
			if warned := strings.Contains(logs.String(), "level=WARN"); warned != tt.warn {
				t.Errorf("warned = %v, want %v: %s", warned, tt.warn, logs.String())
			}
			snap := s.Snapshot()
			if snap.Injected != len(tt.want) || len(snap.Entries) != len(tt.entries) {
				t.Errorf("snapshot = %d injected of %d", snap.Injected, len(snap.Entries))
			}
			for i, e := range snap.Entries {
				if e.LeftOut != tt.leftOut[i] || e.Injected != (tt.leftOut[i] == "") {
					t.Errorf("entry %d: injected %v, left out %q; want %q", i+1, e.Injected, e.LeftOut, tt.leftOut[i])
				}
			}
		})
	}
}

// Files edited or added by hand are read leniently; the index is never read.
func TestHandEdits(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "memory")
	old := t0.Add(-time.Hour)
	write(t, filepath.Join(dir, "plain.md"), "Keep answers short.\n") // no frontmatter
	if err := os.Chtimes(filepath.Join(dir, "plain.md"), old, old); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "a.md"), "---\ncreated: 2026-10-22T15:00:00Z\nthread: 's-1'\nthread_name: \"it's: mine\"\nextra: x\n---\n# Heading\n\n- Explain\n  git terms <!-- why -->\n")
	write(t, filepath.Join(dir, "b.md"), "---\ncreated: not a time\n---\nexplain GIT terms\n") // a copy of a.md's text
	write(t, filepath.Join(dir, "open.md"), "---\nno closing line\nstill text\n")              // the whole file is text
	write(t, filepath.Join(dir, "empty.md"), "---\ncreated: 2026-10-22T15:00:00Z\n---\n\n")    // no text: skipped
	write(t, filepath.Join(dir, IndexFile), "- [Not an entry](nowhere.md)\n")                  // never read
	write(t, filepath.Join(dir, ".always.md.123"), "a temporary file\n")                       // a write's: skipped
	write(t, filepath.Join(dir, "notes.txt"), "not markdown\n")                                // skipped
	if err := os.Mkdir(filepath.Join(dir, "sub.md"), 0o700); err != nil {                      // skipped
		t.Fatal(err)
	}
	s := New(Options{Dir: dir, Log: slog.New(slog.DiscardHandler)})
	got, err := s.Entries()
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, e := range got {
		lines = append(lines, fmt.Sprintf("%d %s %s %q %q %v", e.Index, e.File, e.Text, e.ThreadID, e.ThreadName, e.Created.IsZero()))
	}
	want := []string{
		`1 plain.md Keep answers short "" "" true`,
		`2 a.md Explain git terms "s-1" "it's: mine" false`,
		`3 open.md --- no closing line still text "" "" true`,
	}
	// b.md and open.md have no created: their modification time (now) orders them;
	// b.md's text is a.md's, so it counts once.
	if len(lines) != 3 || lines[0] != want[0] || lines[1] != want[1] || lines[2] != want[2] {
		t.Errorf("entries =\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
	// Removing the text removes every file holding it.
	if _, err := s.Remove("git terms", ""); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"a.md", "b.md"} {
		if _, err := os.Stat(filepath.Join(dir, f)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s after remove: %v", f, err)
		}
	}
	if got := read(t, filepath.Join(dir, IndexFile)); got != "- [Keep answers short](plain.md)\n- [--- no closing line still text](open.md)\n" {
		t.Errorf("index after remove = %q", got)
	}
	// Clear removes every entry file, the textless one too, and leaves the rest.
	if n, err := s.Clear(""); n != 2 || err != nil {
		t.Errorf("Clear = %d, %v", n, err)
	}
	if got := files(t, dir); !slices.Equal(got, []string{".always.md.123", "MEMORY.md", "notes.txt", "sub.md"}) {
		t.Errorf("directory after clear = %q", got)
	}
	if got := read(t, filepath.Join(dir, IndexFile)); got != "" {
		t.Errorf("index after clear = %q", got)
	}
}

func TestParseEntry(t *testing.T) {
	for _, tt := range []struct {
		name, file string
		want       parsed
	}{
		{"store's", "---\ncreated: 2026-10-22T14:03:11.000Z\nthread: s-1\nthread_name: n\n---\nA\n", parsed{"A", t0, "s-1", "n"}},
		{"CRLF", "---\r\ncreated: 2026-10-22T14:03:11Z\r\n---\r\nA\r\n", parsed{text: "A", created: t0}},
		{"no frontmatter", "A\nB\n", parsed{text: "A B"}},
		{"empty frontmatter", "---\n---\nA", parsed{text: "A"}},
		{"closing at the end", "---\nthread: s-1\n---", parsed{threadID: "s-1"}},
		{"quoted", "---\nthread_name: \"a \\\"b\\\"\"\n---\nA", parsed{text: "A", threadNm: `a "b"`}},
		{"offset time", "---\ncreated: 2026-10-22T16:03:11+02:00\n---\nA", parsed{text: "A", created: t0}},
		{"invalid UTF-8", "A\xff B", parsed{text: "A B"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseEntry(tt.file); got != tt.want {
				t.Errorf("parseEntry(%q) = %+v, want %+v", tt.file, got, tt.want)
			}
		})
	}
	// What the store writes reads back.
	for _, name := range []string{"plain", "a: b", `"quoted"`, "- dash", "#tag", " padded ", "tab\there", "ünï"} {
		p := parseEntry(renderEntry("t", t0, Origin{ThreadID: "s-1", ThreadName: name}))
		if p.threadNm != name || p.threadID != "s-1" || !p.created.Equal(t0) || p.text != "t" {
			t.Errorf("round trip of thread name %q = %+v", name, p)
		}
	}
}

func TestRemove(t *testing.T) {
	seed := []string{"Always open PRs as drafts", "Explain git terms", "Never open the side panel on your own", "Draft commit messages in English",
		"Use tabs", "Use tabs in Go files", "Keep 2 blank lines"}
	without := func(i int) []string { return slices.Delete(slices.Clone(seed), i, i+1) }
	for _, tt := range []struct {
		name    string
		ref     string
		want    int // the removed entry's index; 0 for an error
		wantErr error
		errHas  string
		left    []string
	}{
		{"by index", "2", 2, nil, "", without(1)},
		{"by index with spaces", " 4 ", 4, nil, "", without(3)},
		{"by unique substring", "SIDE PANEL", 3, nil, "", without(2)},
		{"exact text before substring", "use tabs", 5, nil, "", without(4)},
		{"exact text normalised", "- Use tabs.", 5, nil, "", without(4)},
		{"digits out of range as text", "2 blank", 7, nil, "", without(6)},
		{"by id", "never-open-the-side-panel-on-your-own", 3, nil, "", without(2)},
		{"by id, any case", "USE-TABS-IN-GO-FILES", 6, nil, "", without(5)},
		{"an id before a substring", "use-tabs", 5, nil, "", without(4)},
		{"ambiguous substring", "draft", 0, ErrInvalidArgument, "\"draft\" is in 2 entries; give the number of one:\n  1. Always open PRs as drafts\n  4. Draft commit", seed},
		{"no match", "rebase", 0, ErrNotFound, `no entry contains "rebase"`, seed},
		{"index zero", "0", 0, ErrInvalidArgument, "the entries are 1 to 7", seed},
		{"index past the end", "9", 0, ErrInvalidArgument, "the entries are 1 to 7", seed},
		{"negative is text", "-1", 0, ErrNotFound, "", seed},
		{"empty", " ", 0, ErrInvalidArgument, "", seed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := newStore(t)
			add(t, s, seed...)
			got, err := s.Remove(tt.ref, "")
			if !errors.Is(err, tt.wantErr) || got.Index != tt.want || (tt.want > 0 && got.Text != seed[tt.want-1]) {
				t.Fatalf("Remove(%q) = %+v, %v; want #%d, %v", tt.ref, got, err, tt.want, tt.wantErr)
			}
			if tt.errHas != "" && !strings.Contains(err.Error(), tt.errHas) {
				t.Errorf("error %q, want containing %q", err, tt.errHas)
			}
			if left := texts(t, s); !slices.Equal(left, tt.left) {
				t.Errorf("left = %q, want %q", left, tt.left)
			}
			if tt.want > 0 {
				if _, err := os.Stat(filepath.Join(s.Dir(), got.File)); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("the removed entry's file: %v", err)
				}
				if idx := read(t, filepath.Join(s.Dir(), IndexFile)); strings.Contains(idx, got.File) || strings.Count(idx, "\n") != len(tt.left) {
					t.Errorf("index = %q", idx)
				}
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
}

// The Settings page removes by id: after a hand edit its list is stale, and an id never
// names another entry (a position would: the bug this replaced).
func TestRemoveID(t *testing.T) {
	s := newStore(t)
	add(t, s, "Always open PRs as drafts", "Explain git terms", "Use tabs")
	shown, err := s.Entries()
	if err != nil {
		t.Fatal(err)
	}
	// The second entry's file goes by hand; the page still shows three rows.
	if err := os.Remove(filepath.Join(s.Dir(), shown[1].File)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RemoveID(shown[1].ID(), ""); !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), "there is no entry explain-git-terms now") {
		t.Errorf("RemoveID of a gone entry = %v", err)
	}
	if got := texts(t, s); !slices.Equal(got, []string{"Always open PRs as drafts", "Use tabs"}) {
		t.Errorf("a refused remove changed the memory: %q", got)
	}
	// The third row, now second by position, goes by its id.
	got, err := s.RemoveID(shown[2].ID(), "")
	if err != nil || got.Text != "Use tabs" {
		t.Errorf("RemoveID = %+v, %v", got, err)
	}
	if got := texts(t, s); !slices.Equal(got, []string{"Always open PRs as drafts"}) {
		t.Errorf("left = %q", got)
	}
	if _, err := s.RemoveID(" ", ""); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("RemoveID of nothing = %v", err)
	}
	// A copy made by hand shares the entry: either file's id names it, and both go.
	write(t, filepath.Join(s.Dir(), "copy.md"), "always open prs as drafts\n")
	if got, err := s.RemoveID("COPY", ""); err != nil || got.Text != "Always open PRs as drafts" {
		t.Errorf("RemoveID of a copy = %+v, %v", got, err)
	}
	if got := files(t, s.Dir()); !slices.Equal(got, []string{IndexFile}) {
		t.Errorf("directory = %q", got)
	}
}

// A hand edit is published without a read: the directory is watched, also one made
// after the watch began, and one removed and made again.
func TestWatch(t *testing.T) {
	b := bus.New()
	dir := filepath.Join(t.TempDir(), "memory")
	s := New(Options{Dir: dir, Bus: b, Log: slog.New(slog.DiscardHandler), WatchRetry: 20 * time.Millisecond})
	sub := bus.Subscribe[Event](b, 16)
	defer sub.Close()
	s.Watch(t.Context())
	wait := func(want ...string) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			select {
			case ev := <-sub.C():
				snap := ev.(*Snapshot)
				var got []string
				for _, e := range snap.Entries {
					got = append(got, e.Text)
				}
				if slices.Equal(got, want) {
					return
				}
			case <-deadline:
				t.Fatalf("no snapshot with %q", want)
			}
		}
	}
	// The directory appears (the retry finds it), with an entry.
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "a.md"), "first\n")
	wait("first")
	write(t, filepath.Join(dir, "b.md"), "second\n")
	wait("first", "second")
	write(t, filepath.Join(dir, "a.md"), "first, edited\n")
	wait("second", "first, edited") // no frontmatter: ordered by modification time
	if err := os.Remove(filepath.Join(dir, "a.md")); err != nil {
		t.Fatal(err)
	}
	wait("second")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	wait()
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "c.md"), "back\n")
	wait("back")
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
	if got := files(t, s.Dir()); !slices.Equal(got, []string{IndexFile}) {
		t.Errorf("directory after Clear = %q", got)
	}
}

// A memory directory that is a symbolic link (a user keeping it with their dotfiles) is
// written through: the link stays.
func TestSymlinkedDir(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "dotfiles", "cf-memory")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "memory")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	s := New(Options{Dir: link, Log: slog.New(slog.DiscardHandler)})
	add(t, s, "a")
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced: %v", err)
	}
	if got := files(t, target); !slices.Equal(got, []string{IndexFile, "a.md"}) {
		t.Errorf("target = %q", got)
	}
}

// A read error names the directory once.
func TestReadErrorNamesPathOnce(t *testing.T) {
	s := newStore(t)
	write(t, s.Dir(), "a file where the directory goes")
	_, err := s.Texts()
	if err == nil || strings.Count(err.Error(), s.Dir()) != 1 || !strings.HasPrefix(err.Error(), "memory: read "+s.Dir()+": ") {
		t.Errorf("Texts = %v", err)
	}
	if snap := s.Snapshot(); snap.Err != err.Error() {
		t.Errorf("snapshot Err = %q", snap.Err)
	}
}

// Writes go through a temporary file and a rename: concurrent adds lose nothing, a
// reader never sees a partial entry, and no temporary file is left behind.
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
			files, err := s.entryFiles()
			if err != nil {
				readErr <- err
				return
			}
			for _, f := range files {
				b, err := os.ReadFile(filepath.Join(s.Dir(), f.Name()))
				if err != nil {
					readErr <- err
					return
				}
				if !strings.HasSuffix(string(b), "\n") || parseEntry(string(b)).created.IsZero() {
					readErr <- fmt.Errorf("partial file %q", b)
					return
				}
			}
		}
	}()
	for i := range n {
		wg.Go(func() {
			if _, err := s.Add(fmt.Sprintf("entry %02d", i), Origin{}); err != nil {
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
	got := files(t, s.Dir())
	if len(got) != n+1 || slices.ContainsFunc(got, func(n string) bool { return strings.HasPrefix(n, ".") }) {
		t.Errorf("directory holds %q, want %d entries and the index", got, n)
	}
	if idx := read(t, filepath.Join(s.Dir(), IndexFile)); strings.Count(idx, "\n") != n {
		t.Errorf("index has %d lines", strings.Count(idx, "\n"))
	}
}

// Every change a read or write sees is published once, with the whole memory.
func TestSnapshotPublishes(t *testing.T) {
	b := bus.New()
	sub := bus.Subscribe[Event](b, 16)
	defer sub.Close()
	dir := filepath.Join(t.TempDir(), "memory")
	s := New(Options{Dir: dir, Bus: b, Log: slog.New(slog.DiscardHandler), Now: clock()})
	next := func() *Snapshot {
		t.Helper()
		select {
		case ev := <-sub.C():
			return ev.(*Snapshot)
		default:
			return nil
		}
	}
	if s.Load(); next() != nil {
		t.Error("an empty memory read published")
	}
	if _, err := s.Add("a", Origin{ThreadID: "s-1", ThreadName: "n"}); err != nil {
		t.Fatal(err)
	}
	snap := next()
	if snap == nil || len(snap.Entries) != 1 || snap.Entries[0].ThreadID != "s-1" || snap.Version != 1 || snap.Injected != 1 {
		t.Fatalf("after Add: %+v", snap)
	}
	if extra := next(); extra != nil {
		t.Errorf("Add published twice: %+v", extra)
	}
	if _, err := s.Add("A", Origin{}); err != nil { // a duplicate changes nothing
		t.Fatal(err)
	}
	s.Load()
	if extra := next(); extra != nil {
		t.Errorf("a duplicate and a read published: %+v", extra)
	}
	write(t, filepath.Join(dir, "hand.md"), "by hand\n")
	if snap := s.Load(); len(snap.Entries) != 2 || snap.Version != 2 {
		t.Errorf("Load after a hand edit = %+v", snap)
	}
	if snap := next(); snap == nil || snap.Entries[1].Text != "by hand" {
		t.Errorf("hand edit published %+v", snap)
	}
	if _, err := s.Clear(""); err != nil {
		t.Fatal(err)
	}
	if snap := next(); snap == nil || len(snap.Entries) != 0 || snap.Entries == nil {
		t.Errorf("after Clear: %+v", snap)
	}
}

func TestImport(t *testing.T) {
	mtime := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	tooLong := strings.Repeat("w", MaxEntryChars+20)
	for _, tt := range []struct {
		name     string
		legacy   *string // nil: no legacy file
		existing []string
		want     []string
		res      Imported
	}{
		{name: "no file", want: nil, res: Imported{}},
		{name: "entries in order", legacy: ptr("- Zebra first\n- apple second\n- Mango third.\n"),
			want: []string{"Zebra first", "apple second", "Mango third"}, res: Imported{Entries: 3}},
		{name: "an empty file", legacy: ptr(""), want: nil, res: Imported{}},
		{name: "hand edits", legacy: ptr("# Preferences\r\n\r\n<!-- a comment -->\r\nhand written\r\n-   spaced   out  \r\n- Hand Written\r\n"),
			want: []string{"hand written", "spaced out"}, res: Imported{Entries: 2}},
		{name: "malformed lines", legacy: ptr("---\n- ok\n***\n- |---|\n-\n- also ok\n"),
			want: []string{"ok", "also ok"}, res: Imported{Entries: 2, Skipped: 4}},
		{name: "star and plus bullets", legacy: ptr("* Use tabs\n+ Keep answers short\n*\n+\n- 🚀\n"),
			want: []string{"Use tabs", "Keep answers short"}, res: Imported{Entries: 2, Skipped: 3}},
		{name: "invalid UTF-8", legacy: ptr("- caf\xff\xfee\n"), want: []string{"cafe"}, res: Imported{Entries: 1}},
		{name: "past the caps is kept", legacy: ptr("- " + tooLong + "\n- short\n"), want: []string{tooLong, "short"}, res: Imported{Entries: 2}},
		{name: "cut short and run again", legacy: ptr("- one\n- two\n- three\n"), existing: []string{"one", "TWO"},
			want: []string{"one", "TWO", "three"}, res: Imported{Entries: 1, Existing: 2}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			dir, legacy := filepath.Join(home, "memory"), filepath.Join(home, "memory.md")
			s := New(Options{Dir: dir, Legacy: legacy, Log: slog.New(slog.DiscardHandler), Now: func() time.Time { return mtime.Add(-time.Hour) }}) // before the import, as a cut-short one
			add(t, s, tt.existing...)
			if tt.legacy != nil {
				write(t, legacy, *tt.legacy)
				if err := os.Chtimes(legacy, mtime, mtime); err != nil {
					t.Fatal(err)
				}
				tt.res.Renamed = legacy + ImportedSuffix
			}
			res, err := s.Import()
			if err != nil || res != tt.res {
				t.Fatalf("Import = %+v, %v; want %+v", res, err, tt.res)
			}
			got, err := s.Entries()
			if err != nil {
				t.Fatal(err)
			}
			var gotTexts []string
			for _, e := range got {
				gotTexts = append(gotTexts, e.Text)
				if slices.Contains(tt.existing, e.Text) {
					continue
				}
				if e.ThreadID != "" || e.Created.Before(mtime) || e.Created.After(mtime.Add(time.Second)) {
					t.Errorf("imported %+v: want no thread, created at the file's mtime", e)
				}
			}
			if !slices.Equal(gotTexts, tt.want) {
				t.Errorf("entries = %q, want %q", gotTexts, tt.want)
			}
			if tt.legacy == nil {
				if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) && tt.existing == nil {
					t.Errorf("no legacy file made the directory: %v", err)
				}
				return
			}
			if _, err := os.Stat(legacy); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("legacy file still there: %v", err)
			}
			if got := read(t, legacy+ImportedSuffix); got != *tt.legacy {
				t.Errorf("renamed file = %q", got)
			}
			if idx := read(t, filepath.Join(dir, IndexFile)); strings.Count(idx, "\n") != len(tt.want) {
				t.Errorf("index = %q", idx)
			}
			// A second start finds nothing to import.
			if res, err := s.Import(); err != nil || res != (Imported{}) {
				t.Errorf("second Import = %+v, %v", res, err)
			}
		})
	}
	t.Run("a directory in the way", func(t *testing.T) {
		home := t.TempDir()
		legacy := filepath.Join(home, "memory.md")
		if err := os.Mkdir(legacy, 0o700); err != nil {
			t.Fatal(err)
		}
		s := New(Options{Dir: filepath.Join(home, "memory"), Legacy: legacy, Log: slog.New(slog.DiscardHandler)})
		if _, err := s.Import(); err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Errorf("Import = %v", err)
		}
	})
}

func ptr(s string) *string { return &s }

func TestParse(t *testing.T) {
	for _, tt := range []struct {
		name, file      string
		want, malformed []string
	}{
		{"empty", "", nil, nil},
		{"entries", "- a\n- b\n", []string{"a", "b"}, nil},
		{"blank lines and spaces", "\n  - a  \n\n-   b\n", []string{"a", "b"}, nil},
		{"a line without a dash", "- a\nhand written\n", []string{"a", "hand written"}, nil},
		{"a lone dash is malformed", "-\n- a\n", []string{"a"}, []string{"-"}},
		{"star and plus bullets", "* a\n+ b\n*emphasis* kept\n", []string{"a", "b", "*emphasis* kept"}, nil},
		{"bullets and punctuation alone", "*\n +\n---\n- ***\n|---|\n- a\n", []string{"a"}, []string{"*", "+", "---", "- ***", "|---|"}},
		{"an emoji alone", "- 🚀\n- ship it 🚀\n", []string{"ship it 🚀"}, []string{"- 🚀"}},
		{"no trailing newline", "- a", []string{"a"}, nil},
		{"CRLF", "- a\r\n- b\r\n", []string{"a", "b"}, nil},
		{"headings", "# Preferences\n## Git\n- a\n#hashtag kept\n", []string{"a", "#hashtag kept"}, nil},
		{"comments", "<!-- one -->\n- a <!-- inline --> b\n<!--\n- hidden\n-->\n- c\n", []string{"a b", "c"}, nil},
		{"an open comment runs to the end", "- a\n<!-- - b\n- c\n", []string{"a"}, nil},
		{"normalised", "-   Always   open\tPRs as drafts.\n", []string{"Always open PRs as drafts"}, nil},
		{"repeats count once", "- Use tabs\n- use tabs.\n* b\n", []string{"Use tabs", "b"}, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, bad := Parse(tt.file)
			if !slices.Equal(got, tt.want) || !slices.Equal(bad, tt.malformed) {
				t.Errorf("Parse(%q) = %q, %q; want %q, %q", tt.file, got, bad, tt.want, tt.malformed)
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
		{"* a", "a"},
		{"+ a", "a"},
		{"*a*", "*a*"},
		{"*", ""},
		{"+", ""},
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
