package update_test

import (
	"context"
	"errors"
	"strings"
	"sync"
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
		StagedVersion:    r.installer.Staged().Version,
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

func TestCheckDownloadInstallRelaunch(t *testing.T) {
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
	// Nothing downloaded yet: nothing to install.
	if _, err := r.store.Install(ctx); !errors.Is(err, update.ErrNotAvailable) || !strings.Contains(err.Error(), "nothing downloaded") {
		t.Fatalf("Install before Download err = %v", err)
	}

	r.installer.Hold = true
	r.installer.Progress = []string{"==> downloading", "==> verifying checksum"}
	st, err = r.store.Download(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Downloading || st.Progress != "starting download" {
		t.Fatalf("Download returned %+v", st)
	}
	// While downloading: a second Download and an Install are refused, and a check
	// leaves the state.
	if _, err := r.store.Download(ctx); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("second Download err = %v", err)
	}
	if _, err := r.store.Install(ctx); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("Install while downloading err = %v", err)
	}
	r.source.Set("v0.3.0", nil)
	if st, _ := r.store.Check(ctx); st.State != update.Downloading || st.Target != "v0.2.0" {
		t.Fatalf("check while downloading %+v", st)
	}
	r.source.Set("v0.2.0", nil)
	r.installer.Release()

	st = r.waitState(t, update.Downloaded)
	if st.Target != "v0.2.0" || st.Progress != "" {
		t.Fatalf("downloaded %+v", st)
	}
	if got := r.installer.Calls(); len(got) != 1 || got[0] != "v0.2.0" {
		t.Fatalf("download calls %v", got)
	}
	// Downloading changed nothing on disk.
	if v, _ := r.disk.Version(); v != "v0.1.0" {
		t.Fatalf("on disk after download: %s", v)
	}
	if _, err := r.store.Download(ctx); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("Download when downloaded err = %v", err)
	}
	// A check for the same release keeps it downloaded.
	if st, _ := r.store.Check(ctx); st.State != update.Downloaded || st.Target != "v0.2.0" {
		t.Fatalf("check after download %+v", st)
	}

	st, err = r.store.Install(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Installed || st.Target != "v0.2.0" {
		t.Fatalf("Install returned %+v", st)
	}
	if v, _ := r.disk.Version(); v != "v0.2.0" {
		t.Fatalf("on disk after install: %s", v)
	}
	if v, _ := r.installer.Staged().Version(); v != "" {
		t.Fatalf("still staged after install: %s", v)
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

// TestRequestRestart: the restart announcement reaches bus listeners and leaves the
// status alone (the daemon is about to exit), unlike RequestRelaunch.
func TestRequestRestart(t *testing.T) {
	tests := []struct {
		name   string
		onDisk string
		want   update.State
	}{
		{"installed stays installed", "v0.2.0", update.Installed},
		{"idle stays idle", "v0.1.0", update.Idle},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var b *bus.Bus
			r := newRig(t, "v0.1.0", func(o *update.Options) {
				o.InstalledVersion = updatetest.NewOnDisk(tt.onDisk).Version
				b = o.Bus
			})
			restart := bus.Subscribe[update.RestartRequested](b, 8)
			before := r.store.Snapshot()
			if before.State != tt.want {
				t.Fatalf("initial state %v, want %v", before.State, tt.want)
			}
			// Only RestartRequested listeners count, not the rig's relaunch subscription.
			if n := r.store.RequestRestart(); n != 1 {
				t.Fatalf("RequestRestart delivered %d, want 1", n)
			}
			select {
			case <-restart.C():
			case <-time.After(5 * time.Second):
				t.Fatal("RestartRequested not received")
			}
			if st := r.store.Snapshot(); st != before {
				t.Fatalf("status changed: %+v, was %+v", st, before)
			}
			select {
			case ev := <-r.events.C():
				t.Fatalf("status published: %+v", ev.Status)
			default:
			}
			select {
			case <-r.relaunch.C():
				t.Fatal("RequestRestart published RelaunchRequested")
			default:
			}
		})
	}
}

func TestRequestRestartWithoutBus(t *testing.T) {
	r := newRig(t, "v0.1.0", func(o *update.Options) { o.Bus = nil })
	if n := r.store.RequestRestart(); n != 0 {
		t.Fatalf("RequestRestart delivered %d without a bus, want 0", n)
	}
}

