# Code Foundry guide

<!-- The app's Help overlay shows this file from the first "## " heading on (Help >
Getting Started). Every button and shortcut it names must exist in the app. -->

## Getting started

A single surface for all your agents. Code Foundry runs coding agents (Claude Code
today) on the folders on your Mac, as many at once as you like, in one window.

Two words come up everywhere. A **project** is a folder on your Mac. A **thread** is
one conversation with an agent working in that folder. Threads keep running when you
close the window.

### Add a project

Click **New thread** at the top of the sidebar and pick **Add a project…** at the
bottom of the list, or click **Add project** on the Projects page. Then choose:

* **Local folder**: any folder in your home folder. A git repository works, and so
  does a plain folder.
* **GitHub**: copy a repository you have access to onto this Mac.
* **New**: start an empty project, and put it on GitHub if you like.

### Start a thread

Click **New thread** (<kbd>⌘N</kbd>), pick the project, type what you want and press
Enter. Paste or attach screenshots with the paperclip. Type <kbd>@</kbd> to mention a
file and <kbd>/</kbd> to run one of the project's skills or commands.

### Where changes go

**Work in**, under the prompt, decides where the thread edits files:

* **A fresh copy of the project** (the pill reads **Fresh copy**) gives the thread its
  own folder and branch, so several threads can work at once and you keep or discard
  each one. This is the default.
* **The project folder itself** (**In place**) edits your files where they are.

The app remembers your last choice for each project. Set the default for every project
under Settings › Sessions › **New threads work in**.

### While it runs

The sidebar lists your threads. A thread whose second line is amber is waiting on you:
a question, a permission, a plan to approve. Click it, answer, and it carries on. The
bell at the top of the sidebar and the badge on the Dock icon count what is waiting.

Closing the window stops nothing. Open the app again and every thread is where you
left it.

### Review and ship

The side panel (<kbd>⇧⌘E</kbd>) shows more about the selected thread: its copy of the
project (changes, commits and files), its pull requests, the agents it started and
what it cost. The bottom panel (<kbd>⌘J</kbd>) is a terminal in the thread's folder.

When the work is done, ask the agent to commit and open a pull request, or use
**Create Pull Request** from the command palette. The side panel follows its checks
and reviews.

### Find anything

<kbd>⌘K</kbd> opens the command palette: every action in the app, searchable by name.
<kbd>⌘/</kbd> opens this guide; its **Keyboard shortcuts** tab lists every shortcut.
The **Help** menu has this guide too, and a way to report a problem.

## Install on another Mac

You need a Mac with Apple silicon. In a terminal:

1. Install the GitHub CLI (`gh`) and sign in: `gh auth login`.
2. Install Claude Code and sign in once: run `claude`, then quit it.
3. Run the installer:
   `gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash`
4. Open a new terminal and run `code-foundry gui`.

The window opens like any app; keep it in the Dock. The
[README](https://github.com/alexwaumann/code-foundry#install) has the details and the
installer's options.

## Settings

Open Settings with <kbd>⌘,</kbd> or **Code Foundry › Settings…**. You can change the
default model and effort for new threads, where new threads work, the theme and zoom,
Dock alerts and sounds, and every keyboard shortcut. Each setting says what it does,
and the search box at the top finds one by name.
