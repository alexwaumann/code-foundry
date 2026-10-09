package update_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/update/updatetest"
)

type rig struct {
	store     *update.Store
	source    *updatetest.Source
	installer *updatetest.Installer
	disk      *updatetest.OnDisk
	events    *bus.Subscription[update.Event]
	relaunch  *bus.Subscription[update.RelaunchRequested]
}

// newRig starts a store at v0.1.0 whose source reports latest. The periodic check is
// pushed out of the way unless opts says otherwise.
func newRig(t *testing.T, latest string, edit func(*update.Options)) *rig {
	t.Helper()
	b := bus.New()
	r := &rig{
		source: updatetest.NewSource(latest),
		disk:   updatetest.NewOnDisk("v0.1.0"),
		events: bus.Subscribe[update.Event](b, 256),
	}
	r.relaunch = bus.Subscribe[update.RelaunchRequested](b, 8)
	r.installer = updatetest.NewInstaller(r.disk)
	opts := update.Options{
		Current:          "v0.1.0",
		Repo:             "owner/name",
		Source:           r.source,
		Installer:        r.installer,
		InstalledVersion: r.disk.Version,
		Bus:              b,
		InitialDelay:     time.Hour,
	}
	if edit != nil {
		edit(&opts)
	}
	r.store = update.Start(context.Background(), opts)
	t.Cleanup(r.store.Close)
	return r
}

// waitState waits for a published status in state want.
func (r *rig) waitState(t *testing.T, want update.State) update.Status {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-r.events.C():
			if ev.Status.State == want && !ev.Status.Checking {
				return ev.Status
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %v; now %+v", want, r.store.Snapshot())
		}
	}
}

func TestCheckInstallRelaunch(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	ctx := context.Background()

	if st := r.store.Snapshot(); st.State != update.Idle || !st.Enabled || st.Current != "v0.1.0" {
		t.Fatalf("initial %+v", st)
	}
	st, err := r.store.Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Available || st.Target != "v0.2.0" || st.Latest != "v0.2.0" || st.NotesURL == "" || st.LastCheckedAt.IsZero() {
		t.Fatalf("after check %+v", st)
	}

	r.installer.Hold = true
	r.installer.Progress = []string{"==> downloading", "==> verifying checksum"}
	st, err = r.store.Install(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Downloading {
		t.Fatalf("Install returned %+v", st)
	}
	// While downloading: a second Install is refused and a check leaves the state.
	if _, err := r.store.Install(ctx); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("second Install err = %v", err)
	}
	r.source.Set("v0.3.0", nil)
	if st, _ := r.store.Check(ctx); st.State != update.Downloading || st.Target != "v0.2.0" {
		t.Fatalf("check while downloading %+v", st)
	}
	r.source.Set("v0.2.0", nil)
	r.installer.Release()

	st = r.waitState(t, update.Installed)
	if st.Target != "v0.2.0" || st.Progress != "" {
		t.Fatalf("installed %+v", st)
	}
	if got := r.installer.Calls(); len(got) != 1 || got[0] != "v0.2.0" {
		t.Fatalf("installer calls %v", got)
	}

	if n := r.store.RequestRelaunch(); n != 1 {
		t.Fatalf("RequestRelaunch delivered %d, want 1", n)
	}
	<-r.relaunch.C()
	if st := r.store.Snapshot(); st.State != update.RestartRequired || st.Target != "v0.2.0" {
		t.Fatalf("after relaunch %+v", st)
	}
	// Later checks keep it until the daemon restarts.
	if st, _ := r.store.Check(ctx); st.State != update.RestartRequired {
		t.Fatalf("check after relaunch %+v", st)
	}
}

func TestProgressIsPublished(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	r.installer.Hold = true
	r.installer.Progress = []string{"==> downloading CodeFoundry-darwin-arm64.zip"}
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-r.events.C():
			if ev.Status.Progress == "==> downloading CodeFoundry-darwin-arm64.zip" {
				r.installer.Release()
				r.waitState(t, update.Installed)
				return
			}
		case <-deadline:
			t.Fatal("no progress event")
		}
	}
}

