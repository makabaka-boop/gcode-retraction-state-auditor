/**
 * Extrusion-aware motion auditor.
 *
 * The machine state is tracked entirely in integer thousandths of a unit
 * so absolute/relative mode switches and G92 resets are exact:
 *
 *   - G90/G91 select absolute/relative positioning for X, Y, Z.
 *   - M82/M83 select absolute/relative extrusion for E.
 *   - G92 E<v> redefines the E coordinate origin only; X/Y/Z, the modes,
 *     and the retraction balance are untouched.
 *
 * Retraction balance (in millis):
 *   - a negative E delta (retraction) adds to the balance;
 *   - a positive E delta first repays the balance ("deretraction");
 *     only the remainder counts as net extrusion for that line.
 *
 * A G0/G1 move that displaces X or Y without producing positive net
 * extrusion is a travel move. After applying the line's E change, if the
 * balance is below the configured threshold the move is reported as
 * UNPROTECTED_TRAVEL — the filament was not retracted enough to cross
 * empty space without stringing.
 */

import { ParseError, parseProgram, type Command, type PositioningMode } from './parser.js';

/** Maximum number of physical lines the auditor accepts. */
export const MAX_LINES = 10_000;

export interface MachineState {
  readonly positioning: PositioningMode; // G90 / G91, applies to X Y Z
  readonly extrusion: PositioningMode; // M82 / M83, applies to E
  readonly x: number; // millis
  readonly y: number;
  readonly z: number;
  readonly e: number;
  readonly balance: number; // outstanding retraction credit, millis, >= 0
}

export interface Violation {
  readonly line: number;
  /** State after the offending line has been fully applied. */
  readonly state: MachineState;
}

export function initialState(): MachineState {
  return {
    positioning: 'absolute',
    extrusion: 'absolute',
    x: 0,
    y: 0,
    z: 0,
    e: 0,
    balance: 0,
  };
}

export interface StepResult {
  readonly state: MachineState;
  readonly violation: Violation | null;
}

/** Apply one command, returning the next state and any violation it raised. */
export function applyCommand(
  state: MachineState,
  command: Command,
  threshold: number,
): StepResult {
  switch (command.kind) {
    case 'positioning':
      return { state: { ...state, positioning: command.mode }, violation: null };
    case 'extrusion-mode':
      return { state: { ...state, extrusion: command.mode }, violation: null };
    case 'set-e':
      // G92 redefines the E origin only; the balance is physical filament
      // state and does not change.
      return { state: { ...state, e: command.value }, violation: null };
    case 'move':
      return applyMove(state, command, threshold);
  }
}

function applyMove(
  state: MachineState,
  command: Extract<Command, { kind: 'move' }>,
  threshold: number,
): StepResult {
  const nextAxis = (current: number, param: number | undefined): number =>
    param === undefined ? current : state.positioning === 'absolute' ? param : current + param;

  const x = nextAxis(state.x, command.x);
  const y = nextAxis(state.y, command.y);
  const z = nextAxis(state.z, command.z);

  let e = state.e;
  let delta = 0;
  if (command.e !== undefined) {
    delta = state.extrusion === 'absolute' ? command.e - state.e : command.e;
    e = state.extrusion === 'absolute' ? command.e : state.e + command.e;
  }

  let balance = state.balance;
  let netExtrusion = 0;
  if (delta < 0) {
    balance += -delta;
  } else if (delta > 0) {
    const repaid = Math.min(balance, delta);
    balance -= repaid;
    netExtrusion = delta - repaid;
  }

  const next: MachineState = { ...state, x, y, z, e, balance };

  const displacedXY = x !== state.x || y !== state.y;
  if (displacedXY && netExtrusion <= 0 && balance < threshold) {
    return { state: next, violation: { line: command.line, state: next } };
  }
  return { state: next, violation: null };
}

export interface AuditResult {
  /** First UNPROTECTED_TRAVEL violation, if any. */
  readonly violation: Violation | null;
  /** State after the last applied command (the violating line, if stopped early). */
  readonly finalState: MachineState;
  /** Number of commands applied. */
  readonly applied: number;
}

/** Run a parsed program, stopping at the first violation. */
export function audit(commands: readonly Command[], threshold: number): AuditResult {
  let state = initialState();
  let applied = 0;
  for (const command of commands) {
    const step = applyCommand(state, command, threshold);
    state = step.state;
    applied += 1;
    if (step.violation !== null) {
      return { violation: step.violation, finalState: state, applied };
    }
  }
  return { violation: null, finalState: state, applied };
}

export type Analysis =
  | { readonly status: 'ok'; readonly lines: number; readonly finalState: MachineState }
  | { readonly status: 'violation'; readonly line: number; readonly state: MachineState }
  | { readonly status: 'error'; readonly message: string };

/**
 * Analyze raw file text: enforce the line limit, parse, and audit.
 * Never throws — every failure mode is reported as `{ status: 'error' }`.
 */
export function analyzeText(text: string, threshold: number): Analysis {
  const lines = text.split('\n');
  // A trailing newline terminates the last line; it is not an extra line.
  const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (lineCount > MAX_LINES) {
    return {
      status: 'error',
      message: `file has ${lineCount} lines, which exceeds the ${MAX_LINES}-line limit`,
    };
  }
  let commands: Command[];
  try {
    commands = parseProgram(text);
  } catch (error) {
    if (error instanceof ParseError) {
      return { status: 'error', message: error.message };
    }
    throw error;
  }
  const result = audit(commands, threshold);
  if (result.violation !== null) {
    return {
      status: 'violation',
      line: result.violation.line,
      state: result.violation.state,
    };
  }
  return { status: 'ok', lines: lineCount, finalState: result.finalState };
}
