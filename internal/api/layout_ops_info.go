package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// A thread's info card op (internal/layout's info.go).
func init() {
	registerLayoutOp("set_info", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSetInfo()
		return &core.SetInfo{Thread: o.GetThreadId(), Open: o.GetOpen()}, nil
	})
}
