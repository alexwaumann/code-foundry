package update

import (
	"cmp"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Version is a parsed semantic version (https://semver.org), as used for release tags
// ("v1.2.3", "v1.3.0-rc.1"). Build metadata is accepted and ignored for precedence.
type Version struct {
	Major, Minor, Patch uint64
	// Pre holds the dot-separated pre-release identifiers ("rc", "1"); empty for a release.
	Pre []string
}

// semverPattern is the official semver 2.0.0 grammar with an optional leading "v".
var semverPattern = regexp.MustCompile(`^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
	`(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?` +
	`(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)

// ParseVersion parses s strictly. "v1.2" and "1.2.3.4" are errors.
func ParseVersion(s string) (Version, error) {
	m := semverPattern.FindStringSubmatch(s)
	if m == nil {
		return Version{}, fmt.Errorf("malformed version %q: want vMAJOR.MINOR.PATCH[-PRERELEASE]", s)
	}
	var v Version
	var err error
	for i, dst := range []*uint64{&v.Major, &v.Minor, &v.Patch} {
		if *dst, err = strconv.ParseUint(m[i+1], 10, 64); err != nil {
			return Version{}, fmt.Errorf("malformed version %q: %w", s, err)
		}
	}
	if m[4] != "" {
		v.Pre = strings.Split(m[4], ".")
	}
	return v, nil
}

// IsSemver reports whether s parses as a version. Dev builds ("dev") do not.
func IsSemver(s string) bool {
	_, err := ParseVersion(s)
	return err == nil
}

// Compare returns -1, 0 or +1 by semver precedence.
func (v Version) Compare(o Version) int {
	if c := cmp.Or(cmp.Compare(v.Major, o.Major), cmp.Compare(v.Minor, o.Minor), cmp.Compare(v.Patch, o.Patch)); c != 0 {
		return c
	}
	// A release has higher precedence than any of its pre-releases.
	switch {
	case len(v.Pre) == 0 && len(o.Pre) == 0:
		return 0
	case len(v.Pre) == 0:
		return 1
	case len(o.Pre) == 0:
		return -1
	}
	for i := 0; i < len(v.Pre) && i < len(o.Pre); i++ {
		if c := comparePre(v.Pre[i], o.Pre[i]); c != 0 {
			return c
		}
	}
	return cmp.Compare(len(v.Pre), len(o.Pre))
}

// comparePre compares pre-release identifiers: numeric ones numerically and below
// alphanumeric ones, which compare in ASCII order.
func comparePre(a, b string) int {
	an, aErr := strconv.ParseUint(a, 10, 64)
	bn, bErr := strconv.ParseUint(b, 10, 64)
	switch {
	case aErr == nil && bErr == nil:
		return cmp.Compare(an, bn)
	case aErr == nil:
		return -1
	case bErr == nil:
		return 1
	}
	return strings.Compare(a, b)
}

// Newer reports whether candidate is strictly newer than current. Either one being
// malformed means no update.
func Newer(candidate, current string) bool {
	c, err := ParseVersion(candidate)
	if err != nil {
		return false
	}
	r, err := ParseVersion(current)
	if err != nil {
		return false
	}
	return c.Compare(r) > 0
}
