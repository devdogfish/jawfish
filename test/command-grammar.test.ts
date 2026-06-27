import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCommandHelp,
  formatRootHelp,
  parseCommand,
} from "../src/command-grammar.ts";

describe("command grammar", () => {
  test("routes install aliases by target presence", () => {
    assert.deepEqual(parseCommand(["install", "focus"]), {
      args: {
        force: false,
        global: false,
        help: false,
        positionals: ["focus"],
        raw: false,
        yes: false,
      },
      command: "install",
      handler: "add",
      kind: "dispatch",
    });

    assert.deepEqual(parseCommand(["i"]), {
      args: {
        force: false,
        global: false,
        help: false,
        positionals: [],
        raw: false,
        yes: false,
      },
      command: "i",
      handler: "install",
      kind: "dispatch",
    });
  });

  test("owns root help, command help, and version requests", () => {
    assert.deepEqual(parseCommand([]), { kind: "root-help" });
    assert.deepEqual(parseCommand(["--version"]), { kind: "version" });
    assert.deepEqual(parseCommand(["list", "--help"]), {
      command: "list",
      kind: "command-help",
    });

    assert.match(formatRootHelp("0.0.0"), /Usage: jawfish <command>/);
    assert.match(formatRootHelp("0.0.0"), /-v, --version\s+Show version/);
    assert.match(
      formatCommandHelp("list"),
      /--installed <status>\s+Filter by project, global, both, none, or any/,
    );
  });

  test("rejects command grammar errors before dispatch", () => {
    assert.throws(
      () => parseCommand(["bogus"]),
      /Unknown command: bogus\nRun jawfish --help for usage\./,
    );
    assert.throws(
      () => parseCommand(["update", "--yes"]),
      /Unsupported option: --yes\nUsage: jawfish update \[options\] \[name\]/,
    );
    assert.throws(
      () => parseCommand(["remove"]),
      /Usage: jawfish remove \[options\] <name>/,
    );
    assert.throws(
      () => parseCommand(["list", "--type", "script"]),
      /Unsupported type: script\. Supported types: skill, agent, prompt/,
    );
  });
});
