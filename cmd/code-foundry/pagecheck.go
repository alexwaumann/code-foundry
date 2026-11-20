package main

import (
	"fmt"
	"os"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// cliOutput writes a file a command's result carries and takes it out of the result, before
// the result is printed: page.check --shot (docs/notes/page-self-check.md). The check's one
// render answers with its PNG in the result, so the CLI writes it as plugin surface --shot
// does, not the daemon, and --json prints the report without the bytes.
type cliOutput func(cl *cli, vals map[string]string, res *v1.InvokeCommandResponse) error

var cliOutputs = map[string]cliOutput{
	command.PageCheckVerb: writePageCheckShot,
}

// writePageCheckShot writes page.check's PNG to --shot. With no PNG in the result (none
// asked, or the app could not draw one: the message says why) it writes nothing.
func writePageCheckShot(cl *cli, vals map[string]string, res *v1.InvokeCommandResponse) error {
	path := vals["shot"]
	if path == "" || res.GetResultJson() == "" {
		return nil
	}
	var got v1.CheckPageResponse
	if err := protojson.Unmarshal([]byte(res.GetResultJson()), &got); err != nil {
		return fmt.Errorf("page.check: the result is not a check: %w", err)
	}
	if len(got.GetPng()) == 0 {
		return nil
	}
	if err := os.WriteFile(path, got.GetPng(), 0o644); err != nil {
		fmt.Fprintf(cl.stderr, "code-foundry page.check: no screenshot: %v\n", err)
		return errReported
	}
	got.Png = nil
	js, err := protojson.Marshal(&got)
	if err != nil {
		return err
	}
	res.ResultJson = string(js)
	return nil
}
