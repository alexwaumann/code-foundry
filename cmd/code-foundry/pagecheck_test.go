package main

import (
	"bytes"
	"context"
	"errors"
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

// pageChecker is PageService.CheckPage answering res, with the PNG when one is asked.
type pageChecker struct {
	res *v1.CheckPageResponse
	png []byte
}

func (f *pageChecker) CheckPage(_ context.Context, req *connect.Request[v1.CheckPageRequest]) (*connect.Response[v1.CheckPageResponse], error) {
	out := &v1.CheckPageResponse{Path: f.res.GetPath(), Width: f.res.GetWidth(), Report: f.res.GetReport()}
	if req.Msg.GetPng() {
		out.Png = f.png
	}
	return connect.NewResponse(out), nil
}

// page.check --shot writes the PNG the check's one render answered with and prints the
// report without its bytes; a problem exits 1 after the report.
func TestPageCheckShot(t *testing.T) {
	pngBytes := tinyPNG(t)
	clean := &v1.CheckPageResponse{Path: "/work/p.html", Width: 720, Report: &v1.PageCheckReport{Loaded: true, Settled: true, Height: 3}}
	broken := &v1.CheckPageResponse{Path: "/work/p.html", Width: 720, Report: &v1.PageCheckReport{Loaded: true, Settled: true, Height: 3,
		Problems: []*v1.PageCheckProblem{{Kind: "script", Message: "x is not defined", Where: "p.html:3:1", Count: 1}}}}
	tests := []struct {
		name       string
		args       []string
		res        *v1.CheckPageResponse
		wantErr    bool
		wantFile   bool
		wantStdout []string
		notStdout  string
	}{
		{name: "writes the PNG", args: []string{"page", "check", "/work/p.html", "--shot", "out.png"}, res: clean, wantFile: true,
			wantStdout: []string{"loaded, no errors", "screenshot: /work/out.png (720 by 3 CSS px)"}},
		{name: "--json has the report, not the bytes", args: []string{"page", "check", "/work/p.html", "--shot", "out.png", "--json"}, res: clean, wantFile: true,
			wantStdout: []string{`"loaded":true`}, notStdout: `"png"`},
		{name: "a problem: the report, the file, exit 1", args: []string{"page", "check", "/work/p.html", "--shot", "out.png"}, res: broken, wantFile: true, wantErr: true,
			wantStdout: []string{"1 problem", "- error at p.html:3:1: x is not defined"}},
		{name: "no --shot: no file", args: []string{"page", "check", "/work/p.html"}, res: clean, wantStdout: []string{"loaded, no errors"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			reg := command.NewRegistry()
			if err := command.RegisterPageCheck(reg, &pageChecker{res: tt.res, png: pngBytes}); err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			r := api.NewCommand(reg).Route()
			mux.Handle(r.Path, r.Handler)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
			var stdout, stderr bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: &stderr,
				connect: func(context.Context) (*client.Client, error) { return c, nil },
				getwd:   func() (string, error) { return "/work", nil }}
			args := make([]string, len(tt.args))
			for i, a := range tt.args {
				if a == "out.png" {
					a = filepath.Join(dir, a)
				}
				args[i] = a
			}
			err := cl.dispatch(context.Background(), args)
			if (err != nil) != tt.wantErr || tt.wantErr && !errors.Is(err, exitCodeError(1)) {
				t.Fatalf("err = %v, want exit 1: %v\nstderr: %s", err, tt.wantErr, stderr.String())
			}
			out := strings.ReplaceAll(stdout.String(), dir, "/work")
			for _, want := range tt.wantStdout {
				if !strings.Contains(out, want) {
					t.Errorf("stdout lacks %q:\n%s", want, out)
				}
			}
			if tt.notStdout != "" && strings.Contains(out, tt.notStdout) {
				t.Errorf("stdout has %q:\n%s", tt.notStdout, out)
			}
			got, readErr := os.ReadFile(filepath.Join(dir, "out.png"))
			if tt.wantFile != (readErr == nil) || (tt.wantFile && !bytes.Equal(got, pngBytes)) {
				t.Errorf("file written = %v (%v), want %v", readErr == nil, readErr, tt.wantFile)
			}
		})
	}
}
