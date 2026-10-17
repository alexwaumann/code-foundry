package threadtest

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// createMetadata validates Create's metadata like the store and sets it on s: the
// creator must be a thread of the fake (its name, else its id, becomes CreatedByName).
// The call gains " created-by=<id>", " brief=<text>", " labels=<a,b>" and
// " budget=<usd>" when set. No note is written: tests PutItems what they need.
func (f *Fake) createMetadata(s *thread.Thread, o thread.CreateOptions, call *string) error {
	brief, err := thread.CleanBrief(o.Brief)
	if err != nil {
		return err
	}
	labels, err := thread.CleanLabels(o.Labels)
	if err != nil {
		return err
	}
	if err := thread.CheckBudget(o.BudgetUSD); err != nil {
		return err
	}
	if id := strings.TrimSpace(o.CreatedBy); id != "" {
		f.mu.Lock()
		c, ok := f.byID[id]
		f.mu.Unlock()
		if !ok {
			return fmt.Errorf("%w: created by %s: no such thread", thread.ErrInvalidArgument, id)
		}
		s.CreatedBy, s.CreatedByName = id, c.Name
		if s.CreatedByName == "" {
			s.CreatedByName = id
		}
		*call += " created-by=" + id
	}
	s.Brief, s.Labels, s.BudgetUSD = brief, labels, o.BudgetUSD
	if brief != "" {
		*call += " brief=" + brief
	}
	if len(labels) > 0 {
		*call += " labels=" + strings.Join(labels, ",")
	}
	if o.BudgetUSD > 0 {
		*call += " budget=" + strconv.FormatFloat(o.BudgetUSD, 'f', -1, 64)
	}
	return nil
}

// Label records "Label <id> add=<a,b> remove=<c> clear=<bool>" and edits the labels
// like the store (thread.EditLabels).
func (f *Fake) Label(_ context.Context, id string, add, remove []string, clear bool) (thread.Thread, error) {
	call := fmt.Sprintf("Label %s add=%s remove=%s clear=%t", id, strings.Join(add, ","), strings.Join(remove, ","), clear)
	return f.mutate(call, id, func(s *thread.Thread) error {
		labels, err := thread.EditLabels(s.Labels, add, remove, clear)
		if err != nil {
			return err
		}
		s.Labels = labels
		return nil
	})
}

// Report records "Report <id> <status> <summary>" and sets the report like the store
// (thread.CleanReport), stamped with Now.
func (f *Fake) Report(_ context.Context, id string, r thread.Report) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("Report %s %s %s", id, r.Status, r.Summary), id, func(s *thread.Thread) error {
		r, err := thread.CleanReport(r)
		if err != nil {
			return err
		}
		r.At = f.Now()
		s.Report = r
		return nil
	})
}

// SetBudget records "SetBudget <id> <usd>" and sets BudgetUSD, re-arming the stop
// (BudgetHitUSD 0) when the budget is 0 or above the thread's cost, like the store.
func (f *Fake) SetBudget(_ context.Context, id string, usd float64) (thread.Thread, error) {
	return f.mutate("SetBudget "+id+" "+strconv.FormatFloat(usd, 'f', -1, 64), id, func(s *thread.Thread) error {
		if err := thread.CheckBudget(usd); err != nil {
			return err
		}
		if usd == 0 || usd > thread.UsageCost(s.Usage) {
			s.BudgetHitUSD = 0
		}
		s.BudgetUSD = usd
		return nil
	})
}
