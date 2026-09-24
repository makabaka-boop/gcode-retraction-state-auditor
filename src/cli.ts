#!/usr/bin/env node
/**
 * motion-audit CLI.
 *
 *   motion-audit --threshold <millis> <file.gcode>
 *
 *   --threshold, -t   retraction threshold as a positive integer in
 *                     thousandths of a unit (e.g. 1500 = 1.500 units)
 *
 * Exit codes: 0 = no unprotected travel, 1 = UNPROTECTED_TRAVEL found,
 * 2 = usage, parse, or file error.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyzeText } from './auditor.js';
import { formatMilli, formatViolation } from './format.js';

export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_ERROR = 2;

export class UsageError extends Error {}

export interface CliArgs {
  readonly threshold: number;
  readonly file: string;
}

const USAGE = 'usage: motion-audit --threshold <positive integer millis> <file.gcode>';

/** Parse CLI arguments; throws UsageError on anything invalid. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let thresholdText: string | null = null;
  let file: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--threshold' || arg === '-t') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`missing value for ${arg}`);
      thresholdText = value;
      i += 1;
    } else if (arg.startsWith('--threshold=')) {
      thresholdText = arg.slice('--threshold='.length);
    } else if (arg === '--help' || arg === '-h') {
      throw new UsageError(USAGE);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option '${arg}'`);
    } else if (file === null) {
      file = arg;
    } else {
      throw new UsageError(`unexpected extra argument '${arg}'`);
    }
  }

  if (thresholdText === null) throw new UsageError('missing required --threshold');
  if (!/^\d+$/.test(thresholdText)) {
    throw new UsageError(
      `threshold must be a positive integer in thousandths of a unit, got '${thresholdText}'`,
    );
  }
  const threshold = Number(thresholdText);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new UsageError(
      `threshold must be a positive integer in thousandths of a unit, got '${thresholdText}'`,
    );
  }
  if (file === null) throw new UsageError('missing input file');
  return { threshold, file };
}

/** Run the CLI against real stdin/stdout/stderr; returns the exit code. */
export function main(argv: readonly string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      console.error(USAGE);
      return EXIT_ERROR;
    }
    throw error;
  }

  let text: string;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot read '${args.file}': ${detail}`);
    return EXIT_ERROR;
  }

  const analysis = analyzeText(text, args.threshold);
  switch (analysis.status) {
    case 'ok':
      console.log(
        `OK: no unprotected travel in ${analysis.lines} lines ` +
          `(threshold ${formatMilli(args.threshold)})`,
      );
      return EXIT_OK;
    case 'violation':
      console.log(formatViolation(analysis.line, analysis.state, args.threshold));
      return EXIT_VIOLATION;
    case 'error':
      console.error(`error: ${analysis.message}`);
      return EXIT_ERROR;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exitCode = main(process.argv.slice(2));
}
