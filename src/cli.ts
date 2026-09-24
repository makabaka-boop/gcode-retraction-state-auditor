#!/usr/bin/env node
/**
 * motion-audit command line entry point.
 *
 * Usage:
 *   motion-audit <file.gcode> <threshold-in-thousandths>
 *
 * Exit codes:
 *   0 - program is clean
 *   2 - first UNPROTECTED_TRAVEL found (report printed as JSON)
 *   1 - malformed input, file/argument problem, or file longer than 10000 lines
 */

import { readFileSync } from "node:fs";

import { auditLines, MAX_LINES } from "./audit.js";

export interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliDeps {
  readFile?: (path: string) => string;
}

export function runCli(
  argv: readonly string[],
  deps: CliDeps = {},
): CliOutput {
  const usage = "usage: motion-audit <file.gcode> <threshold-thousandths>";

  if (argv.length !== 2) {
    return { exitCode: 1, stdout: "", stderr: `${usage}\n` };
  }
  const [filePath, thresholdText] = argv as [string, string];

  // Threshold: a positive integer, already expressed in thousandths.
  if (!/^\d+$/.test(thresholdText)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: threshold '${thresholdText}' must be a positive integer (thousandths)\n`,
    };
  }
  const threshold = Number(thresholdText);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: threshold '${thresholdText}' must be a positive integer (thousandths)\n`,
    };
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let content: string;
  try {
    content = readFile(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: cannot read ${filePath}: ${message}\n`,
    };
  }

  // Physical lines; a single trailing newline does not create an extra line.
  const stripped = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = stripped.length === 0 ? [] : stripped.split(/\r\n|\r|\n/);

  const result = auditLines(lines, threshold, MAX_LINES);

  if (result.kind === "error") {
    const detail = result.message.replace(/^line \d+: /, "");
    const where = result.line === null ? "" : ` at line ${result.line}`;
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: ${result.code}${where}: ${detail}\n`,
    };
  }

  if (result.kind === "violation") {
    return {
      exitCode: 2,
      stdout: `${JSON.stringify(result.violation, null, 2)}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: `CLEAN: no unprotected travel moves (threshold=${threshold})\n`,
    stderr: "",
  };
}

// Execute only when invoked as a script (tests import runCli directly).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("cli.js") || invokedPath.endsWith("cli.ts")) {
  const output = runCli(process.argv.slice(2));
  if (output.stdout !== "") {
    process.stdout.write(output.stdout);
  }
  if (output.stderr !== "") {
    process.stderr.write(output.stderr);
  }
  process.exit(output.exitCode);
}
