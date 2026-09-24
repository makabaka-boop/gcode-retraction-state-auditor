import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  main,
  parseArgs,
  UsageError,
} from '../src/cli.js';
import { formatMilli, formatMode, formatViolation } from '../src/format.js';
import { initialState } from '../src/auditor.js';

describe('parseArgs', () => {
  it('accepts --threshold and a file in any order', () => {
    expect(parseArgs(['--threshold', '1500', 'a.gcode'])).toEqual({
      threshold: 1500,
      file: 'a.gcode',
    });
    expect(parseArgs(['a.gcode', '--threshold', '1500'])).toEqual({
      threshold: 1500,
      file: 'a.gcode',
    });
    expect(parseArgs(['-t', '500', 'a.gcode'])).toEqual({ threshold: 500, file: 'a.gcode' });
    expect(parseArgs(['--threshold=1500', 'a.gcode'])).toEqual({
      threshold: 1500,
      file: 'a.gcode',
    });
  });

  it('requires a positive integer threshold in thousandths', () => {
    for (const bad of ['0', '-5', '1.5', 'abc', '']) {
      expect(() => parseArgs(['--threshold', bad, 'a.gcode']), bad).toThrow(UsageError);
    }
  });

  it('requires threshold and file, and rejects extras', () => {
    expect(() => parseArgs(['a.gcode'])).toThrow(/missing required --threshold/);
    expect(() => parseArgs(['--threshold', '100'])).toThrow(/missing input file/);
    expect(() => parseArgs(['--threshold', '100', 'a.g', 'b.g'])).toThrow(/extra argument/);
    expect(() => parseArgs(['--nope', '100', 'a.g'])).toThrow(/unknown option/);
  });
});

describe('formatting', () => {
  it('renders thousandths as fixed 3-decimal strings', () => {
    expect(formatMilli(1500)).toBe('1.500');
    expect(formatMilli(-1200)).toBe('-1.200');
    expect(formatMilli(0)).toBe('0.000');
    expect(formatMilli(5)).toBe('0.005');
  });

  it('renders modes as G90/M82-style tokens', () => {
    expect(formatMode(initialState())).toBe('G90/M82');
    expect(
      formatMode({ ...initialState(), positioning: 'relative', extrusion: 'relative' }),
    ).toBe('G91/M83');
  });

  it('renders the violation line with mode, coordinates, and balance', () => {
    const state = {
      ...initialState(),
      extrusion: 'relative' as const,
      x: 40000,
      y: 40000,
      e: -500,
      balance: 500,
    };
    expect(formatViolation(5, state, 1500)).toBe(
      'UNPROTECTED_TRAVEL line=5 mode=G90/M83 X=40.000 Y=40.000 Z=0.000 E=-0.500 balance=0.500 threshold=1.500',
    );
  });
});

describe('main', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motion-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeProgram = (name: string, text: string): string => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };

  it('exits 0 for a clean program', () => {
    const file = writeProgram('clean.gcode', ['G90', 'M83', 'G1 E-2', 'G1 X50 Y50'].join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--threshold', '1500', file])).toBe(EXIT_OK);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('OK'));
  });

  it('exits 1 and reports the first unprotected travel', () => {
    const file = writeProgram(
      'stringing.gcode',
      ['G90', 'M83', 'G1 E-0.5', 'G1 X40 Y40', 'G1 X80 Y80'].join('\n'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--threshold', '1500', file])).toBe(EXIT_VIOLATION);
    expect(log).toHaveBeenCalledWith(
      'UNPROTECTED_TRAVEL line=4 mode=G90/M83 X=40.000 Y=40.000 Z=0.000 E=-0.500 balance=0.500 threshold=1.500',
    );
  });

  it('exits 2 for parse errors, unreadable files, and bad usage', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = writeProgram('bad.gcode', 'M104 S200\n');
    expect(main(['--threshold', '1500', bad])).toBe(EXIT_ERROR);
    expect(main(['--threshold', '1500', join(dir, 'missing.gcode')])).toBe(EXIT_ERROR);
    expect(main(['--threshold', '0', bad])).toBe(EXIT_ERROR);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('line 1'));
  });
});
