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
	for _, name := range []string{"thread", "bogus", "plugin", "skill"} {
		buf.Reset()
		err := WriteTopic(&buf, cmds, name)
		if err == nil || !strings.Contains(err.Error(), "topics: action, workspace, project") || buf.Len() != 0 {
			t.Errorf("WriteTopic(%q) = %v, wrote %d bytes; want an error naming the topics", name, err, buf.Len())
		}
	}
	var guide bytes.Buffer
	Write(&guide, cmds, "")
	// The topic list grows by a command's name per new command outside Thread (the user
	// themes' four verbs took it from 25,000 to 25,054, composer.stage and theme.reset to
	// 25,532, project.rename to 25,614, pr.task to 25,657, pr.ready, pr.draft, pr.auto-merge
	// and the detailed thread.pr.link to 25,888); the hard limit is guide_test's 29,000. Thread
	// commands are detailed: thread.search (docs/notes/search-3-index.md), which agents use
	// to find earlier work, took it to 26,700, thread.find and its next and previous to
	// 26,759, file.save to 26,809, thread.setup.retry, cancel and discard to 27,380,
	// thread.compact to 27,476, terminal.find and its next and previous and the clauses on a
	// thread putting itself away to 27,611.
	if n := guide.Len(); n > 27_700 {
		t.Errorf("the guide has %d bytes after the split", n)
	}
}
