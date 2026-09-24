/**
 * Strict line tokenizer for the tiny G-code dialect accepted by the auditor.
 *
 * Accepted tokens:
 *   - command word: G0, G1, G90, G91, G92, M82, M83 (case-insensitive letter)
 *   - parameter:    one of X/Y/Z/E followed by a signed decimal with at most
 *                   three fractional digits, e.g. E-1.2, X0.001
 *
 * Tokens are separated by spaces/tabs. A parameter letter may also directly
 * follow a command word or another value ("G1X10E3" == "G1 X10 E3").
 */

/** Motion commands that carry X/Y/Z/E parameters. */
export type MotionCommand = "G0" | "G1";
/** Mode/coordinate commands without motion parameters. */
export type SimpleCommand = "G90" | "G91" | "M82" | "M83" | "G92";
export type Command = MotionCommand | SimpleCommand;

export interface Token {
  command: Command;
  /** Parameter letters mapped to their raw numeric text. */
  params: ReadonlyMap<string, string>;
}

export type ParseErrorCode =
  | "UNKNOWN_COMMAND"
  | "DUPLICATE_PARAMETER"
  | "UNEXPECTED_PARAMETER"
  | "INVALID_NUMBER"
  | "NON_FINITE_NUMBER"
  | "MISSING_VALUE"
  | "VALUE_OUT_OF_RANGE";

/** Parse failure tagged with the 1-based line it occurred on. */
export class LineParseError extends Error {
  readonly line: number;
  readonly code: ParseErrorCode;

  constructor(line: number, code: ParseErrorCode, message: string) {
    super(message);
    this.name = "LineParseError";
    this.line = line;
    this.code = code;
  }
}

const MOTION_PARAMS = new Set(["X", "Y", "Z", "E"]);
const NUMBER_RE = /^[+-]?\d+(?:\.\d{1,3})?$/;
// Sticky matcher for the value directly following a parameter letter. The
// trailing lookahead forbids another digit/dot so "0.0001" cannot be silently
// swallowed as "0.000".
const VALUE_RE = /[+-]?\d+(?:\.\d{1,3})?(?![\d.])/y;

const KNOWN_COMMANDS = new Set<Command>([
  "G0",
  "G1",
  "G90",
  "G91",
  "G92",
  "M82",
  "M83",
]);

function fail(line: number, code: ParseErrorCode, message: string): never {
  throw new LineParseError(line, code, `line ${line}: ${message}`);
}

/**
 * Parse one physical line (without terminator).
 * Blank/whitespace-only lines yield null and are ignored by the auditor.
 */
