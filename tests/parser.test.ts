import { describe, expect, it } from "vitest";

import { LineParseError, parseThousandths, tokenizeLine } from "../src/parser.js";

describe("tokenizeLine", () => {
  it("ignores blank and whitespace-only lines", () => {
    expect(tokenizeLine("", 1)).toBeNull();
    expect(tokenizeLine("   \t ", 2)).toBeNull();
  });

  it("parses G0/G1 with any subset of X Y Z E", () => {
    const t = tokenizeLine("G1 X10 Y-5.5 Z0.001 E2", 1)!;
    expect(t.command).toBe("G1");
    expect([...t.params]).toEqual([
      ["X", "10"],
      ["Y", "-5.5"],
      ["Z", "0.001"],
      ["E", "2"],
    ]);
    expect(tokenizeLine("G0", 1)!.params.size).toBe(0);
  });

  it("accepts mode and coordinate commands", () => {
    expect(tokenizeLine("G90", 1)!.command).toBe("G90");
    expect(tokenizeLine("g91", 1)!.command).toBe("G91");
    expect(tokenizeLine("M82", 1)!.command).toBe("M82");
    expect(tokenizeLine("m83", 1)!.command).toBe("M83");
    const g92 = tokenizeLine("G92 E0", 1)!;
    expect(g92.command).toBe("G92");
    expect(g92.params.get("E")).toBe("0");
  });

  it("allows tabs and compact parameter syntax", () => {
    const a = tokenizeLine("G1\tX10\tY5", 1)!;
    expect([...a.params.keys()]).toEqual(["X", "Y"]);

    const b = tokenizeLine("G1X10E-1.5", 1)!;
    expect(b.command).toBe("G1");
    expect(b.params.get("X")).toBe("10");
    expect(b.params.get("E")).toBe("-1.5");

    const c = tokenizeLine("G92E-0.001", 1)!;
    expect(c.params.get("E")).toBe("-0.001");
  });

  it("rejects unknown commands", () => {
    expect(() => tokenizeLine("G2 X1", 7)).toThrowError(
      /line 7: unknown command 'G2'/,
    );
    expect(() => tokenizeLine("M104 S200", 3)).toThrowError(/line 3/);
    expect(() => tokenizeLine("T0", 1)).toThrow(LineParseError);
    expect(() => tokenizeLine("G28", 1)).toThrowError(/unknown command 'G28'/);
  });

  it("rejects repeated parameters", () => {
    try {
      tokenizeLine("G1 X1 X2", 4);
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LineParseError);
      expect((e as LineParseError).line).toBe(4);
      expect((e as LineParseError).code).toBe("DUPLICATE_PARAMETER");
    }
    expect(() => tokenizeLine("G1 E1 E2", 1)).toThrowError(/'E' is repeated/);
  });

  it("rejects parameters attached to simple mode commands", () => {
    expect(() => tokenizeLine("G90 X1", 2)).toThrowError(/line 2/);
    expect(() => tokenizeLine("M82 E5", 3)).toThrowError(/line 3/);
  });

  it("rejects G92 without E or with other parameters", () => {
    expect(() => tokenizeLine("G92", 1)).toThrowError(/G92 requires an E parameter/);
    expect(() => tokenizeLine("G92 X0 E0", 1)).toThrowError(/only accepts E/);
  });

  it("rejects numbers with more than three decimal digits", () => {
    expect(() => tokenizeLine("G1 X0.0001", 5)).toThrow(LineParseError);
    try {
      tokenizeLine("G1 X0.0001", 5);
      expect.unreachable("should throw");
    } catch (e) {
      expect((e as LineParseError).code).toBe("INVALID_NUMBER");
      expect((e as LineParseError).line).toBe(5);
    }
  });

  it("rejects malformed numeric values", () => {
    const bad: string[] = [
      "G1 X.",
      "G1 X1.", // trailing dot not allowed by the grammar
      "G1 X+-1",
      "G1 X--1",
      "G1 X0.1.2",
      "G1 Xabc",
      "G1 E",
      "G1 X+",
      "G1 X 10",
      "G1 X0.001e3",
      "G1 X1mm",
      "G1 E1.5000",
    ];
    for (const line of bad) {
      expect(() => tokenizeLine(line, 1), line).toThrow(LineParseError);
    }
  });

  it("reports MISSING_VALUE vs INVALID_NUMBER distinctly", () => {
    try {
      tokenizeLine("G1 X", 9);
      expect.unreachable();
    } catch (e) {
      expect((e as LineParseError).code).toBe("MISSING_VALUE");
    }
    try {
      tokenizeLine("G1 X.5", 9); // leading digit is required
      expect.unreachable();
    } catch (e) {
      expect((e as LineParseError).code).toBe("INVALID_NUMBER");
    }
  });

  it("rejects junk tokens and bare letters", () => {
    expect(() => tokenizeLine("; comment", 1)).toThrow(LineParseError);
    expect(() => tokenizeLine("G1 ; nope", 1)).toThrow(LineParseError);
    expect(() => tokenizeLine("G1 X1 #", 1)).toThrow(LineParseError);
    expect(() => tokenizeLine("G01 X1", 1)).toThrow(LineParseError);
  });

  it("rejects exponent notation even with uppercase E that looks like a param", () => {
    // X1e3 uses lowercase e -> invalid number (not a real param token).
    expect(() => tokenizeLine("G1 X1e3", 1)).toThrow(LineParseError);
    // X1E3 parses as X=1 followed by an E parameter without value handling:
    // E3 is actually a legal extrusion parameter, document that distinction.
    const t = tokenizeLine("G1 X1E3", 1)!;
    expect(t.params.get("X")).toBe("1");
    expect(t.params.get("E")).toBe("3");
  });
});

describe("parseThousandths", () => {
  it("converts exact decimal text without float rounding", () => {
    expect(parseThousandths("0.007", 1, "X")).toBe(7);
    expect(parseThousandths("-0.001", 1, "E")).toBe(-1);
    expect(parseThousandths("1.234", 1, "X")).toBe(1234);
    expect(parseThousandths("1.2", 1, "X")).toBe(1200);
    expect(parseThousandths("+5", 1, "X")).toBe(5000);
    expect(parseThousandths("-0", 1, "X")).toBe(0);
  });
});
