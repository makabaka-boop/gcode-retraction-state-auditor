import { describe, expect, it } from 'vitest';
import { applyCommand, audit, initialState, type MachineState } from '../src/auditor.js';
import type { Command } from '../src/parser.js';

const THRESHOLD = 1500; // 1.500 units

const move = (
  line: number,
  params: Partial<{ x: number; y: number; z: number; e: number }> = {},
): Command => ({ kind: 'move', line, ...params });

const withState = (overrides: Partial<MachineState> = {}): MachineState => ({
  ...initialState(),
  ...overrides,
});

/** Apply a sequence of commands, returning the final step result. */
function run(state: MachineState, commands: Command[], threshold = THRESHOLD) {
  let current = state;
  let step = { state: current, violation: null as null | { line: number; state: MachineState } };
  for (const command of commands) {
    step = applyCommand(current, command, threshold);
    current = step.state;
  }
  return step;
}

describe('initial state', () => {
  it('defaults to G90/M82 absolute modes at the origin with zero balance', () => {
    expect(initialState()).toEqual({
      positioning: 'absolute',
      extrusion: 'absolute',
      x: 0,
      y: 0,
      z: 0,
      e: 0,
      balance: 0,
    });
  });
});

describe('positioning modes (G90/G91)', () => {
  it('absolute sets coordinates, relative adds deltas', () => {
    const absolute = run(initialState(), [move(1, { x: 1500 })]);
    expect(absolute.state.x).toBe(1500);

    const relative = run(initialState(), [
      { kind: 'positioning', line: 1, mode: 'relative' },
      move(2, { x: 1500 }),
      move(3, { x: 1500 }),
    ]);
    expect(relative.state.x).toBe(3000);
  });

  it('G91 does not affect E, which follows M82/M83 instead', () => {
    // Relative XYZ + absolute E: E word is a coordinate, not a delta.
    const step = run(initialState(), [
      { kind: 'positioning', line: 1, mode: 'relative' },
      move(2, { e: 2000 }),
      move(3, { e: 2000 }),
    ]);
    expect(step.state.e).toBe(2000); // set twice, not accumulated
  });
});

describe('extrusion modes (M82/M83)', () => {
  it('absolute: a positive E word below the current coordinate is a retraction', () => {
    // This is the case that fools naive sign checkers: `G1 E3` looks
    // positive but, from E=5, it pulls filament back.
    const step = run(withState({ e: 5000 }), [move(1, { e: 3000 })]);
    expect(step.state.e).toBe(3000);
    expect(step.state.balance).toBe(2000);
  });

  it('relative: E word is the delta itself', () => {
    const step = run(initialState(), [
      { kind: 'extrusion-mode', line: 1, mode: 'relative' },
      move(2, { e: -2000 }),
    ]);
    expect(step.state.e).toBe(-2000);
    expect(step.state.balance).toBe(2000);
  });
});

describe('retraction balance', () => {
  it('negative deltas accumulate, positive deltas repay before extruding', () => {
    const state = withState({ extrusion: 'relative', balance: 1500 });
    // +1.000 is fully absorbed by the outstanding balance.
    const repaid = run(state, [move(1, { e: 1000 })]);
    expect(repaid.state.balance).toBe(500);
    // +2.000 repays the remaining 0.500 and extrudes 1.500 net.
    const net = run(repaid.state, [move(2, { e: 2000 })]);
    expect(net.state.balance).toBe(0);
  });

  it('G92 resets only the E coordinate, not the balance', () => {
    const state = withState({ e: 8000, balance: 1200 });
    const step = applyCommand(state, { kind: 'set-e', line: 1, value: 0 }, THRESHOLD);
    expect(step.state.e).toBe(0);
    expect(step.state.balance).toBe(1200);
    expect(step.state.x).toBe(0);
    expect(step.violation).toBeNull();
  });

  it('after G92 E0, absolute deltas are measured from the new origin', () => {
    const state = withState({ e: 8000 });
    const step = run(state, [
      { kind: 'set-e', line: 1, value: 0 },
      move(2, { e: -1500 }), // delta is -1.500, not -9.500
    ]);
    expect(step.state.balance).toBe(1500);
    expect(step.state.e).toBe(-1500);
  });
});

