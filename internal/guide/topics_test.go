package guide

import (
	"bytes"
	"strings"
	"testing"
)

func TestTopicName(t *testing.T) {
	for in, want := range map[string]string{"Action": "action", "Pull Request": "pull-request", " View ": "view"} {
		if got := TopicName(in); got != want {
			t.Errorf("TopicName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWriteTopic(t *testing.T) {
	cmds := registryCommands(t)
	var buf bytes.Buffer
	// Case and spaces as the category is written work too.
	if err := WriteTopic(&buf, cmds, "Pull Request"); err != nil {
		t.Fatal(err)
	}
	if out := buf.String(); !strings.Contains(out, "## Pull Request") || !strings.Contains(out, "- `pr.merge") || strings.Contains(out, "`thread.new") {
		t.Errorf("topic pull-request:\n%s", out)
	}
	// The thread topic has its conventions, then its commands in full.
	buf.Reset()
	if err := WriteTopic(&buf, cmds, "thread"); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if i, j := strings.Index(out, "## Conventions"), strings.Index(out, "## Thread\n"); i < 0 || j < i || !strings.Contains(out, "- `thread.new") {
		t.Errorf("topic thread:\n%s", out)
	}
	// So has the layout topic, with the verbs that arrange the window.
	buf.Reset()
	if err := WriteTopic(&buf, cmds, "layout"); err != nil {
		t.Fatal(err)
	}
	out = buf.String()
	if i, j := strings.Index(out, "Never move the user's focus"), strings.Index(out, "## Layout\n"); i < 0 || j < i ||
		!strings.Contains(out, "- `layout.show") || !strings.Contains(out, "- `tab.move") || !strings.Contains(out, "- `thread.open") {
		t.Errorf("topic layout:\n%s", out)
	}
	for _, name := range []string{"bogus", "plugin", "skill"} {
		buf.Reset()
		err := WriteTopic(&buf, cmds, name)
		if err == nil || !strings.Contains(err.Error(), "topics: thread, action, workspace, project") || buf.Len() != 0 {
			t.Errorf("WriteTopic(%q) = %v, wrote %d bytes; want an error naming the topics", name, err, buf.Len())
		}
	}
}
