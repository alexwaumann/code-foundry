// Package plugintest provides fakes for code that consumes the plugin store: Fake, an
// in-memory plugin.Store for API handler tests (nothing runs), and Secrets, an in-memory
// plugin.SecretStore for store tests.
package plugintest

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Fake implements plugin.Store over a list of plugins the test sets with Put.
type Fake struct {
	bus *bus.Bus
	// Err, when set, is returned by every mutation.
	Err error

	mu      sync.Mutex
	plugins map[string]plugin.Plugin
	logs    map[string][]plugin.LogLine
	secrets map[string][]plugin.SecretInfo
	envs    map[string]plugin.Environment
	// Calls records mutations ("enable hello consent=true", "disable hello", …).
	calls []string
}

var _ plugin.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, plugins: map[string]plugin.Plugin{}, logs: map[string][]plugin.LogLine{}, secrets: map[string][]plugin.SecretInfo{}}
}

// Put adds or replaces a plugin and publishes Changed.
func (f *Fake) Put(p plugin.Plugin) {
	f.mu.Lock()
	f.plugins[p.Name] = p
	f.mu.Unlock()
	bus.Publish[plugin.Event](f.bus, plugin.Changed{Plugin: p})
}

// AddLog appends log lines.
func (f *Fake) AddLog(name string, lines ...plugin.LogLine) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs[name] = append(f.logs[name], lines...)
}

// PutSecret records a secret's name.
func (f *Fake) PutSecret(name, key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.secrets[name] = append(f.secrets[name], plugin.SecretInfo{Key: key, UpdatedAt: time.UnixMilli(1)})
}

// Calls returns the recorded mutations.
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Snapshot implements plugin.Store.
func (f *Fake) Snapshot() *plugin.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &plugin.Snapshot{}
	for _, p := range f.plugins {
		s.Plugins = append(s.Plugins, p)
	}
	slices.SortFunc(s.Plugins, func(a, b plugin.Plugin) int { return cmp.Compare(a.Name, b.Name) })
	return s
}

func (f *Fake) get(name string) (plugin.Plugin, error) {
	p, ok := f.plugins[name]
	if !ok {
		return plugin.Plugin{}, fmt.Errorf("%w: no plugin %q", plugin.ErrNotFound, name)
	}
	return p, nil
}

// Enable implements plugin.Store: consent is needed when Granted is nil.
func (f *Fake) Enable(_ context.Context, name string, consent bool) (plugin.EnableResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf("enable %s consent=%v", name, consent))
	if f.Err != nil {
		f.mu.Unlock()
		return plugin.EnableResult{}, f.Err
	}
	p, err := f.get(name)
	if err != nil {
		f.mu.Unlock()
		return plugin.EnableResult{}, err
	}
	if p.NeedsConsent && !consent {
		f.mu.Unlock()
		return plugin.EnableResult{Plugin: p, NeedsConsent: true, Consent: plugin.ConsentText(p.Manifest)}, nil
	}
	g := p.Manifest.Permissions
	p.Enabled, p.State, p.NeedsConsent, p.Granted = true, plugin.StateRunning, false, &g
	f.mu.Unlock()
	f.Put(p)
	return plugin.EnableResult{Plugin: p}, nil
}

func (f *Fake) mutate(call, name string, fn func(p *plugin.Plugin)) (plugin.Plugin, error) {
	f.mu.Lock()
	f.calls = append(f.calls, call+" "+name)
	if f.Err != nil {
		f.mu.Unlock()
		return plugin.Plugin{}, f.Err
	}
	p, err := f.get(name)
	if err != nil {
		f.mu.Unlock()
		return plugin.Plugin{}, err
	}
	fn(&p)
	f.mu.Unlock()
	f.Put(p)
	return p, nil
}

// Disable implements plugin.Store.
func (f *Fake) Disable(_ context.Context, name string) (plugin.Plugin, error) {
	return f.mutate("disable", name, func(p *plugin.Plugin) { p.Enabled, p.State = false, plugin.StateDisabled })
}