describe('travel detection', () => {
  it('flags XY travel with balance below the threshold', () => {
    const step = applyCommand(initialState(), move(7, { x: 10000 }), THRESHOLD);
    expect(step.violation).not.toBeNull();
    expect(step.violation!.line).toBe(7);
    expect(step.violation!.state.x).toBe(10000);
    expect(step.violation!.state.balance).toBe(0);
  });

  it('accepts travel when the balance exactly meets the threshold', () => {
    const state = withState({ balance: 1500 });
    const step = applyCommand(state, move(1, { x: 10000 }), THRESHOLD);
    expect(step.violation).toBeNull();
  });

  it('flags travel one milli below the threshold', () => {
    const state = withState({ balance: 1499 });
    const step = applyCommand(state, move(1, { x: 10000 }), THRESHOLD);
    expect(step.violation).not.toBeNull();
  });

  it('ignores Z-only and E-only moves', () => {
    expect(applyCommand(initialState(), move(1, { z: 300 }), THRESHOLD).violation).toBeNull();
    expect(applyCommand(initialState(), move(1, { e: -1000 }), THRESHOLD).violation).toBeNull();
  });

  it('ignores XY moves with positive net extrusion', () => {
    const state = withState({ extrusion: 'relative' });
    const step = applyCommand(state, move(1, { x: 10000, e: 2000 }), THRESHOLD);
    expect(step.violation).toBeNull();
  });

  it('treats a deretract fully absorbed by the balance as no net extrusion', () => {
    // Balance 1.500, line extrudes +1.000: all of it deretracts, so this
    // XY move is a travel — and the remaining 0.500 is below threshold.
    const state = withState({ extrusion: 'relative', balance: 1500 });
    const step = applyCommand(state, move(1, { x: 10000, e: 1000 }), THRESHOLD);
    expect(step.state.balance).toBe(500);
    expect(step.violation).not.toBeNull();
  });

  it('treats a partially absorbed deretract as a print move', () => {
    const state = withState({ extrusion: 'relative', balance: 1500 });
    const step = applyCommand(state, move(1, { x: 10000, e: 3000 }), THRESHOLD);
    expect(step.state.balance).toBe(0);
    expect(step.violation).toBeNull();
  });
});

describe('same-line retraction moves', () => {
  it('a travel that retracts enough on the same line is protected', () => {
    const state = withState({ extrusion: 'relative' });
    const step = applyCommand(state, move(1, { x: 10000, e: -1500 }), THRESHOLD);
    expect(step.state.balance).toBe(1500);
    expect(step.violation).toBeNull();
  });

  it('a travel with too little same-line retraction is flagged', () => {
    const state = withState({ extrusion: 'relative' });
    const step = applyCommand(state, move(1, { x: 10000, e: -1400 }), THRESHOLD);
    expect(step.violation).not.toBeNull();
    expect(step.violation!.state.balance).toBe(1400);
  });

  it('the violation snapshot reflects the state after the line executed', () => {
    const state = withState({ extrusion: 'relative', balance: 200 });
    const step = applyCommand(state, move(9, { x: 5000, e: -500 }), THRESHOLD);
    expect(step.violation!.line).toBe(9);
    expect(step.violation!.state).toMatchObject({ x: 5000, balance: 700 });
  });
});

describe('audit', () => {
  it('stops at the first violation', () => {
    const commands: Command[] = [
      { kind: 'extrusion-mode', line: 1, mode: 'relative' },
      move(2, { x: 1000 }), // violation: balance 0
      move(3, { x: 2000 }), // would also violate
    ];
    const result = audit(commands, THRESHOLD);
    expect(result.violation!.line).toBe(2);
    expect(result.applied).toBe(2);
  });

  it('returns the final state for clean programs', () => {
    const commands: Command[] = [
      { kind: 'extrusion-mode', line: 1, mode: 'relative' },
      move(2, { e: -2000 }),
      move(3, { x: 1000 }),
    ];
    const result = audit(commands, THRESHOLD);
    expect(result.violation).toBeNull();
    expect(result.finalState).toMatchObject({ x: 1000, balance: 2000 });
  });
});
