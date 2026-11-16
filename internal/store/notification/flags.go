package notification

import (
	"context"
	"strings"
)

// Flag keys (docs/notes/plugin-flag-retirement.md): a plugin's thread flag
// (thread/setFlag, deprecated) is a notification the host posts under the plugin's source
// with a key it makes from the thread: one flag per plugin and thread, as before. The
// until-seen mode is in the key, since nothing else on a notification can hold it; a
// plugin switching modes replaces one key with the other. The prefix is the host's: the
// plugin store refuses a plugin's own key that starts with it (pluginsdk.FlagKeyPrefix
// says the same to plugins).

// FlagKeyPrefix starts every flag key.
const FlagKeyPrefix = "flag:"

// flagSeenSuffix ends the key of an until-seen flag.
const flagSeenSuffix = ":until-seen"

// FlagKey is the key of a plugin's flag on thread id.
func FlagKey(threadID string, untilSeen bool) string {
	if untilSeen {
		return FlagKeyPrefix + threadID + flagSeenSuffix
	}
	return FlagKeyPrefix + threadID
}

// ParseFlagKey returns the thread and mode a flag key names; ok is false for any other
// key.
func ParseFlagKey(key string) (threadID string, untilSeen, ok bool) {
	rest, found := strings.CutPrefix(key, FlagKeyPrefix)
	if !found || rest == "" {
		return "", false, false
	}
	if id, seen := strings.CutSuffix(rest, flagSeenSuffix); seen {
		return id, true, id != ""
	}
	return rest, false, true
}

// IsFlag reports whether n was made from a plugin's thread flag.
func (n Notification) IsFlag() bool {
	_, _, ok := ParseFlagKey(n.Key)
	return ok && n.Source != SourceCommand
}

// FlagsOn returns the active flag notifications on thread id, source's only unless source
// is "", as snap orders them.
func FlagsOn(snap *Snapshot, threadID, source string) []Notification {
	var out []Notification
	for _, n := range snap.Notifications {
		id, _, ok := ParseFlagKey(n.Key)
		if ok && n.IsFlag() && id == threadID && (source == "" || n.Source == source) {
			out = append(out, n)
		}
	}
	return out
}

// DismissFlags dismisses the active flag notifications on thread id (source's only
// unless source is ""), as the user clearing them, and returns them dismissed.
func DismissFlags(ctx context.Context, s Store, threadID, source string) ([]Notification, error) {
	var out []Notification
	for _, n := range FlagsOn(s.Snapshot(), threadID, source) {
		d, err := s.Dismiss(ctx, n.ID)
		if err != nil {
			return out, err
		}
		out = append(out, d)
	}
	return out, nil
}
