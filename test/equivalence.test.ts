import { describe, expect, it } from 'vitest';
import { analyzeText, MAX_LINES, type Analysis } from '../src/auditor.js';
import type { MachineState } from '../src/auditor.js';

/**
 * Differential tests ("对拍"): programs that describe the same physical
 * toolpath in different mode combinations must audit identically — same
 * violations, same balances, same final coordinates.
 */

interface Outcome {
  violationLine: number | null;
  state: MachineState;
}

/** Physical state: coordinates and balance, ignoring the active modes. */
const physical = (state: MachineState): Pick<MachineState, 'x' | 'y' | 'z' | 'e' | 'balance'> => ({
  x: state.x,
  y: state.y,
  z: state.z,
  e: state.e,
  balance: state.balance,
});

function run(program: string, threshold: number): Outcome {
  const analysis = analyzeText(program, threshold);
  if (analysis.status === 'error') throw new Error(`unexpected parse error: ${analysis.message}`);
  return analysis.status === 'violation'
    ? { violationLine: analysis.line, state: analysis.state }
    : { violationLine: null, state: analysis.finalState };
}

const ABSOLUTE_PROGRAM = [
  'G90',
  'M82',
  'G1 X10 Y5 E2.5',
  'G1 X20 Y5 E5.0',
  'G1 E3.5', // retract 1.5 (absolute: 5.0 -> 3.5)
  'G1 X0 Y0', // travel, protected by balance 1.5
  'G1 E5.0', // deretract 1.5
].join('\n');

const RELATIVE_TWIN = [
  'G91',
  'M83',
  'G1 X10 Y5 E2.5',
  'G1 X10 Y0 E2.5',
  'G1 E-1.5', // retract 1.5
  'G1 X-20 Y-5', // same travel
  'G1 E1.5', // deretract 1.5
].join('\n');

describe('absolute/relative equivalence', () => {
  it('clean pair: identical final state under a satisfiable threshold', () => {
    const absolute = run(ABSOLUTE_PROGRAM, 1500);
    const relative = run(RELATIVE_TWIN, 1500);
    expect(absolute.violationLine).toBeNull();
    expect(relative.violationLine).toBeNull();
    expect(physical(relative.state)).toEqual(physical(absolute.state));
    expect(absolute.state).toMatchObject({ x: 0, y: 0, z: 0, e: 5000, balance: 0 });
  });

  it('tight threshold: both flag the same travel line with the same balance', () => {
    const absolute = run(ABSOLUTE_PROGRAM, 2000);
    const relative = run(RELATIVE_TWIN, 2000);
    expect(absolute.violationLine).toBe(6);
    expect(relative.violationLine).toBe(6);
    expect(relative.state.balance).toBe(absolute.state.balance);
    expect(absolute.state.balance).toBe(1500);
  });
});

const MIXED_REL_E = [
  'G90',
  'M83',
  'G1 X5 Y5 E1',
  'G1 X10 Y5 E2',
  'G1 E-1', // retract 1.0
  'G1 X0 Y0', // travel, balance exactly 1.0
  'G1 E1',
].join('\n');

const MIXED_ABS_E = [
  'G91',
  'M82',
  'G1 X5 Y5 E1',
  'G1 X5 Y0 E3', // absolute E tracks the relative twin's cumulative E
  'G1 E2', // retract 1.0 (absolute: 3 -> 2)
  'G1 X-10 Y-5', // same travel, back to the origin
  'G1 E3',
].join('\n');

describe('mixed-mode equivalence (G90+M83 vs G91+M82)', () => {
  it('boundary threshold: balance exactly at the threshold protects both', () => {
    const relE = run(MIXED_REL_E, 1000);
    const absE = run(MIXED_ABS_E, 1000);
    expect(relE.violationLine).toBeNull();
    expect(absE.violationLine).toBeNull();
    expect(physical(absE.state)).toEqual(physical(relE.state));
    expect(relE.state).toMatchObject({ x: 0, y: 0, e: 3000, balance: 0 });
  });

  it('one milli above the balance: both flag the same line', () => {
    const relE = run(MIXED_REL_E, 1001);
    const absE = run(MIXED_ABS_E, 1001);
    expect(relE.violationLine).toBe(6);
    expect(absE.violationLine).toBe(6);
    expect(absE.state.balance).toBe(relE.state.balance);
  });
});

const G92_PROGRAM = [
  'G90',
  'M82',
  'G1 X8 Y0 E4',
  'G92 E0', // reset the E origin mid-print
  'G1 E-1.2', // retract 1.2 from the new origin
  'G1 X0 Y0', // travel, protected by balance 1.2
  'G1 E0', // deretract back to the origin
].join('\n');

// Same toolpath without G92: E coordinates stay continuous, so the
// retraction is expressed as 4 -> 2.8 and the deretract as 2.8 -> 4.
const NO_G92_TWIN = [
  'G90',
  'M82',
  'G1 X8 Y0 E4',
  '; continuous E, no G92 reset',
  'G1 E2.8',
  'G1 X0 Y0',
  'G1 E4',
].join('\n');

