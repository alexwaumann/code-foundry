package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
)

// Registry holds all commands. It is safe for concurrent use. Registration normally
// happens once at daemon startup; List and Invoke are called per request.
type Registry struct {
	mu   sync.RWMutex
	cmds map[string]*Command
	// ov adjusts registered commands (user settings); applied by List, Get, and Invoke.
	ov Overrides
}

// Overrides adjust registered commands without re-registering them. The daemon sets
// them from the user's settings.
type Overrides struct {
	// Keybindings replaces a command's default chords. An empty slice unbinds it.
	Keybindings map[string][]string
	// ArgDefaults replaces arg defaults: command name -> arg name -> default. A value
	// that does not parse for the arg is ignored; "" removes the default.
	ArgDefaults map[string]map[string]string
}

// SetOverrides replaces the registry's overrides.
func (r *Registry) SetOverrides(ov Overrides) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ov = ov
}

// effective returns c with overrides applied. r.mu must be held.
func (r *Registry) effective(c *Command) Command {
	out := *c
	if kb, ok := r.ov.Keybindings[c.Name]; ok {
		out.Keybindings = slices.Clone(kb)
	}
	if defs := r.ov.ArgDefaults[c.Name]; len(defs) > 0 {
		out.Args = slices.Clone(c.Args)
		for i, a := range out.Args {
			d, ok := defs[a.Name]
			if !ok || a.Required {
				continue
			}
			if d == "" {
				out.Args[i].Default = ""
			} else if _, err := a.parse(d); err == nil {
				out.Args[i].Default = d
			}
		}
	}
	return out
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{cmds: make(map[string]*Command)}
}

// Register adds cmd. It returns an error wrapping ErrInvalidCommand for a malformed
// command and ErrDuplicate when the name is taken.
func (r *Registry) Register(cmd Command) error {
	if err := cmd.validate(); err != nil {
		return err
	}
	cmd.Args = slices.Clone(cmd.Args)
	cmd.Keybindings = slices.Clone(cmd.Keybindings)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.cmds[cmd.Name]; ok {
		return fmt.Errorf("%w: %q", ErrDuplicate, cmd.Name)
	}
	r.cmds[cmd.Name] = &cmd
	return nil
}

// RegisterAll registers every command and returns all errors joined.
func (r *Registry) RegisterAll(cmds ...Command) error {
	var errs []error
	for _, c := range cmds {
		errs = append(errs, r.Register(c))
	}
	return errors.Join(errs...)
}

// Listed is a command as seen from a context.
type Listed struct {
	Command
	Available bool
}

// List returns the commands available in uctx, or all commands with Available filled
// in when includeUnavailable is set. Order is deterministic: category, title, name.
func (r *Registry) List(uctx Context, includeUnavailable bool) []Listed {
	r.mu.RLock()
	out := make([]Listed, 0, len(r.cmds))
	for _, c := range r.cmds {
		avail := c.Available(uctx)
		if avail || includeUnavailable {
			out = append(out, Listed{Command: r.effective(c), Available: avail})
		}
	}
	r.mu.RUnlock()
	slices.SortFunc(out, func(a, b Listed) int {
		return cmp.Or(cmp.Compare(a.Category, b.Category), cmp.Compare(a.Title, b.Title), cmp.Compare(a.Name, b.Name))
	})
	return out
}

// Get returns the command called name, with overrides applied.
func (r *Registry) Get(name string) (Command, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.cmds[name]
	if !ok {
		return Command{}, false
	}
	return r.effective(c), true
}

// Invoke validates raw args against the command's specs, checks availability, and runs
// it. Errors wrap ErrUnknownCommand, ErrInvalidArgs (*ArgError), or ErrUnavailable;
// anything else comes from Run. Checks run in this order: name, arg syntax,
// availability (with explicit context-bound args overlaid), required args,
// confirmation (*ConfirmError unless Confirmed(true) for a command with Confirm). Run
// sees the overlaid context.
func (r *Registry) Invoke(ctx context.Context, uctx Context, name string, raw map[string]string, opts ...InvokeOption) (Result, error) {
	var o invokeOptions
	for _, opt := range opts {
		opt(&o)
	}
	c, ok := r.Get(name)
	if !ok {
		return Result{}, fmt.Errorf("%w %q", ErrUnknownCommand, name)
	}
	args, eff, err := parseArgs(c.Args, raw, uctx)
	if err != nil {
		return Result{}, fmt.Errorf("%s: %w", name, err)
	}
	if !c.Available(eff) {
		return Result{}, fmt.Errorf("%s: %w", name, ErrUnavailable)
	}
	if err := checkRequired(c.Args, args); err != nil {
		return Result{}, fmt.Errorf("%s: %w", name, err)
	}
	if c.Confirm != "" && !o.confirmed {
		return Result{}, &ConfirmError{Command: name, Title: c.Title, Message: renderConfirm(c.Confirm, c.Args, args)}
	}
	return c.Run(ctx, eff, args)
}
