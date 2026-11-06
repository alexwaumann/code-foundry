# Scopes

{{cf.provenance}}

How you act in the app everywhere is app memory (`memory add`). What spans a set of projects (a
product's repos) is the workspace's, in the folder after `WORKSPACE` in `code-foundry thread
checkouts`: instructions in `CLAUDE.md` (else `AGENTS.md`; a new file is `CLAUDE.md`), skills in
`.claude/skills/<name>/SKILL.md` (frontmatter `name`, `description`), written with your file tools.
One repo's is its own `CLAUDE.md`. Only your primary checkout's `CLAUDE.md` loads: read another
checkout's (INSTRUCTIONS column) before you edit there. A running thread loads them at its next start.