func TestInstallFailureAndRetry(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	ctx := context.Background()
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	r.installer.Err = errors.New("installer: exit status 1: error: checksum mismatch")
	if _, err := r.store.Install(ctx); err != nil {
		t.Fatal(err)
	}
	st := r.waitState(t, update.Failed)
	if st.Target != "v0.2.0" || !strings.Contains(st.FailureReason, "checksum mismatch") {
		t.Fatalf("failed %+v", st)
	}
	// A check for the same version keeps the failure visible.
	if st, _ := r.store.Check(ctx); st.State != update.Failed {
		t.Fatalf("check after failure %+v", st)
	}
	r.installer.Err = nil
	if _, err := r.store.Install(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if st := r.waitState(t, update.Installed); st.FailureReason != "" {
		t.Fatalf("retry %+v", st)
	}
}

func TestInstallerMismatchFails(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	ctx := context.Background()
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	// The installer exits 0 but the install on disk reports another version.
	r.installer.InstallAs = "v0.1.5"
	if _, err := r.store.Install(ctx); err != nil {
		t.Fatal(err)
	}
	st := r.waitState(t, update.Failed)
	if !strings.Contains(st.FailureReason, "v0.1.5") {
		t.Fatalf("failed %+v", st)
	}
}

func TestCheckErrors(t *testing.T) {
	tests := []struct {
		name      string
		tag       string
		err       error
		wantErr   bool
		wantState update.State
	}{
		{"network error", "", errors.New("gh: error connecting to api.github.com"), true, update.Available},
		{"malformed tag", "latest", nil, true, update.Available},
		{"empty tag", "", nil, true, update.Available},
		{"no release published", "", update.ErrNoRelease, false, update.Idle},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, "v0.2.0", nil)
			ctx := context.Background()
			if _, err := r.store.Check(ctx); err != nil {
				t.Fatal(err)
			}
			r.source.Set(tt.tag, tt.err)
			st, err := r.store.Check(ctx)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if st.State != tt.wantState {
				t.Fatalf("state %v, want %v", st.State, tt.wantState)
			}
			if tt.wantErr && st.LastCheckError == "" {
				t.Fatal("LastCheckError not set")
			}
			if !tt.wantErr && st.LastCheckError != "" {
				t.Fatalf("LastCheckError = %q", st.LastCheckError)
			}
		})
	}
}

func TestDisabled(t *testing.T) {
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		o.Current = "dev"
		o.DisabledReason = "dev build"
		o.InitialDelay = time.Millisecond
	})
	ctx := context.Background()
	if _, err := r.store.Check(ctx); !errors.Is(err, update.ErrDisabled) {
		t.Fatalf("Check err = %v", err)
	}
	if _, err := r.store.Install(ctx); !errors.Is(err, update.ErrDisabled) {
		t.Fatalf("Install err = %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if n := r.source.Calls(); n != 0 {
		t.Fatalf("source called %d times while disabled", n)
	}
	if st := r.store.Snapshot(); st.Enabled || st.DisabledReason != "dev build" || st.State != update.Idle {
		t.Fatalf("%+v", st)
	}
}

func TestInstallWithoutUpdate(t *testing.T) {
	r := newRig(t, "v0.1.0", nil)
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.Install(context.Background()); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("err = %v", err)
	}
}

func TestPeriodicChecks(t *testing.T) {
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		o.InitialDelay = time.Millisecond
		o.Interval = 5 * time.Millisecond
	})
	r.waitState(t, update.Available)
	deadline := time.Now().Add(5 * time.Second)
	for r.source.Calls() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d checks", r.source.Calls())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestNewerInstallOnDiskAtStart(t *testing.T) {
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		disk := updatetest.NewOnDisk("v0.2.0")
		o.InstalledVersion = disk.Version
	})
	if st := r.store.Snapshot(); st.State != update.Installed || st.Target != "v0.2.0" {
		t.Fatalf("%+v", st)
	}
}

func TestDefaultOptions(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		name, current, repo, dir string
		wantReason               string
		wantSource               bool
	}{
		{"dev build", "dev", "o/n", "", "dev build", false},
		{"release with repo", "v0.1.0", "o/n", "", "", true},
		{"release with local dir", "v0.1.0", "", dir, "", true},
		{"release without repo", "v0.1.0", "", "", "no release repository configured", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("CODE_FOUNDRY_RELEASE_REPO", tt.repo)
			t.Setenv("CODE_FOUNDRY_RELEASE_DIR", tt.dir)
			o := update.DefaultOptions(tt.current)
			if o.DisabledReason != tt.wantReason || (o.Source != nil) != tt.wantSource {
				t.Fatalf("%+v", o)
			}
		})
	}
}

func TestDirSource(t *testing.T) {
	dir := t.TempDir()
	s := update.DirSource{Dir: dir}
	if _, err := s.Latest(context.Background()); !errors.Is(err, update.ErrNoRelease) {
		t.Fatalf("missing latest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "latest"), []byte("v0.3.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if tag, err := s.Latest(context.Background()); err != nil || tag != "v0.3.0" {
		t.Fatalf("Latest = %q, %v", tag, err)
	}
}
