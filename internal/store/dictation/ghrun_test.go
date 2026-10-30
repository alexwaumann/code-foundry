package dictation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeGhScript writes an executable gh that runs body (sh) and returns its path.
func fakeGhScript(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExecGh(t *testing.T) {
	for _, tc := range []struct {
		name    string
		script  string // "" means no gh at that path
		wantOut string
		check   func(error) bool
	}{
		{name: "prints its stdout", script: `printf 'HTTP/2.0 200 OK\r\n\r\nabc'`, wantOut: "HTTP/2.0 200 OK\r\n\r\nabc", check: func(err error) bool { return err == nil }},
		{name: "missing", check: func(err error) bool { return errors.Is(err, ErrGhNotFound) }},
		{name: "logged out", script: "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4", check: func(err error) bool {
			return errors.Is(ghReason(err), errGhLoggedOut)
		}},
		{name: "http error", script: "echo 'gh: Not Found (HTTP 404)' >&2; exit 1", check: func(err error) bool {
			var ge *GhError
			return errors.As(err, &ge) && ge.Code == 1 && err.Error() == "Not Found (HTTP 404)" && ghReason(err) == err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "nope")
			if tc.script != "" {
				path = fakeGhScript(t, tc.script)
			}
			var out strings.Builder
			err := ExecGh{Path: func() string { return path }}.Run(context.Background(), []string{"api"}, &out)
			if !tc.check(err) {
				t.Errorf("err %v", err)
			}
			if out.String() != tc.wantOut {
				t.Errorf("stdout %q", out.String())
			}
		})
	}
}

func TestExecGhCancelKillsIt(t *testing.T) {
	// The script's sleep is a child of the shell: cancelling kills the whole group.
	path := fakeGhScript(t, "sleep 30 & printf x; wait; printf y")
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- ExecGh{Path: func() string { return path }}.Run(ctx, nil, pw) }()
	buf := make([]byte, 1)
	if _, err := pr.Read(buf); err != nil || buf[0] != 'x' {
		t.Fatalf("read %q %v", buf, err)
	}
	start := time.Now()
	cancel()
	go func() { _, _ = io.Copy(io.Discard, pr) }()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err %v", err)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("took %s", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gh not killed")
	}
}

// ghFunc is a GhRunner from a function.
type ghFunc func(ctx context.Context, args []string, stdout io.Writer) error

func (f ghFunc) Run(ctx context.Context, args []string, stdout io.Writer) error {
	return f(ctx, args, stdout)
}

func TestFetchGitHubProgress(t *testing.T) {
	body := []byte(strings.Repeat("0123456789", 100_000)) // 1 MB: several reads
	m := Model{Name: "m.bin", Size: int64(len(body)), SHA256: sha256Hex(body),
		Sources: []Source{{GitHub: &ReleaseAsset{Repo: "o/r", Tag: "t", Asset: "m.bin"}}}}
	gh := ghFunc(func(_ context.Context, args []string, stdout io.Writer) error {
		if strings.HasSuffix(args[len(args)-1], "/tags/t") {
			_, err := io.WriteString(stdout, `{"assets":[{"id":5,"name":"m.bin","size":1000000,"state":"uploaded"}]}`)
			return err
		}
		if _, err := io.WriteString(stdout, "HTTP/2.0 200 OK\r\nContent-Length: 1000000\r\n\r\n"); err != nil {
			return err
		}
		for i := 0; i < len(body); i += 10_000 {
			if _, err := stdout.Write(body[i : i+10_000]); err != nil {
				return err
			}
		}
		return nil
	})
	// Each clock read moves 100 ms on: progress lands at most every 250 ms of it.
	now := time.Unix(0, 0)
	var got []Progress
	f := fetcher{gh: gh, log: slog.New(slog.DiscardHandler), now: func() time.Time { now = now.Add(100 * time.Millisecond); return now },
		progress: func(p Progress) { got = append(got, p) }}
	dest := filepath.Join(t.TempDir(), m.Name)
	src, err := f.fetch(context.Background(), m, dest)
	if err != nil || src != "GitHub" {
		t.Fatalf("fetch %q %v", src, err)
	}
	if len(got) < 3 {
		t.Fatalf("reports %+v", got)
	}
	for i := 1; i < len(got)-1; i++ {
		if got[i].Received <= got[i-1].Received || got[i].Total != m.Size {
			t.Errorf("report %d %+v after %+v", i, got[i], got[i-1])
		}
	}
	if last := got[len(got)-1]; last.Received != m.Size || last.BytesPerSecond == 0 {
		t.Errorf("last %+v", last)
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
