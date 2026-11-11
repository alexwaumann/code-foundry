package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// shotPlugins is plugin.surface's backend (a live hello/main with one view) and
// PluginService.ShotSurface answering with res or err.
type shotPlugins struct {
	codefoundryv1connect.UnimplementedPluginServiceHandler
	res *v1.ShotSurfaceResponse
	err error
	got *v1.ShotSurfaceRequest
}

func (f *shotPlugins) GetSurface(context.Context, *connect.Request[v1.GetSurfaceRequest]) (*connect.Response[v1.GetSurfaceResponse], error) {
	return connect.NewResponse(&v1.GetSurfaceResponse{
		State: &v1.SurfaceState{Instance: "hello/main/global", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:  &v1.SurfaceView{Instance: "hello/main/global", Version: 4, ViewJson: `{"type":"text","text":"hi"}`},
	}), nil
}

func (f *shotPlugins) ShotSurface(_ context.Context, req *connect.Request[v1.ShotSurfaceRequest]) (*connect.Response[v1.ShotSurfaceResponse], error) {
	f.got = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.res), nil
}

// tinyPNG is a real 2 by 3 PNG.
func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPluginSurfaceShot(t *testing.T) {
	pngBytes := tinyPNG(t)
	tests := []struct {
		name       string
		args       []string
		res        *v1.ShotSurfaceResponse
		err        error
		wantErr    error
		wantFile   bool
		wantStdout []string
		wantStderr string
		// wantShot: ShotSurface was called, with this width and height (0: the daemon's default).
		wantShot     bool
		wantW, wantH int32
	}{
		{name: "writes the PNG after the view", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png"},
			res:      &v1.ShotSurfaceResponse{Png: pngBytes, Width: 420, Height: 900, ContentHeight: 600},
			wantFile: true, wantShot: true,
			wantStdout: []string{"view version 4:", `"text": "hi"`, "screenshot: /work/out.png (420 by 900 CSS px, 2 by 3 px)"}},
		{name: "a taller view says what to pass", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png", "--width", "600", "--height", "800"},
			res:      &v1.ShotSurfaceResponse{Png: pngBytes, Width: 600, Height: 800, ContentHeight: 1640},
			wantFile: true, wantShot: true, wantW: 600, wantH: 800,
			wantStdout: []string{"screenshot: /work/out.png (600 by 800 CSS px", "the view is 1640 px tall: pass --height 1640"}},
		{name: "taller than any viewport", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png", "--height", "4000"},
			res:      &v1.ShotSurfaceResponse{Png: pngBytes, Width: 420, Height: 4000, ContentHeight: 5200},
			wantFile: true, wantShot: true, wantH: 4000,
			wantStdout: []string{"the view is 5200 px tall; the shot shows the top 4000 px (--height is at most 4000)"}},
		{name: "no app open: the view, then the reason and exit 1", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png"},
			err:     connect.NewError(connect.CodeFailedPrecondition, errors.New("no screenshot: the app is not open (code-foundry gui)")),
			wantErr: errReported, wantShot: true,
			wantStdout: []string{"view version 4:"},
			wantStderr: "code-foundry plugin.surface: no screenshot: the app is not open (code-foundry gui)\n"},
		{name: "--json keeps stdout one value", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png", "--json"},
			res:      &v1.ShotSurfaceResponse{Png: pngBytes, Width: 420, Height: 900, ContentHeight: 900},
			wantFile: true, wantShot: true,
			wantStdout: []string{`"instance":"hello/main/global"`},
			wantStderr: "screenshot: /work/out.png (420 by 900 CSS px, 2 by 3 px)\n"},
		{name: "a size out of bounds fails before anything", args: []string{"plugin", "surface", "hello", "main", "--shot", "out.png", "--width", "100"},
			wantErr: errUsage, wantStderr: "--width 100 is out of bounds (280 to 1600)"},
		{name: "no --shot: no shot", args: []string{"plugin", "surface", "hello", "main"}, wantStdout: []string{"view version 4:"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			plugins := &shotPlugins{res: tt.res, err: tt.err}
			reg := command.NewRegistry()
			if err := command.RegisterPluginSurface(reg, plugins); err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			for _, r := range []api.Route{api.NewCommand(reg).Route()} {
				mux.Handle(r.Path, r.Handler)
			}
			path, h := codefoundryv1connect.NewPluginServiceHandler(plugins)
			mux.Handle(path, h)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			c := &client.Client{
				Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL),
				Plugin:  codefoundryv1connect.NewPluginServiceClient(srv.Client(), srv.URL),
			}
			var stdout, stderr bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: &stderr,
				connect: func(context.Context) (*client.Client, error) { return c, nil },
				getwd:   func() (string, error) { return "/work", nil }}
			// The path flag resolves against the working directory; write under dir instead.
			args := make([]string, len(tt.args))
			for i, a := range tt.args {
				if a == "out.png" {
					a = filepath.Join(dir, a)
				}
				args[i] = a
			}
			err := cl.dispatch(context.Background(), args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v\nstderr: %s", err, tt.wantErr, stderr.String())
			}
			out := strings.ReplaceAll(stdout.String(), dir, "/work")
			for _, want := range tt.wantStdout {
				if !strings.Contains(out, want) {
					t.Errorf("stdout lacks %q:\n%s", want, out)
				}
			}
			errOut := strings.ReplaceAll(stderr.String(), dir, "/work")
			if (tt.wantStderr == "" && errOut != "") || !strings.Contains(errOut, tt.wantStderr) {
				t.Errorf("stderr = %q, want %q", errOut, tt.wantStderr)
			}
			got, readErr := os.ReadFile(filepath.Join(dir, "out.png"))
			if tt.wantFile != (readErr == nil) || (tt.wantFile && !bytes.Equal(got, pngBytes)) {
				t.Errorf("file written = %v (%v), want %v", readErr == nil, readErr, tt.wantFile)
			}
			if tt.wantShot {
				r := plugins.got
				if r == nil || r.GetInstance() != "hello/main/global" || r.GetMinVersion() != 4 || r.GetRef().GetPlugin() != "hello" ||
					r.GetWidth() != tt.wantW || r.GetHeight() != tt.wantH {
					t.Errorf("ShotSurface asked %v, want %dx%d of hello/main/global v4", r, tt.wantW, tt.wantH)
				}
			} else if plugins.got != nil {
				t.Errorf("ShotSurface called: %v", plugins.got)
			}
		})
	}
}
