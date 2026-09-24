import { describe, expect, it } from 'vitest';
import { ParseError, parseLine, parseMilli, parseProgram } from '../src/parser.js';

describe('parseMilli', () => {
  it('converts signed decimals to integer thousandths', () => {
    expect(parseMilli('1', 1)).toBe(1000);
    expect(parseMilli('+1', 1)).toBe(1000);
    expect(parseMilli('-1.5', 1)).toBe(-1500);
    expect(parseMilli('0.001', 1)).toBe(1);
    expect(parseMilli('12.345', 1)).toBe(12345);
    expect(parseMilli('.25', 1)).toBe(250);
    expect(parseMilli('1.', 1)).toBe(1000);
    expect(parseMilli('-0', 1)).toBe(0);
  });

  it('rejects more than three decimal places', () => {
    expect(() => parseMilli('1.2345', 7)).toThrow(ParseError);
    expect(() => parseMilli('0.0001', 7)).toThrow(ParseError);
  });

  it('rejects non-finite and non-decimal values', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1e3', '0x10', 'abc', '', '+', '.']) {
      expect(() => parseMilli(bad, 3), bad).toThrow(ParseError);
    }
  });

  it('rejects values that overflow safe integer thousandths', () => {
    expect(() => parseMilli('99999999999999999', 2)).toThrow(/non-finite|out-of-range/);
  });

  it('reports the line number in the error', () => {
    try {
      parseMilli('1.2345', 42);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).line).toBe(42);
      expect((error as ParseError).message).toContain('line 42');
    }
  });
});

describe('parseLine', () => {
  it('parses a G1 move with all axes', () => {
    expect(parseLine('G1 X1.5 Y-2 Z0.3 E0.75', 1)).toEqual({
      kind: 'move',
      line: 1,
      x: 1500,
      y: -2000,
      z: 300,
      e: 750,
    });
  });

  it('parses G0 and normalizes G00/G01-style codes', () => {
    expect(parseLine('G0 X10', 1)).toMatchObject({ kind: 'move', x: 10000 });
    expect(parseLine('G00 X10', 1)).toMatchObject({ kind: 'move', x: 10000 });
    expect(parseLine('G01 Y2', 1)).toMatchObject({ kind: 'move', y: 2000 });
  });

  it('is case-insensitive for commands and parameters', () => {
    expect(parseLine('g1 x1 e.5', 1)).toMatchObject({ kind: 'move', x: 1000, e: 500 });
  });

  it('parses mode switches and G92 E', () => {
    expect(parseLine('G90', 1)).toEqual({ kind: 'positioning', line: 1, mode: 'absolute' });
    expect(parseLine('G91', 1)).toEqual({ kind: 'positioning', line: 1, mode: 'relative' });
    expect(parseLine('M82', 1)).toEqual({ kind: 'extrusion-mode', line: 1, mode: 'absolute' });
    expect(parseLine('M83', 1)).toEqual({ kind: 'extrusion-mode', line: 1, mode: 'relative' });
    expect(parseLine('G92 E0', 1)).toEqual({ kind: 'set-e', line: 1, value: 0 });
    expect(parseLine('G92 E-2.5', 1)).toEqual({ kind: 'set-e', line: 1, value: -2500 });
  });

  it('ignores blank lines and semicolon comments', () => {
    expect(parseLine('', 1)).toBeNull();
    expect(parseLine('   ', 1)).toBeNull();
    expect(parseLine('; full line comment', 1)).toBeNull();
    expect(parseLine('G1 X1 ; retract point', 1)).toMatchObject({ kind: 'move', x: 1000 });
  });

  it('rejects unknown commands', () => {
    for (const bad of ['M104 S200', 'G28', 'T0', 'G2 X1', 'M84', 'G1X1']) {
      expect(() => parseLine(bad, 1), bad).toThrow(/unknown command/);
    }
  });

  it('rejects duplicate parameters', () => {
    expect(() => parseLine('G1 X1 X2', 1)).toThrow(/duplicate parameter 'X'/);
    expect(() => parseLine('G1 E1 e2', 1)).toThrow(/duplicate parameter 'E'/);
  });

  it('rejects unsupported parameters on moves', () => {
    expect(() => parseLine('G1 X1 F3000', 1)).toThrow(/unsupported parameter 'F'/);
    expect(() => parseLine('G1 S1', 1)).toThrow(/unsupported parameter 'S'/);
  });

  it('rejects parameters on mode commands', () => {
    expect(() => parseLine('G90 X1', 1)).toThrow(/takes no parameters/);
    expect(() => parseLine('M83 E1', 1)).toThrow(/takes no parameters/);
  });

  it('rejects G92 without E or with other axes', () => {
    expect(() => parseLine('G92', 1)).toThrow(/requires an E parameter/);
    expect(() => parseLine('G92 X0', 1)).toThrow(/only supports E/);
    expect(() => parseLine('G92 E0 X0', 1)).toThrow(/only supports E/);
  });

  it('rejects malformed parameters', () => {
    expect(() => parseLine('G1 X', 1)).toThrow(/malformed|invalid number/);
    expect(() => parseLine('G1 *23', 1)).toThrow(/malformed parameter/);
  });
});

describe('parseProgram', () => {
  it('keeps 1-based physical line numbers across blanks and comments', () => {
    const program = ['; header', '', 'G90', 'G1 X1', 'M83'].join('\n');
    const commands = parseProgram(program);
    expect(commands.map((c) => c.line)).toEqual([3, 4, 5]);
  });

  it('points at the offending line on error', () => {
    const program = ['G90', 'G1 X1', 'M104 S200'].join('\n');
    try {
      parseProgram(program);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).line).toBe(3);
      expect((error as ParseError).message).toContain('line 3');
    }
  });

  it('handles CRLF line endings', () => {
    expect(parseProgram('G90\r\nG1 X1\r\n')).toHaveLength(2);
  });
});
