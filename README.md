<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/jawfish-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/jawfish-logo-light.png">
    <img alt="Jawfish - A minimal package manager for your AI skills." src="./assets/jawfish-logo-light.png" height="320" style="margin-bottom: 20px;">
  </picture>
</div>

## What Is Jawfish?

Jawfish is a small package manager for reusable agentics:

1. Keep skills, prompts, and agents in one content library.
2. Install them globally or into a project.
3. Update them when upstream changes.

## Quick Start

Install:

```sh
bun install --global jawfish
```

Add a skill from a URL or local path:

```sh
jawfish add https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md
```

Jawfish creates `~/.jawfish/config.json` and a local content library at
`~/.jawfish/content-library` on first use.

Initialize first, if you want to choose defaults before adding:

```sh
jawfish init
```

Use an existing content library:

```sh
jawfish init git@github.com:you/agentics.git
```

Install everything from the manifest:

```sh
jawfish install
```

Update later:

```sh
jawfish update
```

## How It Works

Jawfish reads from one content library and writes tool-native files into the
current project or your global tool config.

Project installs are tracked in `jawfish.json`. Global installs are tracked in
`~/.jawfish/jawfish.json`.

## Commands

| Command                            | What it does                         |
| ---------------------------------- | ------------------------------------ |
| `jawfish add <name>`               | Install from your library            |
| `jawfish add <source>`             | Import from a URL or local file      |
| `jawfish init [content-library]`   | Create config and content library    |
| `jawfish import-skills <provider>` | Import global provider skills        |
| `jawfish install <name>`           | Same as `jawfish add <name>`         |
| `jawfish i <name>`                 | Same as `jawfish add <name>`         |
| `jawfish install`                  | Reinstall everything in the manifest |
| `jawfish i`                        | Same as `jawfish install`            |
| `jawfish update [name]`            | Pull upstream changes                |
| `jawfish upgrade`                  | Upgrade jawfish itself               |
| `jawfish remove <name>`            | Remove a managed install             |
| `jawfish --version`                | Print jawfish version                |
| `jawfish -v`                       | Same as `jawfish --version`          |

`import-skills` previews found skills and conflicts, then asks before writing.
Add `-y` or `--yes` to import without the prompt.

Add `--global` or `-g` to target your global tool config instead of the
current project.

Jawfish currently supports `codex`, `claude-code`, `hermes`, `openclaw`,
`opencode`, and `pi`.

`defaultTool` must be one of those supported tools. You can also set it with
`JAWFISH_DEFAULT_TOOL`.

`contentLibrary` is optional. If unset, Jawfish uses
`~/.jawfish/content-library`. You can also set it with
`JAWFISH_CONTENT_LIBRARY`.

Project installs go into `.codex/`, `.claude/`, `.hermes/`, `skills/`,
`.opencode/`, or `.pi/`.

Global installs go into:

| Tool          | Global root            |
| ------------- | ---------------------- |
| `codex`       | `~/.codex`             |
| `claude-code` | `~/.claude`            |
| `hermes`      | `~/.hermes`            |
| `openclaw`    | `~/.openclaw`          |
| `opencode`    | `~/.config/opencode`   |
| `pi`          | `~/.pi/agent`          |

## Develop

```sh
bun install
bun run typecheck
bun run test
```
