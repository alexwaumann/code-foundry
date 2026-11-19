package settings

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The one-time step of a default change (defaultchange.go), on layout.threads_open_as: a
// new home takes Panes with no write; a home from before keeps Tabs, written into its file
// once, with a notice owed; a file that sets the key is left alone. Each start opens the
// store anew on the file and marker as the previous start left them.
func TestKeepOldDefaults(t *testing.T) {
	const id = ThreadsOpenAsPanesDefault
	type start struct {
		existing bool
		// readOnly makes the settings file's directory read-only for this start, so a
		// save fails (the marker beside it too).
		readOnly bool
		// noticed posts the owed notices after the start (MarkNoticed), as the daemon does.
		noticed bool
		want    string   // layout.threads_open_as after the start
		inFile  string   // what the file sets the key to after it; "" for unset
		marker  []string // the marker file's lines after it
		due     []string // DueNotices after it, before noticed
	}
	tests := []struct {
		name   string
		file   string // the settings file before the first start; "-" for none
		marker string // the marker file before it
		starts []start
	}{
		{name: "a new home: Panes, no write", file: "-", starts: []start{
			{want: ThreadsOpenAsPanes, marker: []string{id}},
			// The second start finds the database the first one made: decided already.
			{existing: true, want: ThreadsOpenAsPanes, marker: []string{id}},
		}},
		{name: "an existing home, key unset: Tabs written once, the notice owed once", file: "[appearance]\nfont_size = 15\n", starts: []start{
			{existing: true, noticed: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice", id + ".noticed"}, due: []string{id}},
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice", id + ".noticed"}},
		}},
		{name: "an existing home with an empty file", file: "", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice"}, due: []string{id}},
		}},
		{name: "the key set to tabs", file: "[layout]\nthreads_open_as = \"tabs\"\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id}},
		}},
		{name: "the key set to panes", file: "[layout]\nthreads_open_as = \"panes\"\n", starts: []start{
			{existing: true, want: ThreadsOpenAsPanes, inFile: ThreadsOpenAsPanes, marker: []string{id}},
		}},
		{name: "the key set to single", file: "[layout]\nthreads_open_as = \"single\"\n", starts: []start{
			{existing: true, want: ThreadsOpenAsSingle, inFile: ThreadsOpenAsSingle, marker: []string{id}},
		}},
		{name: "the key set to a value this build refuses: the user's, left alone", file: "[layout]\nthreads_open_as = \"grid\"\n", starts: []start{
			{existing: true, want: ThreadsOpenAsPanes, inFile: "grid", marker: []string{id}},
		}},
		{name: "the write fails: Tabs held for the run, tried again at the next start", file: "[appearance]\nfont_size = 15\n", starts: []start{
			{existing: true, readOnly: true, want: ThreadsOpenAsTabs},
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice"}, due: []string{id}},
		}},
		{name: "a file that does not parse: Tabs held, nothing recorded", file: "[layout\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs},
		}},
		{name: "killed after the write, before the marker: decided, the notice still owed", file: "[layout]\nthreads_open_as = \"tabs\"\n", marker: id + ".notice\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice"}, due: []string{id}},
		}},
		{name: "killed before the write: written now", file: "", marker: id + ".notice\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice"}, due: []string{id}},
		}},
		{name: "owed, then changed to panes by hand: no notice", file: "[layout]\nthreads_open_as = \"panes\"\n", marker: id + "\n" + id + ".notice\n", starts: []start{
			{existing: true, want: ThreadsOpenAsPanes, inFile: ThreadsOpenAsPanes, marker: []string{id, id + ".notice"}},
		}},
		{name: "noticed already: never again", file: "[layout]\nthreads_open_as = \"tabs\"\n", marker: id + "\n" + id + ".notice\n" + id + ".noticed\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice", id + ".noticed"}},
		}},
		{name: "decided already, key unset: Panes, no write", file: "", marker: id + "\n", starts: []start{
			{existing: true, want: ThreadsOpenAsPanes, marker: []string{id}},
		}},
		{name: "the other marker lines are kept", file: "", marker: "some.later-step\n", starts: []start{
			{existing: true, want: ThreadsOpenAsTabs, inFile: ThreadsOpenAsTabs, marker: []string{id, id + ".notice", "some.later-step"}, due: []string{id}},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, FileName)
			if tt.file != "-" {
				if err := os.WriteFile(path, []byte(tt.file), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if tt.marker != "" {
				if err := os.WriteFile(path+ClearedSuffix, []byte(tt.marker), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for i, st := range tt.starts {
				if st.readOnly {
					if err := os.Chmod(dir, 0o500); err != nil {
						t.Fatal(err)
					}
				}
				s, err := Open(context.Background(), Options{Path: path, Log: slog.New(slog.DiscardHandler)})
				if err != nil {
					t.Fatal(err)
				}
				s.KeepOldDefaults(context.Background(), st.existing)
				if got := s.Settings().Layout.ThreadsOpenAs; got != st.want {
					t.Errorf("start %d: threads_open_as = %q, want %q", i, got, st.want)
				}
				if got := s.Snapshot().Values[KeyThreadsOpenAs]; got != st.want {
					t.Errorf("start %d: Values = %q, want %q", i, got, st.want)
				}
				if got := s.DueNotices(); !slices.Equal(got, st.due) {
					t.Errorf("start %d: DueNotices = %q, want %q", i, got, st.due)
				}
				if st.noticed {
					for _, id := range s.DueNotices() {
						s.MarkNoticed(id)
					}
				}
				_ = s.Close()
				if st.readOnly {
					if err := os.Chmod(dir, 0o700); err != nil {
						t.Fatal(err)
					}
				}
				if got := fileValue(t, path, KeyThreadsOpenAs); got != st.inFile {
					t.Errorf("start %d: the file sets %q, want %q", i, got, st.inFile)
				}
				if got := markerLines(path); !slices.Equal(got, st.marker) {
					t.Errorf("start %d: marker %q, want %q", i, got, st.marker)
				}
			}
		})
	}
}

// The write keeps the rest of the file as a save from the app does: the user's values and
// unknown keys are written back.
func TestKeepOldDefaultsKeepsTheRestOfTheFile(t *testing.T) {
	in := "[appearance]\nfont_size = 15\n\n[layout]\nsmart_swap = false\n\n[mystery]\nanswer = 42\n"
	s, _, path := openTest(t, in)
	s.KeepOldDefaults(context.Background(), true)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	for _, l := range []string{"\nfont_size = 15\n", "\nsmart_swap = false\n", "\nthreads_open_as = \"tabs\"\n", "\n[mystery]\n", "\nanswer = 42\n"} {
		if !strings.Contains(out, l) {
			t.Errorf("the write lost %q:\n%s", l, out)
		}
	}
}

// A held old default stays through a reload of a file that does not set the key, gives way
// to one that does, and is never written by a save of another setting.
func TestHeldOldDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	if err := os.WriteFile(path, []byte("[layout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(context.Background(), Options{Path: path, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	s.KeepOldDefaults(context.Background(), true)
	if got := s.Settings().Layout.ThreadsOpenAs; got != ThreadsOpenAsTabs {
		t.Fatalf("held = %q, want tabs", got)
	}
	// The user fixes the file: still Tabs, from the held value, not the new default.
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 15\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.reload()
	if got := s.Settings().Layout.ThreadsOpenAs; got != ThreadsOpenAsTabs {
		t.Errorf("after a reload = %q, want tabs", got)
	}
	// A save of another setting does not write the held value.
	if _, err := s.Update(context.Background(), map[string]string{KeyFontSize: "16"}); err != nil {
		t.Fatal(err)
	}
	if got := fileValue(t, path, KeyThreadsOpenAs); got != "" {
		t.Errorf("the save wrote threads_open_as = %q", got)
	}
	if got := s.Settings().Layout.ThreadsOpenAs; got != ThreadsOpenAsTabs {
		t.Errorf("after a save = %q, want tabs", got)
	}
	// The user's own choice wins over it.
	if _, err := s.Update(context.Background(), map[string]string{KeyThreadsOpenAs: ThreadsOpenAsSingle}); err != nil {
		t.Fatal(err)
	}
	if got := s.Settings().Layout.ThreadsOpenAs; got != ThreadsOpenAsSingle {
		t.Errorf("after the user's choice = %q, want single", got)
	}
}

// fileValue is what the settings file at path sets key to, as written; "" when it does not.
func fileValue(t *testing.T, path, key string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := decode(data)
	if err != nil {
		return ""
	}
	return raw[key]
}

// markerLines are the marker file's ids, sorted, without the once clears' (once.go: a
// load of a file without their value records them); nil when there is none.
func markerLines(path string) []string {
	data, err := os.ReadFile(path + ClearedSuffix)
	if err != nil {
		return nil
	}
	var lines []string
	for _, l := range strings.Fields(string(data)) {
		if !slices.ContainsFunc(onceClears, func(c onceClear) bool { return c.id == l }) {
			lines = append(lines, l)
		}
	}
	slices.Sort(lines)
	return lines
}
