package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDecide(t *testing.T) {
	tests := []struct {
		name       string
		state      State
		target     string
		current    string
		onDisk     string
		latest     string
		want       State
		wantTarget string
	}{
		{"up to date", Idle, "", "v0.1.0", "v0.1.0", "v0.1.0", Idle, ""},
		{"newer release", Idle, "", "v0.1.0", "v0.1.0", "v0.2.0", Available, "v0.2.0"},
		{"newer release, install unknown", Idle, "", "v0.1.0", "", "v0.2.0", Available, "v0.2.0"},
		{"older release (yanked latest)", Idle, "", "v0.2.0", "", "v0.1.0", Idle, ""},
		{"no release published", Idle, "", "v0.1.0", "", "", Idle, ""},
		{"available stays available", Available, "v0.2.0", "v0.1.0", "", "v0.2.0", Available, "v0.2.0"},
		{"available moves to an even newer one", Available, "v0.2.0", "v0.1.0", "", "v0.3.0", Available, "v0.3.0"},
		{"downloading is left to the install", Downloading, "v0.2.0", "v0.1.0", "", "v0.3.0", Downloading, "v0.2.0"},
		{"installed by someone else", Idle, "", "v0.1.0", "v0.2.0", "v0.2.0", Installed, "v0.2.0"},
		{"installed stays installed", Installed, "v0.2.0", "v0.1.0", "v0.2.0", "v0.2.0", Installed, "v0.2.0"},
		{"restart required stays", RestartRequired, "v0.2.0", "v0.1.0", "v0.2.0", "v0.2.0", RestartRequired, "v0.2.0"},
		{"installed, then a newer release", Installed, "v0.2.0", "v0.1.0", "v0.2.0", "v0.3.0", Available, "v0.3.0"},
		{"failed keeps the failure for the same version", Failed, "v0.2.0", "v0.1.0", "v0.1.0", "v0.2.0", Failed, "v0.2.0"},
		{"failed, then a newer release", Failed, "v0.2.0", "v0.1.0", "v0.1.0", "v0.3.0", Available, "v0.3.0"},
		{"failed, then installed elsewhere", Failed, "v0.2.0", "v0.1.0", "v0.2.0", "v0.2.0", Installed, "v0.2.0"},
		{"pre-release counts as newer", Idle, "", "v0.1.0", "", "v0.2.0-rc.1", Available, "v0.2.0-rc.1"},
		{"release after its pre-release", Idle, "", "v0.2.0-rc.1", "", "v0.2.0", Available, "v0.2.0"},
		{"malformed on-disk version is ignored", Idle, "", "v0.1.0", "garbage", "v0.1.0", Idle, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, target := decide(tt.state, tt.target, tt.current, tt.onDisk, tt.latest)
			if got != tt.want || target != tt.wantTarget {
				t.Errorf("decide = %v %q, want %v %q", got, target, tt.want, tt.wantTarget)
			}
		})
	}
}

func TestInstalledVersion(t *testing.T) {
	tests := []struct {
		name    string
		file    *string // VERSION contents; nil = no file
		want    string
		wantErr bool
		install bool
	}{
		{"tag with newline", ptr("v0.2.0\n"), "v0.2.0", false, true},
		{"pre-release, no newline", ptr("v0.2.0-rc.1"), "v0.2.0-rc.1", false, true},
		{"first line only, trimmed", ptr("  v0.3.0 \nextra\n"), "v0.3.0", false, true},
		{"empty", ptr("\n"), "", true, true},
		{"no VERSION file", nil, "", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if tt.file != nil {
				if err := os.WriteFile(filepath.Join(dir, VersionFile), []byte(*tt.file), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := IsInstall(dir); got != tt.install {
				t.Errorf("IsInstall = %v, want %v", got, tt.install)
			}
			got, err := InstalledVersion(dir)
			if (err != nil) != tt.wantErr || got != tt.want {
				t.Errorf("InstalledVersion = %q, %v; want %q (err %v)", got, err, tt.want, tt.wantErr)
			}
			// The store's reader treats a directory that is not an install as unknown.
			v, err := installedVersionIn(dir)()
			if !tt.install && (v != "" || err != nil) {
				t.Errorf("installedVersionIn(non-install) = %q, %v", v, err)
			}
		})
	}
	if IsInstall("") {
		t.Error(`IsInstall("") = true`)
	}
}

func ptr(s string) *string { return &s }
