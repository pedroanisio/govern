---
title: Getting started
description: Install govern and move your first software lane through a check.
section: docs
---

Use Node 24 or later and a POSIX shell. No package installation or contributor setup is needed to run govern.

## Put govern on your path

Either unpack a govern release archive or check out super-tools. In the unpacked archive's top folder, or the super-tools checkout's top folder, run:

```sh
export PATH="$PWD/bin:$PATH"
govern version
```

Keep that folder: the launcher reads `tools/govern` beside `bin`. Add its absolute `bin` path to your shell's PATH configuration to keep using it in new terminals. The checkout's `setup.sh` is optional for govern; `setup.sh --path-only` adds that PATH entry without creating the contributor venv.

## Create a workspace and a lane

The remaining commands run in a new `my-work` folder in your home directory. Choose a different new folder name if it already exists. `govern init` creates `.govern/`; `--nested` explicitly permits this new workspace even if the chosen parent already belongs to one.

```sh
cd "$HOME"
mkdir my-work
cd my-work
govern init --nested
govern new first-change --process dev --title 'Create a greeting'
govern work first-change plan
govern note first-change 'Plan: create greeting.txt containing hello; check its contents with Node; risk: wrong text'
govern advance first-change --note 'The change, check and risk are recorded'
```

Your lane is now in `build`. Its files live in `.govern/projects/first-change`. The built-in `dev` process uses a command named `test` as the exit check for its `test` stage. This small example needs only Node:

```sh
govern cmd first-change test -- node -e 'const fs = require("node:fs"); require("node:assert/strict").equal(fs.readFileSync("greeting.txt", "utf8"), "hello\n")'
if govern run first-change test; then
  echo 'Expected the check to fail before greeting.txt exists' >&2
  exit 1
fi
printf 'hello\n' > .govern/projects/first-change/greeting.txt
govern run first-change test
govern advance first-change --note 'The check failed before the file existed and passes with the greeting'
govern check first-change
govern advance first-change
govern brief first-change
```

The lane is now in `review`. The last advance reran the check: a failing check holds the lane. For real work, name your project's actual test command and record evidence you have verified. Review the result before moving to `done`; see [lanes and processes](/docs/lanes-and-processes/) for gates and dependencies.

## Optional: Claude Code integration

For Claude Code, `govern install-skill` is optional. Run it in the workspace to link its `.claude/skills/govern` to the installation and print the hook lines you can add. It is unnecessary for the commands above. An existing real skill directory is refused unless you explicitly request replacement.

Use `govern desk` for an overview and `govern brief first-change` to resume this lane. Read [the queue guide](/docs/queue/) before handing work to a runner.
