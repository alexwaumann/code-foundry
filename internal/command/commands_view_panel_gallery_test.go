package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func galleryFiles() *commandtest.Files {
	return &commandtest.Files{
		Files:    []string{"/wt/a.png", "/tmp/b.jpg", "/wt/notes.txt", "/wt/huge.png", "/wt/big.svg", "/wt/small.svg"},
		Dirs:     []string{"/wt/shots"},
		Mime:     map[string]string{"/wt/a.png": "image/png", "/tmp/b.jpg": "image/jpeg", "/wt/notes.txt": "text/plain", "/wt/huge.png": "image/png", "/wt/big.svg": "image/svg+xml", "/wt/small.svg": "image/svg+xml"},
		Modified: map[string]int64{"/wt/a.png": 11, "/tmp/b.jpg": 22, "/wt/small.svg": 33},
		Size:     map[string]int64{"/wt/huge.png": 33 << 20, "/wt/big.svg": 2 << 20, "/wt/small.svg": 1 << 20},
		Errs:     map[string]error{"/etc/c.png": connect.NewError(connect.CodeInvalidArgument, errors.New("invalid argument: /etc/c.png is outside the home directory"))},
	}
}

// view.panel.gallery: a ShowView with the images as the tab takes them, a warning for each one
// that will not show, and nothing sent when none can or the arguments are wrong.
func TestPanelGallery(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	args := func(images string) map[string]string { return map[string]string{"title": "Shots", "images": images} }
	tests := []struct {
		name         string
		ctx          command.Context
		args         map[string]string
		noWindow     bool
		wantTitle    string
		wantImages   string
		wantMsg      string
		wantWarnings []string
		argErr       string
		says         string
	}{
		{name: "captions stay with their images, in order", args: args(`[{"path":"/tmp/b.jpg","caption":"Before"},{"path":"/wt/a.png"}]`),
			wantTitle: "Shots", wantImages: `[{"path":"/tmp/b.jpg","caption":"Before","stamp":22},{"path":"/wt/a.png","stamp":11}]`, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a relative path reads against the checkout", args: args(`[{"path":"a.png"}]`),
			wantTitle: "Shots", wantImages: `[{"path":"/wt/a.png","stamp":11}]`, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a caption and a title are model text", args: map[string]string{"title": "  Sh\u202eots\n", "images": `[{"path":"/wt/a.png","caption":" two\nlines\u202e "}]`},
			wantTitle: "Shots", wantImages: `[{"path":"/wt/a.png","caption":"two lines","stamp":11}]`, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "in the app, no message", ctx: command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveView: "thread"}, args: args(`[{"path":"/wt/a.png"}]`),
			wantTitle: "Shots", wantImages: `[{"path":"/wt/a.png","stamp":11}]`},
		{name: "no window open", args: args(`[{"path":"/wt/a.png"}]`), noWindow: true,
			wantTitle: "Shots", wantImages: `[{"path":"/wt/a.png","stamp":11}]`, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; no app window is open"},
		{name: "what will not show warns and keeps its place",
			args:      args(`[{"path":"/wt/gone.png","caption":"Gone"},{"path":"/wt/a.png"},{"path":"/wt/shots"},{"path":"/wt/notes.txt"},{"path":"/wt/huge.png"},{"path":"/etc/c.png"}]`),
			wantTitle: "Shots", wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1",
			wantImages: `[{"path":"/wt/gone.png","caption":"Gone"},{"path":"/wt/a.png","stamp":11},{"path":"/wt/shots"},{"path":"/wt/notes.txt"},{"path":"/wt/huge.png"},{"path":"/etc/c.png"}]`,
			wantWarnings: []string{"/wt/gone.png: no such file", "/wt/shots: a directory, not an image", "/wt/notes.txt: not an image (text/plain)",
				"/wt/huge.png: larger than the 32 MiB the tab reads", "/etc/c.png: /etc/c.png is outside the home directory"}},
		{name: "none can show", args: args(`[{"path":"/wt/gone.png"},{"path":"/wt/shots"}]`), argErr: "images", says: "none of the 2 images can be shown: /wt/gone.png: no such file"},
		{name: "an SVG reads as text, so its limit is 1 MiB", args: args(`[{"path":"/wt/big.svg"}]`), argErr: "images", says: "none of the 1 images can be shown: /wt/big.svg: larger than the 1 MiB the tab reads"},
		{name: "an SVG at that limit shows", args: args(`[{"path":"/wt/small.svg"}]`),
			wantTitle: "Shots", wantImages: `[{"path":"/wt/small.svg","stamp":33}]`, wantMsg: "thread s-aaaaaaaaaaa1's tab is not open, so tab t-n1 opened in pane p-n1, the focused pane of its space; windows=1"},
		{name: "a path too long", args: args(`[{"path":"/wt/` + strings.Repeat("x", 1021) + `"}]`), argErr: "images", says: "image 1's path has 1025 bytes, at most 1024"},
		{name: "a blank title", args: map[string]string{"title": " \n ", "images": `[{"path":"/wt/a.png"}]`}, argErr: "title", says: "needs a title"},
		{name: "a title too long", args: map[string]string{"title": strings.Repeat("x", 81), "images": `[{"path":"/wt/a.png"}]`}, argErr: "title", says: "at most 80"},
		{name: "not json", args: args(`/wt/a.png`), argErr: "images", says: "want a JSON array"},
		{name: "not an array", args: args(`{"path":"/wt/a.png"}`), argErr: "images", says: "want a JSON array"},
		{name: "more after the array", args: args(`[{"path":"/wt/a.png"}] []`), argErr: "images", says: "more after the array"},
		{name: "empty", args: args(`[]`), argErr: "images", says: "it is empty"},
		{name: "a misnamed field", args: args(`[{"file":"/wt/a.png"}]`), argErr: "images", says: "unknown field"},
		{name: "no path", args: args(`[{"path":"/wt/a.png"},{"caption":"x"}]`), argErr: "images", says: "image 2 has no path"},
		{name: "a caption too long", args: args(`[{"path":"/wt/a.png","caption":"` + strings.Repeat("x", 201) + `"}]`), argErr: "images", says: "at most 200"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			windows := 1
			if tt.noWindow {
				windows = 0
			}
			ctx := tt.ctx
			if ctx == (command.Context{}) {
				ctx = inThread
			}
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: windows, files: galleryFiles()})
			res, err := reg.Invoke(context.Background(), ctx, "view.panel.gallery", tt.args)
			if checkItemErr(t, err, 0, tt.argErr) {
				if !strings.Contains(err.Error(), tt.says) {
					t.Errorf("error = %q, want it to say %q", err, tt.says)
				}
				openedNothing(t, reg, emit)
				return
			}
			want := map[string]string{"title": tt.wantTitle, "images": tt.wantImages, "project": "r1", "base": "/wt"}
			openedTab(t, reg, emit, res, "s-aaaaaaaaaaa1", want)
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if !slices.Equal(res.Warnings, tt.wantWarnings) {
				t.Errorf("warnings = %q, want %q", res.Warnings, tt.wantWarnings)
			}
		})
	}
}

