package threadtest

import (
	"context"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetFlag records "SetFlag <id> <source> <level> <reason>" and replaces (or with
// FlagNone removes) the source's flag, stamped with Now. No archive, viewer or
// validation rules beyond the reason's: tests of those use the store.
func (f *Fake) SetFlag(_ context.Context, id string, fl thread.Flag) (thread.Thread, bool, error) {
	changed := false
	s, err := f.mutate(fmt.Sprintf("SetFlag %s %s %s %s", id, fl.Source, fl.Level, fl.Reason), id, func(s *thread.Thread) error {
		if fl.Level != thread.FlagNone {
			r, err := thread.CleanFlagReason(fl.Reason)
			if err != nil {
				return err
			}
			fl.Reason, fl.SetAt = r, f.Now()
		}
		flags := slices.DeleteFunc(slices.Clone(s.Flags), func(x thread.Flag) bool { return x.Source == fl.Source })
		changed = len(flags) != len(s.Flags) || fl.Level != thread.FlagNone
		if fl.Level != thread.FlagNone {
			flags = append(flags, fl)
		}
		s.Flags = flags
		return nil
	})
	return s, changed, err
}

// ClearFlags records "ClearFlags <id> <source>" and removes the source's flag, or every
// flag with source "".
func (f *Fake) ClearFlags(_ context.Context, id, source string) (thread.Thread, int, error) {
	n := 0
	s, err := f.mutate(fmt.Sprintf("ClearFlags %s %s", id, source), id, func(s *thread.Thread) error {
		flags := slices.DeleteFunc(slices.Clone(s.Flags), func(x thread.Flag) bool { return source == "" || x.Source == source })
		n = len(s.Flags) - len(flags)
		s.Flags = flags
		return nil
	})
	return s, n, err
}
