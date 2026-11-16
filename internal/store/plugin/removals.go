package plugin

import "github.com/alexwaumann/code-foundry/pluginsdk"

// The SDK's removal list (pluginsdk.Removals) on the host's side: a plugin calling a
// deprecated protocol method is served, and its log says once per run what replaces the
// method; a retired one is answered without acting (an empty result for a request,
// nothing for a notification), logged once per run, so an old plugin binary neither
// breaks nor seems to work.

// removal logs, once per run, that the plugin called a method on the removal list, and
// reports whether it is retired (the caller answers without acting).
func (a *actor) removal(method string) (retired bool) {
	r, ok := pluginsdk.RemovalOfMethod(method)
	if !ok {
		return false
	}
	a.mu.Lock()
	first := !a.removalsLogged[method]
	if a.removalsLogged != nil {
		a.removalsLogged[method] = true
	}
	a.mu.Unlock()
	if first {
		a.hostLogAt("warn", "%s", r.Notice())
	}
	return r.Stage == pluginsdk.StageRetired
}
