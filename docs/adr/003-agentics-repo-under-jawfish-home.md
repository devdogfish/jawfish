# ADR 003: Agentics Repo Lives Under Jawfish Home

## Status

Accepted

## Context

Jawfish needs both machine-local state and a shareable agentics repo. The
default Jawfish home is `~/.jawfish`. It contains local config, the global
manifest, and other machine-specific files.

The agentics repo is git-backed and portable. It should be safe to reclone,
reset, or replace without deleting local config or install manifests.

## Decision

Use `~/.jawfish/agentics` as the default managed agentics repo path.
Keep `~/.jawfish` as Jawfish home/state, not as the agentics repo git repo.

Users can still point `agenticsRepo` or `JAWFISH_AGENTICS_REPO` at another
repo, such as `~/dev/agentics`, when actively editing a repo.

## Consequences

Machine-local files stay outside the agentics repo repository. `git status`
for the repo stays focused on portable catalog content.

Resetting or recloning the agentics repo does not remove `config.json` or the
global `jawfish.json` manifest.

The default layout is:

```txt
~/.jawfish/
  config.json
  jawfish.json
  agentics/
```
