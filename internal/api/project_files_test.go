package api

import (
	"bytes"
	"encoding/json"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The JSON plugins and `code-foundry events --json` read.
func TestWorktreeFilesEventJSON(t *testing.T) {
	tests := []struct {
		name string
		ev   project.WorktreeFilesChanged
		want string
	}{
		{"every op", project.WorktreeFilesChanged{ProjectID: "p1", Path: "/code/a", Files: []project.ChangedFile{
			{Path: "a.go", Op: project.FileCreated}, {Path: "b.go", Op: project.FileModified},
			{Path: "c.go", Op: project.FileRemoved}, {Path: "pkg/", Op: project.FileRenamed},
		}}, `{"worktreeFilesChanged":{"projectId":"p1","path":"/code/a","files":[` +
			`{"path":"a.go","op":"FILE_OP_CREATED"},{"path":"b.go","op":"FILE_OP_MODIFIED"},` +
			`{"path":"c.go","op":"FILE_OP_REMOVED"},{"path":"pkg/","op":"FILE_OP_RENAMED"}]}}`},
		{"truncated, no files", project.WorktreeFilesChanged{ProjectID: "p1", Path: "/code/a", Truncated: true},
			`{"worktreeFilesChanged":{"projectId":"p1","path":"/code/a","truncated":true}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := eventToProto(tt.ev)
			if msg == nil {
				t.Fatal("not mapped")
			}
			b, err := protojson.Marshal(msg)
			if err != nil {
				t.Fatal(err)
			}
			// protojson's spacing is unstable on purpose: compare after a round trip
			// through the compact form.
			if got := compactJSON(t, b); got != tt.want {
				t.Errorf("JSON =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}

func compactJSON(t *testing.T, b []byte) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}
