# OpenClaw Provider Design

## Scope

Add `openclaw` as a supported Jawfish tool target for skill packages.

## Destination Rules

- Project scope installs to `<project>/skills/<name>`.
- Global scope installs to `~/.openclaw/skills/<name>`.

These paths match OpenClaw's native skill install roots. Jawfish continues to
copy whole skill directories and write its managed marker inside the copied
package.

## Non-Goals

- No new prompt destination behavior.
- No new agent destination behavior.
- Prompt and agent packages fail clearly when targeting `openclaw`.
- No OpenClaw CLI integration.
- No changes to Jawfish's agentics model.

## Testing

Extend existing multi-tool install coverage so `openclaw` installs and removes a
catalog skill in both project and global scope. Update unsupported-tool error
expectations to include `openclaw`.
