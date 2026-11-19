package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

func init() {
	registerLayoutOp("conform", func(*v1.LayoutOp) (core.Op, error) { return &core.Conform{}, nil })
}
