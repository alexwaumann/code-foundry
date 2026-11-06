#!/usr/bin/env python3
"""The scorer's tests: python3 scripts/guide-eval/score_test.py. Not part of make check."""
import json
import unittest

import score

FILES = {"code-foundry/SKILL.md": 2700}


def tool(name, inp, output="", is_error=False):
    return {"toolCall": {"name": name, "inputJson": json.dumps(inp), "output": output, "isError": is_error}}


def bash(command, output="", is_error=False):
    return tool("Bash", {"command": command}, output, is_error)


def turn(cost):
    return {"turnEnd": {"turnCostUsd": cost}}


class Calls(unittest.TestCase):
    def test_calls(self):
        cases = [
            ("code-foundry thread subscribe --at 2h", ["thread.subscribe --at 2h"]),
            ("code-foundry thread.subscribe --at 2h", ["thread.subscribe --at 2h"]),
            ("cd x && code-foundry usage.show | head; code-foundry help thread.new", ["usage.show", "help.thread.new"]),
            # A plain positional word joins the verb: the tasks' regexes end in \\b, so it does no harm.
            ("/a/bin/code-foundry memory add \\\n  hello", ["memory.add.hello"]),
            ("git -C ~/code-foundry-x log; ls code-foundry-pages", []),
            ("cd code-foundry/ && ls", []),
            ("code-foundry view.inline /tmp/a.html --title x", ["view.inline /tmp/a.html --title x"]),
            ("cat > README.md <<'E'\nrun code-foundry plugin dev here\nE\ncode-foundry plugin list", ["plugin.list"]),
            ("code-foundry memory add - <<E\ncode-foundry usage.show\nE", ["memory.add - <<E"]),
            ("echo 'see `code-foundry plugin dev`'", []),
        ]
        for command, want in cases:
            self.assertEqual(score.calls(command), want, command)

    def test_is_help(self):
        for call, want in [("help.view.inline", True), ("thread.new --help", True), ("thread.new -h", True),
                           ("thread.new --prompt help", False), ("thread.search --helpful", False)]:
            self.assertEqual(score.is_help(call), want, call)


