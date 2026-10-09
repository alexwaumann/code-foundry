package session

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

var (
	pngData  = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	jpegData = append([]byte("\xff\xd8\xff\xe0"), make([]byte, 32)...)
	gifData  = append([]byte("GIF89a"), make([]byte, 32)...)
	webpData = append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), make([]byte, 32)...)
)

func TestAttachmentType(t *testing.T) {
	tests := []struct {
		name    string
		mime    string
		data    []byte
		wantExt string
	}{
		{"png", "image/png", pngData, ".png"},
		{"jpeg", "image/jpeg", jpegData, ".jpg"},
		{"gif", "image/gif", gifData, ".gif"},
		{"webp", "image/webp", webpData, ".webp"},
		{"mime parameters and case", "Image/PNG; charset=binary", pngData, ".png"},
		{"extension follows content", "image/png", jpegData, ".jpg"},
		{"svg refused", "image/svg+xml", []byte("<svg/>"), ""},
		{"text refused", "text/plain", []byte("hello"), ""},
		{"bad mime", "image/", pngData, ""},
		{"empty mime", "", pngData, ""},
		{"empty data", "image/png", nil, ""},
		{"content not an image", "image/png", []byte("#!/bin/sh\necho hi\n"), ""},
		{"too large", "image/png", append(bytes.Clone(pngData), make([]byte, MaxAttachmentBytes)...), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ext, err := attachmentType(tt.mime, tt.data)
			if tt.wantExt == "" {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want invalid argument", err)
				}
				return
			}
			if err != nil || ext != tt.wantExt {
				t.Fatalf("attachmentType = %q, %v; want %q", ext, err, tt.wantExt)
			}
		})
	}
}

func TestStageAttachment(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "attachments")
	e := newEnv(t, func(o *Options) { o.AttachmentsDir = dir })
	p, err := e.m.StageAttachment(e.ctx(), "../../etc/passwd.png", "image/png", pngData)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(p) != dir || !regexp.MustCompile(`^[0-9a-f]{32}\.png$`).MatchString(filepath.Base(p)) {
		t.Fatalf("path = %q", p)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o600 || fi.Size() != int64(len(pngData)) {
		t.Fatalf("staged file = %v, %v", fi, err)
	}
	if di, err := os.Stat(dir); err != nil || di.Mode().Perm() != 0o700 {
		t.Fatalf("dir = %v, %v", di, err)
	}
	p2, err := e.m.StageAttachment(e.ctx(), "a.png", "image/png", pngData)
	if err != nil || p2 == p {
		t.Fatalf("second stage = %q, %v", p2, err)
	}
	if _, err := e.m.StageAttachment(e.ctx(), "a.txt", "text/plain", []byte("x")); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("text staged: %v", err)
	}

	// Create appends the staged paths to the prompt.
	s := e.create(CreateOptions{InitialPrompt: "look", Attachments: []string{p, dir + "/./" + filepath.Base(p2)}})
	spec, _ := e.terms.Spec(s.TerminalID)
	want := "look\n\nAttached image: " + p + "\nAttached image: " + p2
	if got := spec.Argv[len(spec.Argv)-1]; got != want {
		t.Errorf("prompt = %q, want %q", got, want)
	}
	// Claude may read the staged files without a permission prompt, in every spawn.
	if argOf(spec.Argv, "--add-dir") != dir {
		t.Errorf("argv = %q, want --add-dir %s", spec.Argv, dir)
	}
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	spec, _ = e.terms.Spec(r.TerminalID)
	if argOf(spec.Argv, "--add-dir") != dir || slices.Contains(spec.Argv, "--") {
		t.Errorf("reconnect argv = %q", spec.Argv)
	}

	off := newEnv(t)
	plain := off.create(CreateOptions{})
	if spec, _ := off.terms.Spec(plain.TerminalID); slices.Contains(spec.Argv, "--add-dir") {
		t.Errorf("argv without an attachments dir = %q", spec.Argv)
	}
	if _, err := off.m.StageAttachment(off.ctx(), "a.png", "image/png", pngData); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("staging without a dir: %v", err)
	}
}

func TestCheckAttachments(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "attachments")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	ok := filepath.Join(dir, "a.png")
	outside := filepath.Join(root, "b.png")
	for _, p := range []string{ok, outside, filepath.Join(dir, "sub", "c.png")} {
		if err := os.WriteFile(p, pngData, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(dir, "link.png")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		dir   string
		paths []string
		ok    bool
	}{
		{"none", "", nil, true},
		{"staged", dir, []string{ok}, true},
		{"staged, uncleaned", dir, []string{dir + "/sub/../a.png"}, true},
		{"outside", dir, []string{outside}, false},
		{"escapes with dot-dot", dir, []string{dir + "/../b.png"}, false},
		{"nested", dir, []string{filepath.Join(dir, "sub", "c.png")}, false},
		{"relative", dir, []string{"attachments/a.png"}, false},
		{"missing", dir, []string{filepath.Join(dir, "gone.png")}, false},
		{"directory", dir, []string{filepath.Join(dir, "sub")}, false},
		{"symlink", dir, []string{link}, false},
		{"disabled", "", []string{ok}, false},
		{"one bad of two", dir, []string{ok, outside}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := checkAttachments(tt.dir, tt.paths)
			if tt.ok {
				if err != nil || len(got) != len(tt.paths) {
					t.Fatalf("checkAttachments = %q, %v", got, err)
				}
				for _, p := range got {
					if p != ok {
						t.Errorf("cleaned path %q", p)
					}
				}
				return
			}
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("err = %v, want invalid argument", err)
			}
		})
	}
}

func TestCreateRejectsForeignAttachments(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "attachments")
	e := newEnv(t, func(o *Options) { o.AttachmentsDir = dir })
	secret := filepath.Join(t.TempDir(), "id_rsa")
	_ = os.WriteFile(secret, []byte("x"), 0o600)
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorktreePath: e.wt, InitialPrompt: "x", Attachments: []string{secret}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("err = %v", err)
	}
	if n := len(e.m.Snapshot().Sessions); n != 0 {
		t.Errorf("%d sessions", n)
	}
}

func TestReapAttachmentsOnStart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	files := map[string]time.Duration{"old.png": 25 * time.Hour, "fresh.png": 23 * time.Hour, ".hidden": 48 * time.Hour}
	for name, age := range files {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, pngData, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "olddir"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(filepath.Join(dir, "olddir"), now.Add(-72*time.Hour), now.Add(-72*time.Hour))
	newEnv(t, func(o *Options) {
		o.AttachmentsDir = dir
		o.Now = func() time.Time { return now }
	})
	var left []string
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		left = append(left, e.Name())
	}
	if got := strings.Join(left, ","); got != ".hidden,fresh.png,olddir" {
		t.Errorf("left = %s", got)
	}
	// A missing directory is not an error.
	if n, err := reapAttachments(filepath.Join(dir, "nope"), now); n != 0 || err != nil {
		t.Errorf("reap missing = %d, %v", n, err)
	}
}