// Restart implements plugin.Store.
func (f *Fake) Restart(_ context.Context, name string) (plugin.Plugin, error) {
	return f.mutate("restart", name, func(p *plugin.Plugin) { p.State, p.Restarts, p.LastError = plugin.StateRunning, 0, "" })
}

// Dev implements plugin.Store: dir's last element is the plugin's name.
func (f *Fake) Dev(ctx context.Context, dir string, consent, dryRun, _ bool) (plugin.EnableResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf("dev %s consent=%v dry=%v", dir, consent, dryRun))
	f.mu.Unlock()
	name := lastElem(dir)
	if _, err := f.getLocked(name); err != nil {
		f.Put(plugin.Plugin{Name: name, Dev: true, DevPath: dir, State: plugin.StateDisabled, NeedsConsent: true,
			Manifest: pluginsdk.Manifest{Name: name, Version: "0.0.1", Protocol: 1, Exec: []string{"bin/" + name}}})
	}
	if dryRun {
		p, _ := f.getLocked(name)
		return plugin.EnableResult{Plugin: p, NeedsConsent: p.NeedsConsent, Consent: plugin.ConsentText(p.Manifest)}, nil
	}
	return f.Enable(ctx, name, consent)
}

func (f *Fake) getLocked(name string) (plugin.Plugin, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.get(name)
}

func lastElem(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

// Reload implements plugin.Store.
func (f *Fake) Reload(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "reload")
	return f.Err
}

// Logs implements plugin.Store.
func (f *Fake) Logs(name string, n int) ([]plugin.LogLine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.get(name); err != nil {
		return nil, err
	}
	l := f.logs[name]
	if n > 0 && n < len(l) {
		l = l[len(l)-n:]
	}
	return slices.Clone(l), nil
}

// FollowLogs implements plugin.Store: the recorded lines, then nothing until ctx ends.
func (f *Fake) FollowLogs(ctx context.Context, name string, n int) (<-chan plugin.LogLine, error) {
	lines, err := f.Logs(name, n)
	if err != nil {
		return nil, err
	}
	ch := make(chan plugin.LogLine, len(lines))
	for _, l := range lines {
		ch <- l
	}
	go func() {
		<-ctx.Done()
		close(ch)
	}()
	return ch, nil
}

// Secrets implements plugin.Store.
func (f *Fake) Secrets(_ context.Context, name string) ([]plugin.SecretInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.secrets[name]), nil
}

// DeleteSecret implements plugin.Store.
func (f *Fake) DeleteSecret(_ context.Context, name, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "delete-secret "+name+" "+key)
	list := f.secrets[name]
	i := slices.IndexFunc(list, func(s plugin.SecretInfo) bool { return s.Key == key })
	if i < 0 {
		return fmt.Errorf("%w: plugin %s has no secret %q", plugin.ErrNotFound, name, key)
	}
	f.secrets[name] = slices.Delete(list, i, i+1)
	return nil
}

// Secrets is an in-memory plugin.SecretStore.
type Secrets struct {
	mu   sync.Mutex
	vals map[string]string
	// Err, when set, is returned by every call.
	Err error
}

var _ plugin.SecretStore = (*Secrets)(nil)

// NewSecrets returns an empty store.
func NewSecrets() *Secrets { return &Secrets{vals: map[string]string{}} }

// Get implements plugin.SecretStore.
func (s *Secrets) Get(_ context.Context, p, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Err != nil {
		return "", false, s.Err
	}
	v, ok := s.vals[p+"/"+key]
	return v, ok, nil
}

// Set implements plugin.SecretStore.
func (s *Secrets) Set(_ context.Context, p, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Err != nil {
		return s.Err
	}
	s.vals[p+"/"+key] = value
	return nil
}

// Delete implements plugin.SecretStore.
func (s *Secrets) Delete(_ context.Context, p, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Err != nil {
		return s.Err
	}
	delete(s.vals, p+"/"+key)
	return nil
}
