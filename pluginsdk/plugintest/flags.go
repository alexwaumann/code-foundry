package plugintest

//lint:file-ignore SA1019 the fake host serves the deprecated thread/setFlag as the host does (pluginsdk/removals.go)

import (
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Thread flags (thread/setFlag, deprecated; pluginsdk.Removals): as on the host, a flag
// is a notification naming its thread under the key flag:<thread> (flag:<thread>:until-seen
// for an until-seen one), warning for attention and error for error, the reason its
// title. FlagNone withdraws it. SeeThread is the user opening the thread: its until-seen
// flags are dismissed. The fake has no notion of a thread being open when the flag is
// set, so an until-seen flag always shows until SeeThread.

const flagSeenSuffix = ":until-seen"

func flagKey(thread string, untilSeen bool) string {
	if untilSeen {
		return pluginsdk.FlagKeyPrefix + thread + flagSeenSuffix
	}
	return pluginsdk.FlagKeyPrefix + thread
}

// flagNote is the notification the host makes of f.
func (h *Host) flagNote(f pluginsdk.Flag) pluginsdk.Notification {
	level := pluginsdk.NotifyWarning
	if f.Level == pluginsdk.FlagError {
		level = pluginsdk.NotifyError
	}
	title := strings.TrimSpace(f.Reason)
	if title == "" {
		title = h.opts.Name + " flagged this thread"
	}
	return pluginsdk.Notification{Key: flagKey(f.ThreadID, f.UntilSeen), Level: level, Title: title, ThreadID: f.ThreadID}
}

// setFlag serves thread/setFlag (permission checked).
func (h *Host) setFlag(f pluginsdk.Flag) (pluginsdk.FlagResult, error) {
	invalid := func(format string, a ...any) error {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, pluginsdk.MethodThreadSetFlag+": "+format, a...)
	}
	reason := strings.TrimSpace(f.Reason)
	switch {
	case f.ThreadID == "":
		return pluginsdk.FlagResult{}, invalid("threadId is required")
	case f.Level != pluginsdk.FlagAttention && f.Level != pluginsdk.FlagError && f.Level != pluginsdk.FlagNone:
		return pluginsdk.FlagResult{}, invalid("level is attention, error or none, not %q", f.Level)
	case f.Level != pluginsdk.FlagNone && strings.ContainsAny(reason, "\r\n"):
		return pluginsdk.FlagResult{}, invalid("a flag's reason is one line")
	case f.Level != pluginsdk.FlagNone && utf8.RuneCountInString(reason) > 80:
		return pluginsdk.FlagResult{}, invalid("a flag's reason is at most 80 characters")
	}
	h.record(func() { h.flags = append(h.flags, f) })
	changed := false
	withdraw := func(key string) {
		h.record(func() {
			if r := h.notes.byKey[key]; r != nil && r.active() {
				r.status, changed = StatusWithdrawn, true
			}
		})
	}
	if f.Level == pluginsdk.FlagNone {
		withdraw(flagKey(f.ThreadID, false))
		withdraw(flagKey(f.ThreadID, true))
		return pluginsdk.FlagResult{Changed: changed}, nil
	}
	withdraw(flagKey(f.ThreadID, !f.UntilSeen))
	if res := h.applyNote(h.flagNote(f), false); res.Outcome != pluginsdk.NotifyUnchanged {
		changed = true
	}
	return pluginsdk.FlagResult{Changed: changed}, nil
}

// seedFlags makes the flags initialize reports active notifications, before the plugin
// starts.
func (h *Host) seedFlags(flags []pluginsdk.Flag) {
	for _, f := range flags {
		if f.ThreadID != "" && f.Level != pluginsdk.FlagNone {
			h.applyNote(h.flagNote(f), false)
		}
	}
}

// SeeThread is the user opening thread id: its until-seen flags' notifications are
// withdrawn, as the host withdraws them (the same flag raised again shows again).
func (h *Host) SeeThread(id string) {
	h.record(func() {
		if r := h.notes.byKey[flagKey(id, true)]; r != nil && r.active() {
			r.status = StatusWithdrawn
		}
	})
}
