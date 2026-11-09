package update_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// newAutoRig is newRig with automatic downloads on (the default outside tests).
func newAutoRig(t *testing.T, latest string) *rig {
	t.Helper()
	return newRig(t, latest, func(o *update.Options) { o.ManualDownload = false })
}

// waitDownloads waits until the installer has been asked for n downloads.
func (r *rig) waitDownloads(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(r.installer.Calls()) < n {
		if time.Now().After(deadline) {
			t.Fatalf("downloads %v, want %d", r.installer.Calls(), n)
		}
		time.Sleep(time.Millisecond)
	}
	return r.installer.Calls()
}

// TestCheckDownloadsAutomatically: a check that finds a newer release starts downloading
// it; nobody clicks Download.
func TestCheckDownloadsAutomatically(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	st, err := r.store.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Downloading || st.Target != "v0.2.0" {
		t.Fatalf("check returned %+v, want downloading v0.2.0", st)
	}
	r.waitTarget(t, update.Downloaded, "v0.2.0")
	if got := r.installer.Calls(); !slices.Equal(got, []string{"v0.2.0"}) {
		t.Fatalf("downloads %v", got)
	}
	// Nothing newer: a later check downloads nothing.
	if st, _ := r.store.Check(context.Background()); st.State != update.Downloaded {
		t.Fatalf("second check %+v", st)
	}
	if got := r.installer.Calls(); len(got) != 1 {
		t.Fatalf("downloads after a second check %v", got)
	}
}

// TestManualDownloadWithAutomaticOn: Download's own check does not start the download
// itself, so Download is not refused as "already downloading".
func TestManualDownloadWithAutomaticOn(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	st, err := r.store.Download(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Downloading || st.Target != "v0.2.0" {
		t.Fatalf("Download returned %+v", st)
	}
	r.waitTarget(t, update.Downloaded, "v0.2.0")
}

// TestAutomaticDownloadFailure: an automatic download that fails goes back to Available
// (not Failed), the check right after it does not retry the same version, and the next
// check does.
func TestAutomaticDownloadFailure(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	ctx := context.Background()
	r.installer.FailTag("v0.2.0", errors.New("installer: exit status 1: download failed"))
	calls := r.source.Calls()
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	st := r.waitTarget(t, update.Available, "v0.2.0")
	if st.FailureReason != "" {
		t.Fatalf("available after an automatic failure %+v", st)
	}
	r.waitSourceCalls(t, calls+2) // the check and the one after the failure
	if st := r.store.Snapshot(); st.State != update.Available {
		t.Fatalf("after the re-check %+v", st)
	}
	if got := r.installer.Calls(); len(got) != 1 {
		t.Fatalf("the re-check retried the failed version: downloads %v", got)
	}

	r.installer.FailTag("v0.2.0", nil)
	if st, _ := r.store.Check(ctx); st.State != update.Downloading {
		t.Fatalf("next check %+v, want downloading", st)
	}
	r.waitTarget(t, update.Downloaded, "v0.2.0")
}

// TestAutomaticFailureThenNewer: the release is deleted while it downloads; the check
// after the failure finds the newer one and downloads it.
func TestAutomaticFailureThenNewer(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	release := r.installer.HoldTag("v0.2.0")
	r.installer.FailTag("v0.2.0", errors.New("installer: exit status 1: release not found"))
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.source.Set("v0.3.0", nil)
	release()
	r.waitTarget(t, update.Downloaded, "v0.3.0")
	if got := r.installer.Calls(); !slices.Equal(got, []string{"v0.2.0", "v0.3.0"}) {
		t.Fatalf("downloads %v", got)
	}
}

// TestNewerReplacesDownload: a newer release downloads in the background while the older
// download stays installable, then takes its place.
func TestNewerReplacesDownload(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	ctx := context.Background()
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	r.waitTarget(t, update.Downloaded, "v0.2.0")

	release := r.installer.HoldTag("v0.3.0")
	r.source.Set("v0.3.0", nil)
	st, err := r.store.Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != update.Downloaded || st.Target != "v0.2.0" || st.Latest != "v0.3.0" {
		t.Fatalf("check with a newer release %+v, want downloaded v0.2.0", st)
	}
	r.waitDownloads(t, 2)
	// While it downloads: still Downloaded v0.2.0, staged v0.2.0, and a check starts no
	// second replacement.
	if st, _ := r.store.Check(ctx); st.State != update.Downloaded || st.Target != "v0.2.0" {
		t.Fatalf("check while replacing %+v", st)
	}
	if v, _ := r.installer.Staged().Version(); v != "v0.2.0" {
		t.Fatalf("staged while replacing: %s", v)
	}
	if got := r.installer.Calls(); len(got) != 2 {
		t.Fatalf("downloads while replacing %v", got)
	}
	release()
	r.waitTarget(t, update.Downloaded, "v0.3.0")
}

// TestNewerDuringDownload: a release that appears while the first download runs
// replaces it as soon as that download finishes.
func TestNewerDuringDownload(t *testing.T) {
	r := newAutoRig(t, "v0.2.0")
	ctx := context.Background()
	release := r.installer.HoldTag("v0.2.0")
	if _, err := r.store.Check(ctx); err != nil {
		t.Fatal(err)
	}
	r.source.Set("v0.3.0", nil)
	if st, _ := r.store.Check(ctx); st.State != update.Downloading || st.Target != "v0.2.0" {
		t.Fatalf("check while downloading %+v", st)
	}
	release()
	r.waitTarget(t, update.Downloaded, "v0.2.0")
	r.waitTarget(t, update.Downloaded, "v0.3.0")
	if got := r.installer.Calls(); !slices.Equal(got, []string{"v0.2.0", "v0.3.0"}) {
		t.Fatalf("downloads %v", got)
	}
}

// TestInstallDuringReplacement: Restart Now while a newer release downloads cancels that
// download and installs the one staged.
func TestInstallDuringReplacement(t *testing.T) {
	tests := []struct {
		name string
		// fail makes the replacement fail instead of hanging until cancelled.
		fail bool
	}{
		{name: "replacement still downloading"},
		{name: "replacement failed", fail: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newAutoRig(t, "v0.2.0")
			ctx := context.Background()
			if _, err := r.store.Check(ctx); err != nil {
				t.Fatal(err)
			}
			r.waitTarget(t, update.Downloaded, "v0.2.0")
			if tt.fail {
				r.installer.FailTag("v0.3.0", errors.New("installer: exit status 1: download failed"))
			} else {
				t.Cleanup(r.installer.HoldTag("v0.3.0"))
			}
			r.source.Set("v0.3.0", nil)
			if _, err := r.store.Check(ctx); err != nil {
				t.Fatal(err)
			}
			r.waitDownloads(t, 2)

			st, err := r.store.Install(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if st.State != update.Installed || st.Target != "v0.2.0" {
				t.Fatalf("Install returned %+v", st)
			}
			if v, _ := r.disk.Version(); v != "v0.2.0" {
				t.Fatalf("on disk: %s", v)
			}
			if got := r.installer.Installs(); !slices.Equal(got, []string{"v0.2.0"}) {
				t.Fatalf("installs %v", got)
			}
		})
	}
}

// TestPeriodicCheckDownloads: the scheduled check downloads too.
func TestPeriodicCheckDownloads(t *testing.T) {
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		o.ManualDownload = false
		o.InitialDelay = time.Millisecond
	})
	r.waitTarget(t, update.Downloaded, "v0.2.0")
}
