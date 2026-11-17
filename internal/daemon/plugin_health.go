package daemon

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// The daemon's own notifications about plugins that stopped (source "plugins", one per
// plugin keyed by its name; docs/notes/notifications-plugin-health.md): a plugin that
// failed for good, or one the daemon turned off, gets a card in the bell, and the card goes
// as soon as that no longer holds. The rules are pluginHealth's; the glue below applies them
// to the notification store on every plugin event. Neither store imports the other.

// pluginHealthStore is the part of the notification store the glue drives.
// *notification.Manager implements it.
type pluginHealthStore interface {
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
	Retire(ctx context.Context, source, key string) (bool, error)
	Keys(source string) []string
}

// healthKind is what one plugin's state asks of its card.
type healthKind int

const (
	// healthClear: nothing to report; a card goes (running, turned off by the user, never
	// enabled, gone).
	healthClear healthKind = iota
	// healthKeep: on its way somewhere (starting, a crash the store retries, stopping):
	// the card stays as it is, whichever way it is, so a restart that fails again does not
	// bring a fresh arrival and one that works withdraws it once running.
	healthKeep
	// healthPost: the user must act or know (failed for good, turned off by the daemon).
	healthPost
)

// healthVerdict is one plugin's verdict: its kind, and the notification for healthPost.
type healthVerdict struct {
	kind healthKind
	post notification.Post
}

// pluginHealth is what p's state asks for. Running clears. Turned off with a reason (the
// daemon's: its permissions grew) posts a warning; turned off without one (the user, or a
// plugin never enabled) clears. Enabled and failed (a bad manifest, an unsupported
// protocol, a missing executable, a newer Code Foundry needed, or crashed CrashLimit times
// in CrashWindow) posts an error. Anything else is on its way and keeps the card: in
// particular a crash (StateCrashed) never posts, since the store retries it within seconds
// and gives up into failed when it keeps crashing; a dev plugin never gives up, its author
// has its log. Failed without a reason is a restart on its way: the store publishes the
// re-read manifest before it starts the plugin, still failed but with the manifest's error
// gone.
func pluginHealth(p plugin.Plugin) healthVerdict {
	switch {
	case p.State == plugin.StateRunning:
		return healthVerdict{kind: healthClear}
	case !p.Enabled && p.DisabledReason != "":
		return healthVerdict{kind: healthPost, post: healthCard(p, notification.LevelWarning, "was turned off", p.DisabledReason,
			[]notification.ActionSpec{openPluginsAction})}
	case !p.Enabled:
		return healthVerdict{kind: healthClear}
	case p.State == plugin.StateFailed && strings.TrimSpace(p.LastError) != "":
		return healthVerdict{kind: healthPost, post: healthCard(p, notification.LevelError, "stopped", p.LastError,
			[]notification.ActionSpec{restartPluginAction(p.Name), openPluginsAction})}
	}
	return healthVerdict{kind: healthKeep}
}

// noResolve: neither button closes the card. Whether the plugin runs again decides: a
// restart that fails again leaves the card, one that works withdraws it.
var noResolve = new(false)

// openPluginsAction opens the settings page's plugins list, where the plugin's state, its
// log and Enable (with the consent to review) are.
var openPluginsAction = notification.ActionSpec{Action: notification.Action{
	Label: "Open plugins", Kind: notification.KindCommand, Command: "view.settings", Args: map[string]string{"page": "plugins"},
}, Resolves: noResolve}

func restartPluginAction(name string) notification.ActionSpec {
	return notification.ActionSpec{Action: notification.Action{
		Label: "Restart", Kind: notification.KindCommand, Command: "plugin.restart", Args: map[string]string{"name": name},
	}, Resolves: noResolve}
}