func TestProgressIsPublished(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	r.installer.Hold = true
	r.installer.Progress = []string{"==> copying code-foundry-darwin-arm64.tar.gz"}
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.Download(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-r.events.C():
			if ev.Status.Progress == "==> copying code-foundry-darwin-arm64.tar.gz" {
				r.installer.Release()
				r.waitState(t, update.Downloaded)
				return
			}
		case <-deadline:
			t.Fatal("no progress event")
		}
	}
}

// downloaded checks for v0.2.0 and downloads it.
func (r *rig) downloaded(t *testing.T) {
	t.Helper()
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.Download(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.waitState(t, update.Downloaded)
}

func TestDownloadFailureAndRetry(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	ctx := context.Background()
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	r.installer.DownloadErr = errors.New("installer: exit status 1: error: checksum mismatch")
	if _, err := r.store.Download(ctx); err != nil {
		t.Fatal(err)
	}
	st := r.waitState(t, update.Failed)
	if st.Target != "v0.2.0" || !strings.Contains(st.FailureReason, "checksum mismatch") || st.Progress != "" {
		t.Fatalf("failed %+v", st)
	}
	// A check for the same version keeps the failure visible.
	if st, _ := r.store.Check(ctx); st.State != update.Failed {
		t.Fatalf("check after failure %+v", st)
	}
	r.installer.DownloadErr = nil
	if _, err := r.store.Download(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if st := r.waitState(t, update.Downloaded); st.FailureReason != "" {
		t.Fatalf("retry %+v", st)
	}
}

func TestDownloadStagedMismatchFails(t *testing.T) {
	tests := []struct {
		name, as, want string
	}{
		{"another version staged", "v0.1.5", "found v0.1.5"},
		{"nothing staged", "garbage", "found nothing"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, "v0.2.0", nil)
			ctx := context.Background()
			if _, err := r.store.Check(ctx); err != nil {
				t.Fatal(err)
			}
			// The installer exits 0 but the stage reports another version.
			r.installer.DownloadAs = tt.as
			if _, err := r.store.Download(ctx); err != nil {
				t.Fatal(err)
			}
			st := r.waitState(t, update.Failed)
			if !strings.Contains(st.FailureReason, tt.want) {
				t.Fatalf("failed %+v", st)
			}
		})
	}
}

func TestInstallFailureAndRetry(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	ctx := context.Background()
	r.downloaded(t)
	r.installer.InstallErr = errors.New("installer: exit status 1: error: could not move the new version")
	st, err := r.store.Install(ctx)
	if err == nil || errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("Install err = %v", err)
	}
	if st.State != update.Failed || st.Target != "v0.2.0" || !strings.Contains(st.FailureReason, "could not move") {
		t.Fatalf("Install returned %+v", st)
	}
	if v, _ := r.disk.Version(); v != "v0.1.0" {
		t.Fatalf("on disk after a failed install: %s", v)
	}
	// The failure stays visible, and Install is refused until a new download.
	if st, _ := r.store.Check(ctx); st.State != update.Failed {
		t.Fatalf("check after failure %+v", st)
	}
	if _, err := r.store.Install(ctx); !errors.Is(err, update.ErrNotAvailable) {
		t.Fatalf("Install from Failed err = %v", err)
	}
	r.installer.InstallErr = nil
	if _, err := r.store.Download(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	r.waitState(t, update.Downloaded)
	if st, err := r.store.Install(ctx); err != nil || st.State != update.Installed || st.FailureReason != "" {
		t.Fatalf("retry Install %+v, %v", st, err)
	}
}

func TestInstallerMismatchFails(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	r.downloaded(t)
	// The installer exits 0 but the install on disk reports another version.
	r.installer.InstallAs = "v0.1.5"
	st, err := r.store.Install(context.Background())
	if err == nil || st.State != update.Failed || !strings.Contains(st.FailureReason, "v0.1.5") {
		t.Fatalf("Install %+v, %v", st, err)
	}
}

// Installed by hand meanwhile (install.sh also removes the stage): Install has nothing
// left to do.
func TestInstallAlreadyOnDisk(t *testing.T) {
	r := newRig(t, "v0.2.0", nil)
	r.downloaded(t)
	r.disk.Set("v0.2.0")
	r.installer.Staged().Set("")
	st, err := r.store.Install(context.Background())
	if err != nil || st.State != update.Installed || st.Target != "v0.2.0" {
		t.Fatalf("Install %+v, %v", st, err)
	}
	if n := len(r.installer.Installs()); n != 0 {
		t.Fatalf("installer ran %d times", n)
	}
}