describe('G92 equivalence', () => {
  it('G92 reset and continuous-E programs agree on travel protection', () => {
    const withReset = run(G92_PROGRAM, 1200);
    const continuous = run(NO_G92_TWIN, 1200);
    expect(withReset.violationLine).toBeNull();
    expect(continuous.violationLine).toBeNull();
    // Physical state matches; only the E coordinate origin differs.
    expect(continuous.state.balance).toBe(withReset.state.balance);
    expect([continuous.state.x, continuous.state.y, continuous.state.z]).toEqual([
      withReset.state.x,
      withReset.state.y,
      withReset.state.z,
    ]);
    expect(withReset.state.e).toBe(0);
    expect(continuous.state.e).toBe(4000);
  });

  it('both flag the same line when the threshold exceeds the retraction', () => {
    const withReset = run(G92_PROGRAM, 1201);
    const continuous = run(NO_G92_TWIN, 1201);
    expect(withReset.violationLine).toBe(6);
    expect(continuous.violationLine).toBe(6);
    expect(withReset.state.balance).toBe(1200);
    expect(continuous.state.balance).toBe(1200);
  });

  it('G92 does not itself create or destroy balance', () => {
    const analysis = analyzeText(['M83', 'G1 E-2', 'G92 E0'].join('\n'), 1500);
    expect(analysis.status).toBe('ok');
    if (analysis.status === 'ok') {
      expect(analysis.finalState.balance).toBe(2000);
      expect(analysis.finalState.e).toBe(0);
    }
  });
});

const SAMELINE_ABSOLUTE = [
  'G90',
  'M82',
  'G1 X10 Y10 E3',
  'G1 X20 Y20 E1.5', // travel that retracts 1.5 on the same line
].join('\n');

const SAMELINE_RELATIVE = [
  'G91',
  'M83',
  'G1 X10 Y10 E3',
  'G1 X10 Y10 E-1.5', // same retraction, expressed relatively
].join('\n');

describe('same-line retraction equivalence', () => {
  it('a travel retracting exactly the threshold on its own line is protected', () => {
    const absolute = run(SAMELINE_ABSOLUTE, 1500);
    const relative = run(SAMELINE_RELATIVE, 1500);
    expect(absolute.violationLine).toBeNull();
    expect(relative.violationLine).toBeNull();
    expect(physical(relative.state)).toEqual(physical(absolute.state));
    expect(absolute.state).toMatchObject({ x: 20000, y: 20000, balance: 1500 });
  });

  it('one milli more threshold flags both on the same line', () => {
    const absolute = run(SAMELINE_ABSOLUTE, 1501);
    const relative = run(SAMELINE_RELATIVE, 1501);
    expect(absolute.violationLine).toBe(4);
    expect(relative.violationLine).toBe(4);
    expect(relative.state.balance).toBe(absolute.state.balance);
  });
});

describe('whole-file errors', () => {
  it('reports unknown commands with their line number', () => {
    const analysis = analyzeText(['G90', 'G1 X1', 'M104 S200'].join('\n'), 1500);
    expect(analysis.status).toBe('error');
    if (analysis.status === 'error') expect(analysis.message).toContain('line 3');
  });

  it('reports duplicate parameters with their line number', () => {
    const analysis = analyzeText(['G1 X1 X2'].join('\n'), 1500);
    expect(analysis.status).toBe('error');
    if (analysis.status === 'error') {
      expect(analysis.message).toContain('line 1');
      expect(analysis.message).toContain('duplicate');
    }
  });

  it('reports malformed numbers with their line number', () => {
    const analysis = analyzeText(['G90', 'G1 X1.2345'].join('\n'), 1500);
    expect(analysis.status).toBe('error');
    if (analysis.status === 'error') expect(analysis.message).toContain('line 2');
  });

  it('reports non-finite values', () => {
    for (const bad of ['G1 XNaN', 'G1 XInfinity', 'G1 X1e3']) {
      const analysis = analyzeText(bad, 1500);
      expect(analysis.status, bad).toBe('error');
    }
  });

  it('rejects files beyond the line limit', () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, () => 'G90');
    const analysis = analyzeText(lines.join('\n'), 1500);
    expect(analysis.status).toBe('error');
    if (analysis.status === 'error') {
      expect(analysis.message).toContain(String(MAX_LINES + 1));
      expect(analysis.message).toContain(String(MAX_LINES));
    }
  });

  it('accepts a file at exactly the line limit', () => {
    const lines = Array.from({ length: MAX_LINES }, () => 'G90');
    const analysis = analyzeText(lines.join('\n'), 1500);
    expect(analysis.status).toBe('ok');
    if (analysis.status === 'ok') expect(analysis.lines).toBe(MAX_LINES);
  });

  it('does not count a trailing newline as an extra line', () => {
    const analysis = analyzeText('G90\n', 1500);
    expect(analysis.status).toBe('ok');
    if (analysis.status === 'ok') expect(analysis.lines).toBe(1);
  });
});
