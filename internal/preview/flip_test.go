package preview

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/fsx/fsxtest"
)

// Anything on the machine can replace what a temp grant serves between the route's check and
// its read, and a page there can fetch its own grant. Each row flips a name while the route
// serves it: no response may hold the guarded file, and none may block.
func TestHandlerFlip(t *testing.T) {
	const secret = "the daemon's token"
	mine := func(file string) fsxtest.Maker { return fsxtest.Dir(file, "mine") }
	tests := []struct {
		name, flip string
		one        bool // a one-file grant of tmp/one.txt, not a tree grant of tmp/foo
		get        string
		makes      func(at func(string) string) []fsxtest.Maker
	}{
		{name: "a file and a link to the token", flip: "private/tmp/foo/x.txt", get: "x.txt", makes: func(at func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.Link(at("home/.code-foundry/x.txt"))}
		}},
		{name: "a folder in the tree and a link to the config home", flip: "private/tmp/foo/sub", get: "sub/x.txt", makes: func(at func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{mine("x.txt"), fsxtest.Link(at("home/.code-foundry"))}
		}},
		{name: "the tree and a link to the config home", flip: "private/tmp/foo", get: "x.txt", makes: func(at func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{mine("x.txt"), fsxtest.Link(at("home/.code-foundry"))}
		}},
		{name: "one file and a link to the token", flip: "private/tmp/one.txt", one: true, get: "one.txt", makes: func(at func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.Link(at("home/.code-foundry/x.txt"))}
		}},
		{name: "a file and a FIFO", flip: "private/tmp/foo/x.txt", get: "x.txt", makes: func(func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.FIFO()}
		}},
		{name: "a folder in the tree and a FIFO", flip: "private/tmp/foo/sub", get: "sub/x.txt", makes: func(func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{mine("x.txt"), fsxtest.FIFO()}
		}},
		{name: "the tree and a FIFO", flip: "private/tmp/foo", get: "x.txt", makes: func(func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{mine("x.txt"), fsxtest.FIFO()}
		}},
		{name: "one file and a FIFO", flip: "private/tmp/one.txt", one: true, get: "one.txt", makes: func(func(string) string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.FIFO()}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, at := tempFloor(t)
			write(t, at("private/tmp/foo/x.txt"), "mine")
			write(t, at("private/tmp/foo/sub/x.txt"), "mine")
			write(t, at("private/tmp/one.txt"), "mine")
			write(t, at("home/.code-foundry/x.txt"), secret)
			g := NewGrants(f)
			grant, err := g.Grant(at("tmp/foo"))
			if tt.one {
				grant, err = g.GrantFile(at("tmp/one.txt"))
			}
			if err != nil {
				t.Fatal(err)
			}
			h := Handler(g, nil, slog.New(slog.DiscardHandler))
			fsxtest.Flip(t, at(tt.flip), tt.makes(at)...)
			fsxtest.Hammer(t, func() {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Prefix+grant+"/"+tt.get, nil))
				if strings.Contains(rec.Body.String(), secret) {
					t.Errorf("served %q", rec.Body)
				}
			})
		})
	}
}