export function tokenizeLine(raw: string, line: number): Token | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  let cursor = 0;
  let command: Command | null = null;
  const params = new Map<string, string>();

  const skipSpaces = (): void => {
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
      cursor += 1;
    }
  };

  skipSpaces();

  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (!isLetter(ch)) {
      fail(line, "UNKNOWN_COMMAND", `unexpected character '${ch}'`);
    }
    const upper = ch.toUpperCase();

    if (upper === "G" || upper === "M") {
      // Command word: letter followed by digits.
      let j = cursor + 1;
      while (j < text.length && isDigit(text[j]!)) {
        j += 1;
      }
      if (j === cursor + 1) {
        fail(line, "UNKNOWN_COMMAND", `command '${upper}' is missing its number`);
      }
      const word = `${upper}${text.slice(cursor + 1, j)}` as Command;
      if (!KNOWN_COMMANDS.has(word)) {
        fail(line, "UNKNOWN_COMMAND", `unknown command '${word}'`);
      }
      if (command !== null) {
        fail(line, "UNKNOWN_COMMAND", `a second command '${word}' is not allowed on one line`);
      }
      command = word;
      cursor = j;
      skipSpaces();
      continue;
    }

    // Anything else must be a motion parameter attached to the current command.
    if (command === null) {
      fail(line, "UNKNOWN_COMMAND", `expected G/M command, found '${upper}'`);
    }
    if (!MOTION_PARAMS.has(upper)) {
      fail(line, "UNEXPECTED_PARAMETER", `parameter '${upper}' is not accepted`);
    }

    cursor += 1; // consume parameter letter
    VALUE_RE.lastIndex = cursor;
    const match = VALUE_RE.exec(text);
    if (match === null || match.index !== cursor) {
      const peek = text[cursor];
      // A parameter letter (X/Y/Z/E), whitespace or end-of-line means the
      // value was omitted; any other leading character is a malformed number.
      if (
        peek === undefined ||
        peek === " " ||
        peek === "\t" ||
        (isUpperLetter(peek) && MOTION_PARAMS.has(peek))
      ) {
        throw new LineParseError(
          line,
          "MISSING_VALUE",
          `line ${line}: parameter '${upper}' is missing its value`,
        );
      }
      throw new LineParseError(
        line,
        "INVALID_NUMBER",
        `line ${line}: parameter '${upper}' has an invalid numeric value`,
      );
    }
    const value: string = match[0];

    // Reject exponent notation / trailing junk such as "1.5mm". An uppercase
    // letter is a following parameter token ("G1X10E-1" == "G1 X10 E-1"),
    // while a lowercase letter ("1e3") or a dot ("1.2.3") cannot be one.
    const after = text[cursor + value.length];
    if (after !== undefined && after !== " " && after !== "\t") {
      if (!isUpperLetter(after)) {
        fail(
          line,
          "INVALID_NUMBER",
          `parameter '${upper}' has an invalid numeric value starting at '${value}${after}'`,
        );
      }
    }

    validateNumber(value, line, upper);
    if (params.has(upper)) {
      fail(line, "DUPLICATE_PARAMETER", `parameter '${upper}' is repeated on the same line`);
    }
    params.set(upper, value);
    cursor += value.length;
    skipSpaces();
  }

  if (command === null) {
  fail(line, "UNKNOWN_COMMAND", "no command found");
  }

  // G92 takes exactly E; the simple mode commands take nothing.
  if (command === "G92") {
    for (const key of params.keys()) {
      if (key !== "E") {
        throw new LineParseError(
          line,
          "UNEXPECTED_PARAMETER",
          `line ${line}: G92 only accepts E, found '${key}'`,
        );
      }
    }
    if (!params.has("E")) {
      throw new LineParseError(
        line,
        "UNEXPECTED_PARAMETER",
        `line ${line}: G92 requires an E parameter`,
      );
    }
  } else if (command === "G90" || command === "G91" || command === "M82" || command === "M83") {
    if (params.size > 0) {
      throw new LineParseError(
        line,
        "UNEXPECTED_PARAMETER",
        `line ${line}: ${command} takes no parameters`,
      );
    }
  }

  return { command, params };
}

/** Validate the strict decimal grammar. Returns the trimmed canonical text. */
function validateNumber(raw: string, line: number, param: string): string {
  if (!NUMBER_RE.test(raw)) {
    throw new LineParseError(
      line,
      "INVALID_NUMBER",
      `line ${line}: ${param} value '${raw}' is not a signed decimal with at most three digits after the dot`,
    );
  }
  if (!Number.isFinite(Number(raw))) {
    // The grammar above already rejects Infinity/NaN; the specification asks
    // for an explicit non-finite guard, so it stays in place.
    throw new LineParseError(
      line,
      "NON_FINITE_NUMBER",
      `line ${line}: ${param} value '${raw}' is not finite`,
    );
  }
  return raw;
}

/**
 * Convert a grammar-validated decimal to integer thousandths without going
 * through floating point arithmetic (which would corrupt e.g. "0.007").
 */
export function parseThousandths(raw: string, line: number, param: string): number {
  validateNumber(raw, line, param);
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const dot = unsigned.indexOf(".");
  const wholeRaw = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracRaw = dot === -1 ? "" : unsigned.slice(dot + 1);

  let result = Number.parseInt(wholeRaw === "" ? "0" : wholeRaw, 10) * 1000;
  if (fracRaw !== "") {
    result += Number.parseInt(fracRaw.padEnd(3, "0").slice(0, 3), 10);
  }
  result = negative ? -result : result;
  // "-0" parses to negative zero; canonicalize so equality and JSON agree.
  if (result === 0) {
    result = 0;
  }

  if (!Number.isSafeInteger(result)) {
    throw new LineParseError(
      line,
      "VALUE_OUT_OF_RANGE",
      `line ${line}: ${param} value '${raw}' is out of the safe integer range`,
    );
  }
  return result;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return isUpperLetter(ch) || (ch >= "a" && ch <= "z");
}

function isUpperLetter(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}
