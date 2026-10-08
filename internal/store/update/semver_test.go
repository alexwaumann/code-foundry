package update

import "testing"

func TestParseVersion(t *testing.T) {
	tests := []struct {
		in    string
		ok    bool
		major uint64
		pre   int
	}{
		{"v1.2.3", true, 1, 0},
		{"1.2.3", true, 1, 0},
		{"v0.1.0", true, 0, 0},
		{"v1.3.0-rc.1", true, 1, 2},
		{"v1.3.0-rc.1+build.5", true, 1, 2},
		{"v1.3.0+build", true, 1, 0},
		{"v1.2", false, 0, 0},
		{"v1.2.3.4", false, 0, 0},
		{"v01.2.3", false, 0, 0},
		{"v1.2.3-", false, 0, 0},
		{"v1.2.3-01", false, 0, 0},
		{"dev", false, 0, 0},
		{"", false, 0, 0},
		{"V1.2.3", false, 0, 0},
		{" v1.2.3", false, 0, 0},
		{"v1.2.3\n", false, 0, 0},
		{"null", false, 0, 0},
	}
	for _, tt := range tests {
		v, err := ParseVersion(tt.in)
		if (err == nil) != tt.ok {
			t.Errorf("ParseVersion(%q) err = %v, want ok=%v", tt.in, err, tt.ok)
			continue
		}
		if tt.ok && (v.Major != tt.major || len(v.Pre) != tt.pre) {
			t.Errorf("ParseVersion(%q) = %+v", tt.in, v)
		}
	}
}

func TestNewer(t *testing.T) {
	tests := []struct {
		candidate, current string
		want               bool
	}{
		{"v0.1.1", "v0.1.0", true},
		{"v0.2.0", "v0.1.9", true},
		{"v1.0.0", "v0.99.99", true},
		{"v0.1.0", "v0.1.0", false},
		{"v0.1.0", "v0.1.1", false},
		{"v0.10.0", "v0.9.0", true}, // numeric, not lexical
		{"v1.0.0", "v1.0.0-rc.1", true},
		{"v1.0.0-rc.1", "v1.0.0", false},
		{"v1.0.0-rc.2", "v1.0.0-rc.1", true},
		{"v1.0.0-rc.10", "v1.0.0-rc.9", true},
		{"v1.0.0-beta", "v1.0.0-alpha", true},
		{"v1.0.0-alpha.1", "v1.0.0-alpha", true},
		{"v1.0.0-alpha", "v1.0.0-1", true}, // alphanumeric > numeric
		{"v1.0.0+b2", "v1.0.0+b1", false},  // build metadata ignored
		{"0.1.1", "v0.1.0", true},
		{"garbage", "v0.1.0", false},
		{"v0.2.0", "dev", false},
		{"", "v0.1.0", false},
	}
	for _, tt := range tests {
		if got := Newer(tt.candidate, tt.current); got != tt.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", tt.candidate, tt.current, got, tt.want)
		}
	}
}