class Run(unittest.TestCase):
    task = {"id": "p1", "skill": "code-foundry", "verb": r"^thread\.subscribe\b.*--at\b"}

    def test_right_route(self):
        r = score.score_run(self.task, [tool("Skill", {"skill": "code-foundry"}), bash("code-foundry thread subscribe --at 2h"), turn(0.25)], [], FILES)
        self.assertTrue(r["skill_ok"])
        self.assertTrue(r["verb_ok"])
        self.assertEqual((r["wrong_turns"], r["guidance_bytes"], r["cost"]), (0, 2700, 0.25))

    def test_help_for_the_verb_is_no_hit(self):
        r = score.score_run(self.task, [bash("code-foundry thread subscribe --at --help", "usage text")], [], FILES)
        self.assertFalse(r["verb_ok"])
        self.assertEqual((r["help"], r["wrong_turns"], r["guidance_bytes"]), (1, 1, 10))

    def test_wrong_turns(self):
        items = [
            tool("ToolSearch", {"query": "select:Monitor,CronCreate"}),
            tool("ToolSearch", {"query": "select:WebFetch"}),
            bash("code-foundry view.inline /tmp/a; echo exit=$?", "code-foundry view.inline: outside your home directory\nexit=2"),
            bash("code-foundry thread.bogus", "code-foundry: unknown command", True),
            bash("code-foundry thread new --bogus", "flag provided but not defined: -bogus\nRun `code-foundry help thread.new` for usage"),
            # Failed, but not the CLI's doing: the exit status is defaults'.
            bash("code-foundry theme show x; defaults read y", "{}\nDomain y does not exist", True),
        ]
        r = score.score_run(self.task, items, [], FILES)
        self.assertEqual((len(r["failed"]), r["fetches"], r["wrong_turns"]), (3, 1, 4))

    def test_allowed_failure(self):
        task = {"id": "p8", "verb": r"^pr\.create\b", "allow_fail": "not on GitHub"}
        items = [bash("code-foundry pr.create --body x", "code-foundry pr.create: not available in this context: repository is not on GitHub")]
        r = score.score_run(task, items, [], FILES)
        self.assertTrue(r["verb_ok"])
        self.assertIsNone(r["skill_ok"])
        self.assertEqual(r["wrong_turns"], 0)
        # Any other failure of the same verb is a wrong turn.
        items.append(bash("code-foundry pr.create --body x", "code-foundry pr.create: missing --worktree"))
        self.assertEqual(score.score_run(task, items, [], FILES)["wrong_turns"], 1)

    def test_answer_stands_in_for_a_verb(self):
        task = {"id": "t1", "verb": r"^settings\.", "answer": "default.worktree"}
        said = {"assistantText": {"text": "Set threads.default_worktree."}}
        self.assertTrue(score.score_run(task, [said], [], FILES)["verb_ok"])
        self.assertFalse(score.score_run(task, [{"assistantText": {"text": "No idea."}}], [], FILES)["verb_ok"])

    def test_guidance_and_skill_by_reading(self):
        items = [
            tool("Read", {"file_path": "/h/claude/.claude/skills/code-foundry/SKILL.md"}, "x" * 100),
            bash("sed -n 1,9p /h/claude/.claude/skills/code-foundry/reference/a.md", "y" * 50),
            bash("code-foundry guide", "z" * 30),
            bash("code-foundry daemon.capabilities --group build", "w" * 20),
            bash("ls", "ignored"),
        ]
        r = score.score_run(self.task, items, [], FILES)
        self.assertTrue(r["skill_ok"])
        self.assertEqual((r["guidance_bytes"], r["guide"], r["caps"], len(r["reads"])), (200, 1, 1, 2))

    def test_routing_is_the_root_threads_cost_is_the_trees(self):
        child = [tool("Skill", {"skill": "code-foundry"}), bash("code-foundry thread subscribe --at 2h"), turn(0.5)]
        r = score.score_run(self.task, [turn(0.25)], [child], FILES)
        self.assertFalse(r["skill_ok"])
        self.assertFalse(r["verb_ok"])
        self.assertEqual((r["cost"], r["guidance_bytes"], r["threads"]), (0.75, 2700, 2))


def report(skill=9, verb=9, guidance=5000, runs=3, invalid=0, claude="1", label="x"):
    return {"meta": {"label": label, "model": "m", "effort": "medium", "claude": claude}, "always_tokens": 1000,
            "totals": dict(skill_hits=skill, verb_hits=verb, guidance_tokens_mean=guidance, loaded_tokens_mean=guidance - 1000,
                           wrong_turns=2, failed_cli=1, help_hops=1, fetches=0, cost=5.0, invalid=invalid),
            "tasks": {"a": dict(runs=runs, skill=skill, verb=verb)}}


class Gate(unittest.TestCase):
    def test_gate(self):
        cases = [
            ("fewer tokens, same routing", report(), report(guidance=4900), True, ""),
            ("better routing, fewer tokens", report(), report(skill=9, verb=9, guidance=1), True, ""),
            ("routing drop", report(), report(skill=8, guidance=4000), False, "routing dropped"),
            ("verb drop", report(), report(verb=8, guidance=4000), False, "correct verbs dropped"),
            ("no fewer tokens", report(), report(), False, "did not fall"),
            ("one run is too noisy", report(runs=1), report(runs=1, guidance=4000), False, "under 3 runs"),
            ("run counts differ", report(), report(runs=4, guidance=4000), False, "ran 3 and 4"),
            ("invalid runs", report(), report(guidance=4000, invalid=1), False, "invalid"),
            ("another claude", report(), report(guidance=4000, claude="2"), False, "claude differs"),
        ]
        for name, before, after, want, why in cases:
            text, ok = score.compare(before, after)
            self.assertEqual(ok, want, name)
            self.assertIn(why, text, name)


if __name__ == "__main__":
    unittest.main()