// The cap is the most images a gallery takes, and past the first few a warning counts the rest.
func TestPanelGalleryLimits(t *testing.T) {
	list := func(n int) string {
		images := make([]map[string]string, n)
		for i := range images {
			images[i] = map[string]string{"path": fmt.Sprintf("/wt/gone-%d.png", i)}
		}
		images[0]["path"] = "/wt/a.png"
		b, err := json.Marshal(images)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: galleryFiles()})
	res, err := reg.Invoke(context.Background(), inThread, "view.panel.gallery", map[string]string{"title": "Many", "images": list(200)})
	if err != nil {
		t.Fatal(err)
	}
	if tb := opened(t, reg, res); tb.Kind != "gallery" || len(emit.Intents()) != 0 {
		t.Fatalf("tab = %+v, intents = %v: want the gallery's tab and no intent", tb, emit.Intents())
	}
	if n := len(res.Warnings); n != 6 || res.Warnings[5] != "and 194 more images that cannot be shown" {
		t.Errorf("warnings = %q", res.Warnings)
	}
	_, err = reg.Invoke(context.Background(), inThread, "view.panel.gallery", map[string]string{"title": "Many", "images": list(201)})
	if err == nil || !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), "201 images, at most 200") {
		t.Errorf("err = %v", err)
	}
}

// view.panel.gallery needs a thread: the CLI outside one cannot run it.
func TestPanelGalleryNeedsAThread(t *testing.T) {
	reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: galleryFiles()})
	_, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.gallery", map[string]string{"title": "x", "images": `[{"path":"/wt/a.png"}]`})
	if err == nil {
		t.Fatal("ran without a thread")
	}
}
