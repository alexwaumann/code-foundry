package daemon_test

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/client"
	"github.com/awaumann/code-foundry/internal/daemon"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/version"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// bearer adds the loopback token, like the GUI frontend does.
type bearer struct {
	token string
	next  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.next.RoundTrip(r)
}

// TestRepoServiceEndToEnd runs the daemon and drives RepoService over the
// token-protected loopback listener: Register -> List -> CreateWorktree -> dirty file
// observed on Watch -> RemoveWorktree -> Unregister, then a prompt shutdown with a
// Watch stream still open.
func TestRepoServiceEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = T\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")

	// Socket paths must fit in 104 bytes, so the home lives under /tmp.
	home, err := os.MkdirTemp("/tmp", "cf-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	base, _ := filepath.EvalSymlinks(t.TempDir())
	origin, repoDir := filepath.Join(base, "origin.git"), filepath.Join(base, "proj")
	run(t, base, "init", "-q", "--bare", "-b", "main", origin)
	run(t, base, "init", "-q", "-b", "main", repoDir)
	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, repoDir, "add", ".")
	run(t, repoDir, "commit", "-q", "-m", "init")
	run(t, repoDir, "remote", "add", "origin", origin)
	run(t, repoDir, "push", "-q", "-u", "origin", "main")

	p := paths.New(home)
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}}) }()
	t.Cleanup(func() {
		stop()
		<-done
	})

	var ep client.Endpoint
	for i := 0; ; i++ {
		if ep, err = client.ReadEndpoint(p); err == nil {
			break
		}
		if i > 200 {
			t.Fatalf("daemon did not start: %v", err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	hc := &http.Client{Transport: bearer{token: ep.Token, next: &http.Transport{
		Protocols: &protocols, DialContext: (&net.Dialer{}).DialContext,
	}}}
	c := codefoundryv1connect.NewRepoServiceClient(hc, ep.BaseURL)

	// The client's context is independent of the daemon's, so the shutdown check below
	// sees whether the daemon ends the stream itself.
	cctx, cancelClient := context.WithCancel(context.Background())
	defer cancelClient()
	stream, err := c.Watch(cctx, connect.NewRequest(&v1.WatchReposRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan *v1.RepoEvent, 256)
	go func() {
		defer close(events)
		for stream.Receive() {
			events <- stream.Msg()
		}
	}()
	waitFor := func(what string, pred func(*v1.RepoEvent) bool) {
		t.Helper()
		timeout := time.After(10 * time.Second)
		for {
			select {
			case ev, ok := <-events:
				if !ok {
					t.Fatalf("watch ended waiting for %s: %v", what, stream.Err())
				}
				if pred(ev) {
					return
				}
			case <-timeout:
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}
	waitFor("initial snapshot", func(ev *v1.RepoEvent) bool { return ev.GetSnapshot() != nil })

	reg, err := c.Register(cctx, connect.NewRequest(&v1.RegisterRepoRequest{Path: repoDir}))
	if err != nil {
		t.Fatal(err)
	}
	id := reg.Msg.GetRepo().GetId()
	waitFor("repo_updated", func(ev *v1.RepoEvent) bool { return ev.GetRepoUpdated().GetId() == id })

	list, err := c.List(cctx, connect.NewRequest(&v1.ListReposRequest{}))
	if err != nil || len(list.Msg.GetRepos()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	main := list.Msg.GetRepos()[0].GetWorktrees()[0]
	if main.GetPath() != repoDir || main.GetBranch() != "main" || main.GetStatus().GetUpstream() != "origin/main" {
		t.Fatalf("main worktree = %v", main)
	}

	cw, err := c.CreateWorktree(cctx, connect.NewRequest(&v1.CreateWorktreeRequest{RepoId: id, Branch: "e2e/one"}))
	if err != nil {
		t.Fatal(err)
	}
	wt := cw.Msg.GetWorktree().GetPath()
	if wt != filepath.Join(base, "proj.worktrees", "e2e-one") {
		t.Fatalf("worktree path = %s", wt)
	}

	if err := os.WriteFile(filepath.Join(wt, "dirty.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor("worktree_updated dirty", func(ev *v1.RepoEvent) bool {
		w := ev.GetWorktreeUpdated()
		return w.GetPath() == wt && w.GetStatus().GetUntracked() == 1 && w.GetStatus().GetDirty()
	})

	if _, err := c.RemoveWorktree(cctx, connect.NewRequest(&v1.RemoveWorktreeRequest{
		RepoId: id, Path: wt, Force: true, DeleteBranch: true,
	})); err != nil {
		t.Fatal(err)
	}
	waitFor("worktree_removed", func(ev *v1.RepoEvent) bool { return ev.GetWorktreeRemoved().GetPath() == wt })

	if _, err := c.Unregister(cctx, connect.NewRequest(&v1.UnregisterRepoRequest{Id: id})); err != nil {
		t.Fatal(err)
	}
	waitFor("repo_removed", func(ev *v1.RepoEvent) bool { return ev.GetRepoRemovedId() == id })

	// Shutdown must not wait out the 5s graceful timeout for the open Watch stream.
	start := time.Now()
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon.Run = %v", err)
		}
		done <- nil // for the cleanup
	case <-time.After(4 * time.Second):
		t.Fatal("daemon did not shut down promptly with a Watch stream open")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("shutdown took %v", d)
	}
}
