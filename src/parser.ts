/**
 * Parser for the strict G-code subset accepted by motion-audit.
 *
 * Accepted commands (case-insensitive, whitespace-separated tokens,
 * optional `;` comments, blank lines ignored):
 *
 *   G0 / G1   with any subset of parameters X, Y, Z, E (each at most once)
 *   G90 / G91 absolute / relative positioning for X, Y, Z (no parameters)
 *   M82 / M83 absolute / relative extrusion for E (no parameters)
 *   G92 E<v>  set the E coordinate origin (E only, exactly once)
 *
 * Numbers are signed decimals with at most three decimal places
 * (e.g. `12`, `-1.5`, `+0.125`, `.25`). Anything else — unknown commands,
 * unknown or duplicate parameters, malformed or non-finite values —
 * aborts the whole file with a ParseError carrying the 1-based line number.
 *
 * All numeric values are converted to integers in thousandths of a unit
 * ("millis") at parse time, so downstream logic never touches floats.
 */

export class ParseError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'ParseError';
    this.line = line;
  }
}

/** Signed decimal, at most three fractional digits: 1, +1, -1.5, 1., .25 */
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/;

/** Command word: a letter followed by an integer (G0, G00, G1, M82, ...). */
const COMMAND_RE = /^([GM])(\d+)$/i;

/** Parameter token: a single letter followed by the numeric value. */
const PARAM_RE = /^([A-Za-z])(.+)$/;

export type PositioningMode = 'absolute' | 'relative';

export type Command =
  | { readonly kind: 'move'; readonly line: number; readonly x?: number; readonly y?: number; readonly z?: number; readonly e?: number }
  | { readonly kind: 'positioning'; readonly line: number; readonly mode: PositioningMode }
  | { readonly kind: 'extrusion-mode'; readonly line: number; readonly mode: PositioningMode }
  | { readonly kind: 'set-e'; readonly line: number; readonly value: number };

/**
 * Convert a validated numeric token to integer thousandths.
 * Throws ParseError for malformed, non-finite, or out-of-range values.
 */
export function parseMilli(raw: string, line: number): number {
  if (!NUMBER_RE.test(raw)) {
    throw new ParseError(
      line,
      `invalid number '${raw}' (expected a signed decimal with at most 3 decimal places)`,
    );
  }
  const negative = raw.startsWith('-');
  const body = raw.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  const milli =
    Number(intPart === '' ? '0' : intPart) * 1000 +
    Number((fracPart + '000').slice(0, 3));
  const signed = negative ? -milli : milli;
  if (!Number.isSafeInteger(signed)) {
    throw new ParseError(line, `non-finite or out-of-range value '${raw}'`);
  }
  // Normalize -0 so downstream equality checks never see it.
  return signed === 0 ? 0 : signed;
}

/** Parse one physical line; returns null for blank/comment-only lines. */
export function parseLine(rawLine: string, line: number): Command | null {
  const text = rawLine.split(';', 2)[0]!.trim();
  if (text === '') return null;

  const tokens = text.split(/\s+/);
  const head = tokens[0]!;
  const commandMatch = COMMAND_RE.exec(head);
  if (commandMatch === null) {
    throw new ParseError(line, `unknown command '${head}'`);
  }
  const letter = commandMatch[1]!.toUpperCase();
  const code = Number(commandMatch[2]);
  const params = tokens.slice(1);

  switch (`${letter}${code}`) {
    case 'G0':
    case 'G1':
      return parseMove(line, params);
    case 'G90':
    case 'G91':
      rejectParams(line, head, params);
      return { kind: 'positioning', line, mode: code === 90 ? 'absolute' : 'relative' };
    case 'M82':
    case 'M83':
      rejectParams(line, head, params);
      return { kind: 'extrusion-mode', line, mode: code === 82 ? 'absolute' : 'relative' };
    case 'G92':
      return parseSetE(line, params);
    default:
      throw new ParseError(line, `unknown command '${head}'`);
  }
}

function rejectParams(line: number, head: string, params: readonly string[]): void {
  if (params.length > 0) {
    throw new ParseError(line, `${head} takes no parameters, got '${params[0]}'`);
  }
}

function parseMove(line: number, params: readonly string[]): Command {
  const seen = new Set<string>();
  const move: { kind: 'move'; line: number; x?: number; y?: number; z?: number; e?: number } = {
    kind: 'move',
    line,
  };
  for (const token of params) {
    const [letter, value] = parseParam(token, line);
    if (letter !== 'X' && letter !== 'Y' && letter !== 'Z' && letter !== 'E') {
      throw new ParseError(line, `unsupported parameter '${letter}' on G0/G1 (only X, Y, Z, E)`);
    }
    if (seen.has(letter)) {
      throw new ParseError(line, `duplicate parameter '${letter}'`);
    }
    seen.add(letter);
    const key = letter.toLowerCase() as 'x' | 'y' | 'z' | 'e';
    move[key] = value;
  }
  return move;
}

function parseSetE(line: number, params: readonly string[]): Command {
  if (params.length === 0) {
    throw new ParseError(line, 'G92 requires an E parameter (only E is supported)');
  }
  if (params.length > 1) {
    throw new ParseError(line, `G92 only supports E, got unexpected parameter '${params[1]}'`);
  }
  const [letter, value] = parseParam(params[0]!, line);
  if (letter !== 'E') {
    throw new ParseError(line, `G92 only supports E, got '${letter}'`);
  }
  return { kind: 'set-e', line, value };
}

/** Split a parameter token into its (upper-cased) letter and milli value. */
function parseParam(token: string, line: number): [letter: string, value: number] {
  const match = PARAM_RE.exec(token);
  if (match === null) {
    throw new ParseError(line, `malformed parameter '${token}'`);
  }
  return [match[1]!.toUpperCase(), parseMilli(match[2]!, line)];
}

/**
 * Parse a whole program. Line numbers on commands are 1-based physical
 * line numbers so errors and reports point at the real file.
 */
export function parseProgram(text: string): Command[] {
  const commands: Command[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const command = parseLine(lines[i]!.replace(/\r$/, ''), i + 1);
    if (command !== null) commands.push(command);
  }
  return commands;
}
