# Provider Skill Import Notes

## MVP

Command:

```sh
jawfish import-skills <provider>
jawfish import-skills <provider> -y
jawfish import-skills <provider> --yes
```

Scope:

- Source: global provider skill dirs only.
- Providers: all supported tools.
- Type: skills only.
- Default: preview, then confirmation prompt.
- Writes: require prompt confirmation or `-y`/`--yes`.
- Target: agentics repo plus global `jawfish.json`.
- Adoption: imported global files become Jawfish-managed.
- Conflicts: skip existing catalog names and report them.

## Rationale

`migrate` is too ambiguous. This feature imports existing skills into Jawfish; it
does not move the user from one provider to another or promise full provider
conversion.

Preview plus confirmation is better because global provider dirs may contain
personal, stale, or experimental skills. Bulk writes should be explicit, and
`-y`/`--yes` gives scripts a fast path.

## Future Work

- Project provider dirs.
- Agents and prompts.
- Rename or overwrite conflict modes.
- `--from` and `--to` rematerialization between providers.
- Interactive selection.
- JSON preview output for scripting.
