package ember

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ZoneName is loc's IANA name ("America/Chicago") for the seed. time.Local is named
// "Local", so its name comes from $TZ, else from the /etc/localtime link; "" when
// neither tells.
func ZoneName(loc *time.Location) string {
	if loc != time.Local {
		return loc.String()
	}
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" && !filepath.IsAbs(tz) {
		return tz
	}
	link, err := os.Readlink("/etc/localtime")
	if err != nil {
		return ""
	}
	if _, name, ok := strings.Cut(link, "zoneinfo/"); ok {
		return name
	}
	return ""
}

// zoneLine is BOARD.md's time zone line: the zone's name and its abbreviation at now,
// so Ember gives the user local times.
func zoneLine(now time.Time, loc *time.Location) string {
	abbr, _ := now.In(loc).Zone()
	zone := abbr
	if name := ZoneName(loc); name != "" && name != abbr {
		zone = name + " (" + abbr + ")"
	}
	return "Time zone: " + zone + ", local times. Every time in this seed is local; give the user local times, never UTC.\n"
}
