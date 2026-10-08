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
		{"newer release, bundle unknown", Idle, "", "v0.1.0", "", "v0.2.0", Available, "v0.2.0"},
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

func TestBundleOf(t *testing.T) {
	tests := []struct{ exe, want string }{
		{"/Users/a/Applications/CodeFoundry.app/Contents/MacOS/code-foundry", "/Users/a/Applications/CodeFoundry.app"},
		{"/Applications/CodeFoundry.app/Contents/MacOS/CodeFoundry", "/Applications/CodeFoundry.app"},
		{"/Users/a/src/code-foundry/bin/code-foundry", ""},
		{"/Users/a/Contents/MacOS/code-foundry", ""},
		{"/x/Foo.app/Contents/Resources/code-foundry", ""},
		{"code-foundry", ""},
	}
	for _, tt := range tests {
		if got := BundleOf(tt.exe); got != tt.want {
			t.Errorf("BundleOf(%q) = %q, want %q", tt.exe, got, tt.want)
		}
	}
}

func TestBundleVersion(t *testing.T) {
	plist := func(body string) string {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>` + body + `</dict></plist>`
	}
	tests := []struct {
		name, plist, want string
		wantErr           bool
	}{
		{"full tag", plist("<key>CFBundleShortVersionString</key>\n\t<string>0.2.0</string>\n\t<key>CodeFoundryVersion</key>\n\t<string>v0.2.0-rc.1</string>"), "v0.2.0-rc.1", false},
		{"short version only", plist("<key>CFBundleShortVersionString</key>\n            <string>0.1.0</string>"), "v0.1.0", false},
		{"no version", plist("<key>CFBundleName</key><string>x</string>"), "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := filepath.Join(t.TempDir(), BundleName)
			if err := os.MkdirAll(filepath.Join(b, "Contents"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(b, "Contents", "Info.plist"), []byte(tt.plist), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := BundleVersion(b)
			if (err != nil) != tt.wantErr || got != tt.want {
				t.Errorf("BundleVersion = %q, %v; want %q (err %v)", got, err, tt.want, tt.wantErr)
			}
		})
	}
}