func TestInstallRefused(t *testing.T) {
	tests := []struct {
		name    string
		latest  string
		prepare func(t *testing.T, r *rig)
	}{
		{"idle", "v0.1.0", func(*testing.T, *rig) {}},
		{"available", "v0.2.0", func(*testing.T, *rig) {}},
		{"failed download", "v0.2.0", func(t *testing.T, r *rig) {
			r.installer.DownloadErr = errors.New("boom")
			if _, err := r.store.Download(context.Background()); err != nil {
				t.Fatal(err)
			}
			r.waitState(t, update.Failed)
		}},
		{"installed", "v0.2.0", func(t *testing.T, r *rig) {
			r.disk.Set("v0.2.0")
			if st, _ := r.store.Check(context.Background()); st.State != update.Installed {
				t.Fatalf("not installed: %+v", st)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, tt.latest, nil)
			if _, err := r.store.Check(context.Background()); err != nil {
				t.Fatal(err)
			}
			tt.prepare(t, r)
			before := r.store.Snapshot()
			if _, err := r.store.Install(context.Background()); !errors.Is(err, update.ErrNotAvailable) || !strings.Contains(err.Error(), "nothing downloaded to install") {
				t.Fatalf("Install err = %v", err)
			}
			if st := r.store.Snapshot(); st.State != before.State {
				t.Fatalf("state %v, was %v", st.State, before.State)
			}
			if n := len(r.installer.Installs()); n != 0 {
				t.Fatalf("installer ran %d times", n)
			}
		})
	}
}

// A daemon that starts with a newer download staged (it crashed or restarted after
// downloading) is Downloaded at once; a stale stage is ignored.
func TestStagedDownloadAtStart(t *testing.T) {
	tests := []struct {
		name, current, onDisk, staged string
		want                          update.State
		wantTarget                    string
	}{
		{"newer download staged", "v0.1.0", "v0.1.0", "v0.2.0", update.Downloaded, "v0.2.0"},
		{"stale stage", "v0.2.0", "v0.2.0", "v0.1.0", update.Idle, ""},
		{"stage of the running version", "v0.2.0", "v0.2.0", "v0.2.0", update.Idle, ""},
		{"staged above a newer install", "v0.1.0", "v0.2.0", "v0.3.0", update.Downloaded, "v0.3.0"},
		{"stage below a newer install", "v0.1.0", "v0.3.0", "v0.2.0", update.Installed, "v0.3.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, "v0.1.0", func(o *update.Options) {
				o.Current = tt.current
				o.InstalledVersion = updatetest.NewOnDisk(tt.onDisk).Version
				o.StagedVersion = updatetest.NewOnDisk(tt.staged).Version
			})
			if st := r.store.Snapshot(); st.State != tt.want || st.Target != tt.wantTarget {
				t.Fatalf("%+v", st)
			}
		})
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
	if _, err := r.store.Download(ctx); !errors.Is(err, update.ErrDisabled) {
		t.Fatalf("Download err = %v", err)
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

func TestDownloadWithoutUpdate(t *testing.T) {
	r := newRig(t, "v0.1.0", nil)
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.Download(context.Background()); !errors.Is(err, update.ErrNotAvailable) {
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

// TestCheckAfterSleep: the loop measures the interval on the wall clock, so a check that
// came due while the machine slept runs on the first tick after wake rather than a full
// interval later. The fake clock stands still until it jumps past the interval.
func TestCheckAfterSleep(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		o.InitialDelay = time.Millisecond
		o.Interval = time.Hour
		o.Tick = time.Millisecond
		o.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	})
	r.waitState(t, update.Available)
	time.Sleep(20 * time.Millisecond) // several ticks with the clock still: no re-check
	if n := r.source.Calls(); n != 1 {
		t.Fatalf("checks before the clock moved = %d, want 1", n)
	}
	mu.Lock()
	now = now.Add(90 * time.Minute) // the lid was shut for an hour and a half
	mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for r.source.Calls() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("no check after the clock jumped; %d checks", r.source.Calls())
		}
		time.Sleep(5 * time.Millisecond)
	}
}
