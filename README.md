# agentics-cli

Small CLI for installing and managing reusable agentics: skills, agents, and prompts.

## Install

From this checkout:

```sh
bun install
bun link
```

Verify:

```sh
agentics --version
agentics --help
```

## Config

Config lives at:

```sh
~/.agentics/config.json
```

Codex-only macOS config:

```json
{
  "allowedTools": ["codex"],
  "defaultTool": "codex",
  "contentLibrary": "/Users/devdogfish/.agentics/library"
}
```

Agentics installed globally for Codex go under:

```sh
~/.codex/skills
~/.codex/agents
~/.codex/prompts
```

Project installs go under the current repo's `.codex/` folder.

## Usage

Add from a catalog entry:

```sh
agentics add handoff
```

Import from a URL or local path:

```sh
agentics add https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md
agentics add ./path/to/SKILL.md
```

Install globally:

```sh
agentics add -g handoff
```

Reinstall manifest entries:

```sh
agentics install
agentics install -g
```

Update upstream-backed agentics:

```sh
agentics update
agentics update handoff
agentics update -g handoff
```

Remove:

```sh
agentics remove handoff
agentics remove -g handoff
```

## Development

```sh
bun run typecheck
bun run test
```