// healthCard is p's card: "<display name> <what>", the store's reason as the body.
func healthCard(p plugin.Plugin, level notification.Level, what, reason string, actions []notification.ActionSpec) notification.Post {
	name := clip(strings.Join(strings.FieldsFunc(p.DisplayName(), unicode.IsControl), " "), notification.MaxTitle-len(what)-1)
	return notification.Post{
		Source: notification.SourcePlugins, Key: p.Name, Level: level,
		Title: name + " " + what, Body: clip(sentence(reason), notification.MaxBody), Actions: actions,
	}
}

// sentence capitalizes the reason's first letter and drops control characters other
// than line breaks and tabs (the store's reasons quote a plugin's stderr).
func sentence(s string) string {
	s = strings.Map(func(r rune) rune {
		if r != '\n' && r != '\t' && (unicode.IsControl(r) || r == utf8.RuneError) {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// clip cuts s to at most max characters, ending in "…" when it cut.
func clip(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

// healthPlan is what the store must change for plugins, given keys, this source's keys
// whose notification is not withdrawn: the posts (the store makes an unchanged one a
// no-op) and the keys to retire (a cleared plugin's, or one no longer in the snapshot).
func healthPlan(plugins []plugin.Plugin, keys []string) (posts []notification.Post, retire []string) {
	seen := make(map[string]bool, len(plugins))
	for _, p := range plugins {
		seen[p.Name] = true
		switch v := pluginHealth(p); v.kind {
		case healthPost:
			posts = append(posts, v.post)
		case healthClear:
			if slices.Contains(keys, p.Name) {
				retire = append(retire, p.Name)
			}
		}
	}
	for _, k := range keys {
		if !seen[k] && !slices.Contains(retire, k) {
			retire = append(retire, k)
		}
	}
	return posts, retire
}

// reconcilePluginHealth brings the plugins source's notifications in line with snap.
func reconcilePluginHealth(ctx context.Context, log *slog.Logger, store pluginHealthStore, snap *plugin.Snapshot) {
	posts, retire := healthPlan(snap.Plugins, store.Keys(notification.SourcePlugins))
	for _, p := range posts {
		r, err := store.Post(ctx, p)
		switch {
		case err != nil:
			log.Warn("plugin health notification not posted", "plugin", p.Key, "err", err)
		case r.Outcome != notification.OutcomeUnchanged:
			log.Info("plugin health notification", "plugin", p.Key, "outcome", r.Outcome, "title", p.Title)
		}
	}
	for _, k := range retire {
		if ok, err := store.Retire(ctx, notification.SourcePlugins, k); err != nil {
			log.Warn("plugin health notification not withdrawn", "plugin", k, "err", err)
		} else if ok {
			log.Info("plugin health notification withdrawn", "plugin", k)
		}
	}
}

// healthMayChange: a plugin's state changed, one went, or the store resynced; not its
// facts, install progress or registry offers.
func healthMayChange(ev plugin.Event) bool {
	switch ev.(type) {
	case plugin.Changed, plugin.Removed, *plugin.Snapshot:
		return true
	}
	return false
}

// startPluginHealth reconciles once (the plugin store has started, so its snapshot holds
// every plugin: what holds is posted, the rest of the source's withdrawn), then after every
// change of a plugin's state, events that arrive together making one pass. Each pass reads the whole
// snapshot, so an event the bus dropped costs nothing. passed, when set, runs after each
// pass (tests wait on it). The returned func stops it.
func startPluginHealth(ctx context.Context, log *slog.Logger, b *bus.Bus, store pluginHealthStore, plugins func() *plugin.Snapshot, passed func()) func() {
	ctx, cancel := context.WithCancel(ctx)
	sub := bus.Subscribe[plugin.Event](b, 256)
	var wg sync.WaitGroup
	pass := func() {
		reconcilePluginHealth(ctx, log, store, plugins())
		if passed != nil {
			passed()
		}
	}
	wg.Go(func() {
		defer sub.Close()
		pass()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-sub.C():
				if !healthMayChange(ev) {
					continue
				}
			drain:
				for {
					select {
					case <-sub.C():
					default:
						break drain
					}
				}
				pass()
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
