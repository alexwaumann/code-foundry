package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The terminals' ops (internal/layout's terminals.go).
func init() {
	registerLayoutOp("set_quick", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSetQuick()
		return &core.SetQuick{Thread: o.GetThreadId(), Open: o.GetOpen(), Height: o.GetHeight(), ForgetRan: o.GetForgetRan()}, nil
	})
	registerLayoutOp("replace_terminal", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetReplaceTerminal()
		return &core.ReplaceTerminal{Old: o.GetOldId(), New: o.GetNewId()}, nil
	})
	registerLayoutOp("drop_terminal", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.DropTerminal{Terminal: m.GetDropTerminal().GetTerminalId()}, nil
	})
}
