package fsx

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// mediaHome is a home with media in it, a temp folder beside it, and the ways out of both.
func mediaHome(t *testing.T) (ReadRoots, func(string) string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at := func(p string) string { return filepath.Join(base, p) }
	for p, s := range map[string]string{
		"home/proj/clip.mp4": "video bytes", "home/proj/song.mp3": "audio", "home/proj/notes.txt": "text",
		"home/proj/Loud.WAV": "wav", "outside/clip.mp4": "secret video", "tmp/rec.webm": "webm",
	} {
		if err := os.MkdirAll(filepath.Dir(at(p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at(p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(at("home/proj/folder.mp4"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(at("home/proj/pipe.mp4"), 0o644); err != nil {
		t.Fatal(err)
	}
	for link, target := range map[string]string{
		"home/proj/out.mp4":    "outside/clip.mp4",
		"home/proj/inside.mov": "home/proj/clip.mp4",
		"home/proj/notes.mp4":  "home/proj/notes.txt",
		"home/proj/dead.mp4":   "home/proj/gone.mp4",
		"tmp/out.mp4":          "outside/clip.mp4",
		"outside/back-in.mp4":  "home/proj/clip.mp4",
	} {
		if err := os.Symlink(at(target), at(link)); err != nil {
			t.Fatal(err)
		}
	}
	return ReadRoots{Home: at("home"), Temp: []string{at("tmp")}}, at
}

func TestOpenMedia(t *testing.T) {
	roots, at := mediaHome(t)
	tests := []struct {
		name, baseDir, path string
		mime, body          string
		err                 error // nil: opens
	}{
		{name: "video", path: at("home/proj/clip.mp4"), mime: "video/mp4", body: "video bytes"},
		{name: "relative", baseDir: at("home/proj"), path: "song.mp3", mime: "audio/mpeg", body: "audio"},
		{name: "tilde", path: "~/proj/clip.mp4", mime: "video/mp4", body: "video bytes"},
		{name: "upper-case extension", path: at("home/proj/Loud.WAV"), mime: "audio/wav", body: "wav"},
		{name: "link inside home", path: at("home/proj/inside.mov"), mime: "video/quicktime", body: "video bytes"},
		{name: "link from outside into home", path: at("outside/back-in.mp4"), mime: "video/mp4", body: "video bytes"},
		{name: "temp folder", path: at("tmp/rec.webm"), mime: "video/webm", body: "webm"},
		{name: "outside the roots", path: at("outside/clip.mp4"), err: ErrInvalidArgument},
		{name: "traversal", baseDir: at("home/proj"), path: "../../outside/clip.mp4", err: ErrInvalidArgument},
		{name: "link leading out of home", path: at("home/proj/out.mp4"), err: ErrInvalidArgument},
		{name: "link leading out of temp", path: at("tmp/out.mp4"), err: ErrInvalidArgument},
		{name: "not media", path: at("home/proj/notes.txt"), err: ErrInvalidArgument},
		{name: "media name linking to a file that is not", path: at("home/proj/notes.mp4"), err: ErrInvalidArgument},
		{name: "directory", path: at("home/proj/folder.mp4"), err: ErrInvalidArgument},
		{name: "fifo", path: at("home/proj/pipe.mp4"), err: ErrInvalidArgument},
		{name: "missing", path: at("home/proj/nope.mp4"), err: fs.ErrNotExist},
		{name: "dead link", path: at("home/proj/dead.mp4"), err: fs.ErrNotExist},
		{name: "relative without base", path: "clip.mp4", err: ErrInvalidArgument},
		{name: "empty", err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, c, err := OpenMedia(roots, tt.baseDir, tt.path)
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err = %v, want %v", err, tt.err)
				}
				if f != nil {
					t.Error("a refusal returned a file")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = f.Close() }()
			b, err := io.ReadAll(f)
			if err != nil {
				t.Fatal(err)
			}
			if c.MIMEType != tt.mime || !c.Media || string(b) != tt.body || c.Size != int64(len(tt.body)) {
				t.Errorf("mime %q media %t size %d body %q", c.MIMEType, c.Media, c.Size, b)
			}
		})
	}
}

// ReadFile reads no byte of a video or audio file: the GUI streams it.
func TestReadFileMedia(t *testing.T) {
	roots, at := mediaHome(t)
	for _, read := range []func(ReadRoots, string, string, int64) (FileContents, error){ReadFile, ReadTail} {
		got, err := read(roots, "", at("home/proj/clip.mp4"), MaxBinaryReadBytes)
		if err != nil {
			t.Fatal(err)
		}
		if !got.Media || !got.Binary || got.MIMEType != "video/mp4" || got.Size != 11 || len(got.Contents) != 0 || got.Truncated || got.ModifiedAt.IsZero() {
			t.Errorf("got %+v", got)
		}
	}
	// The read's own refusals still come first.
	if _, err := ReadFile(roots, "", at("home/proj/out.mp4"), 0); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a link out: err = %v", err)
	}
	if got, err := ReadFile(roots, "", at("home/proj/folder.mp4"), 0); err != nil || !got.IsDir || got.Media {
		t.Errorf("a folder: %+v, %v", got, err)
	}
}
