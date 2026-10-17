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

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
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

// TestProjectServiceEndToEnd runs the daemon and drives ProjectService over the
// token-protected loopback listener: Register -> List -> CreateWorktree -> dirty file
// observed on Watch -> RemoveWorktree -> Unregister, then a prompt shutdown with a
// Watch stream still open.
func TestProjectServiceEndToEnd(t *testing.T) {
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
	// Projects must be under the user's home; make the fixture's temp dir home.
	t.Setenv("HOME", base)
	origin, projectDir := filepath.Join(base, "origin.git"), filepath.Join(base, "proj")
	run(t, base, "init", "-q", "--bare", "-b", "main", origin)
	run(t, base, "init", "-q", "-b", "main", projectDir)
	if err := os.WriteFile(filepath.Join(projectDir, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, projectDir, "add", ".")
	run(t, projectDir, "commit", "-q", "-m", "init")
	run(t, projectDir, "remote", "add", "origin", origin)
	run(t, projectDir, "push", "-q", "-u", "origin", "main")

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
	c := codefoundryv1connect.NewProjectServiceClient(hc, ep.BaseURL)

	// The client's context is independent of the daemon's, so the shutdown check below
	// sees whether the daemon ends the stream itself.
	cctx, cancelClient := context.WithCancel(context.Background())
	defer cancelClient()
	stream, err := c.Watch(cctx, connect.NewRequest(&v1.WatchProjectsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan *v1.ProjectEvent, 256)
	go func() {
		defer close(events)
		for stream.Receive() {
			events <- stream.Msg()
		}
	}()
	waitFor := func(what string, pred func(*v1.ProjectEvent) bool) {
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
	waitFor("initial snapshot", func(ev *v1.ProjectEvent) bool { return ev.GetSnapshot() != nil })

	reg, err := c.Register(cctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: projectDir}))
	if err != nil {
		t.Fatal(err)
	}
	id := reg.Msg.GetProject().GetId()
	waitFor("project_updated", func(ev *v1.ProjectEvent) bool { return ev.GetProjectUpdated().GetId() == id })

	list, err := c.List(cctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil || len(list.Msg.GetProjects()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	main := list.Msg.GetProjects()[0].GetWorktrees()[0]
	if main.GetPath() != projectDir || main.GetBranch() != "main" || main.GetStatus().GetUpstream() != "origin/main" {
		t.Fatalf("main worktree = %v", main)
	}

	// The home boundary: outside $HOME is refused; inside, completion marks the project.
	if _, err := c.Register(cctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: home})); connect.CodeOf(err) != connect.CodeInvalidArgument ||
		!strings.Contains(err.Error(), "is outside your home directory") {
		t.Fatalf("Register outside home err = %v", err)
	}
	fsc := codefoundryv1connect.NewFilesystemServiceClient(hc, ep.BaseURL)
	ld, err := fsc.ListDirectories(cctx, connect.NewRequest(&v1.ListDirectoriesRequest{Prefix: "~/pr"}))
	if err != nil {
		t.Fatal(err)
	}
	if es := ld.Msg.GetEntries(); ld.Msg.GetCompletion() != "~/proj/" || len(es) != 1 || !es[0].GetIsGit() || !es[0].GetRegistered() {
		t.Fatalf("ListDirectories(~/pr) = %v", ld.Msg)
	}

	cw, err := c.CreateWorktree(cctx, connect.NewRequest(&v1.CreateWorktreeRequest{ProjectId: id, Branch: "e2e/one"}))
	if err != nil {
		t.Fatal(err)
	}
	wt := cw.Msg.GetWorktree().GetPath()
	realHome, _ := filepath.EvalSymlinks(home) // /tmp is a symlink; worktree paths are resolved
	if wt != filepath.Join(realHome, "worktrees", "_local", "proj", "e2e-one") {
		t.Fatalf("worktree path = %s", wt)
	}

	if err := os.WriteFile(filepath.Join(wt, "dirty.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor("worktree_updated dirty", func(ev *v1.ProjectEvent) bool {
		w := ev.GetWorktreeUpdated()
		return w.GetPath() == wt && w.GetStatus().GetUntracked() == 1 && w.GetStatus().GetDirty()
	})

	if _, err := c.RemoveWorktree(cctx, connect.NewRequest(&v1.RemoveWorktreeRequest{
		ProjectId: id, Path: wt, Force: true, DeleteBranch: true,
	})); err != nil {
		t.Fatal(err)
	}
	waitFor("worktree_removed", func(ev *v1.ProjectEvent) bool { return ev.GetWorktreeRemoved().GetPath() == wt })

	if _, err := c.Unregister(cctx, connect.NewRequest(&v1.UnregisterProjectRequest{Id: id})); err != nil {
		t.Fatal(err)
	}
	waitFor("project_removed", func(ev *v1.ProjectEvent) bool { return ev.GetProjectRemovedId() == id })

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
