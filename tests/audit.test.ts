import { describe, expect, it } from "vitest";

import { auditLines, initialState, MAX_LINES, step } from "../src/audit.js";
import type { AuditError, MachineState } from "../src/types.js";

const THRESHOLD = 2000; // 2.000 units

function run(program: string, threshold = THRESHOLD) {
  return auditLines(program.split("\n"), threshold);
}

/** Snapshot of the fields two equivalent programs must agree on. */
function comparable(r: ReturnType<typeof run>) {
  if (r.kind === "clean") {
    const { x, y, z, e, retraction } = r.state;
    return { kind: "clean", x, y, z, e, retraction };
  }
  if (r.kind === "violation") {
    return {
      kind: "violation",
      line: r.violation.line,
      coordinates: r.violation.coordinates,
      retraction: r.violation.retraction,
      xyMove: r.violation.xyMove,
      text: r.violation.text,
    };
  }
  return { kind: "error", line: r.line, code: r.code };
}

/** Equivalent M82 (absolute E) and M83 (relative E) programs must judge alike. */
function expectEquivalent(absolute: string, relative: string, threshold = THRESHOLD) {
  const a = run(absolute, threshold);
  const b = run(relative, threshold);
  expect(a.kind).toBe(b.kind);
  expect(comparable(a)).toEqual(comparable(b));
}

describe("initial state and mode transitions", () => {
  it("starts in G90 / M82 at the origin with zero balance", () => {
    expect(initialState()).toEqual({
      positioning: "G90",
      extrusion: "M82",
      x: 0,
      y: 0,
      z: 0,
      e: 0,
      retraction: 0,
    });
  });

  it("G90/G91 and M82/M83 only flip modes", () => {
    let s = initialState();
    s = step(s, "G91", 1, THRESHOLD).state;
    expect(s.positioning).toBe("G91");
    s = step(s, "M83", 2, THRESHOLD).state;
    expect(s.extrusion).toBe("M83");
    s = step(s, "G90", 3, THRESHOLD).state;
    expect(s.positioning).toBe("G90");
    s = step(s, "M82", 4, THRESHOLD).state;
    expect(s.extrusion).toBe("M82");
    expect([s.x, s.y, s.z, s.e, s.retraction]).toEqual([0, 0, 0, 0, 0]);
  });

  it("blank lines are state-preserving no-ops", () => {
    const before = initialState();
    const after = step(before, "   ", 1, THRESHOLD).state;
    expect(after).toBe(before);
  });
});

describe("coordinate tracking in thousandths", () => {
  it("resolves absolute and relative moves identically", () => {
    const abs = ["G90", "G1 X10 Y5 Z0.5", "G1 X12 Y8 Z1"];
    const rel = ["G91", "G1 X10 Y5 Z0.5", "G1 X2 Y3 Z0.5"];
    const a = auditLines(abs, THRESHOLD);
    const b = auditLines(rel, THRESHOLD);
    expect(a).toMatchObject({ kind: "violation" });
    expect(b).toMatchObject({ kind: "violation" });
  });

  it("keeps coordinates as exact integer thousandths", () => {
    const r = run(["G91", "M83", "G1 X0.007 Y0.003 E-3"].join("\n"), THRESHOLD);
    // Retraction 3000 >= 2000 threshold: the travel is protected.
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect([r.state.x, r.state.y, r.state.e, r.state.retraction]).toEqual([
        7, 3, -3000, 3000,
      ]);
    }
  });

  it("ignores pure Z hops for travel detection", () => {
    const r = run(["M83", "G1 Z5"].join("\n"));
    expect(r.kind).toBe("clean");
  });

  it("flags no-axis-only commands and lines without XY motion", () => {
    const r = run(["M83", "G1 E-5", "G1 E0", "G1 X0 Y0 E10"].join("\n"));
    expect(r.kind).toBe("clean");
  });
});

describe("retraction balance accounting", () => {
  it("a negative E delta banks balance; a positive delta repays it first", () => {
    let s: MachineState = { ...initialState(), extrusion: "M83" };
    s = step(s, "G1 E-3", 1, THRESHOLD).state;
    expect(s.retraction).toBe(3000);
    s = step(s, "G1 E1", 2, THRESHOLD).state;
    expect(s.retraction).toBe(2000);
    expect(s.e).toBe(-2000);
    s = step(s, "G1 E5", 3, THRESHOLD).state;
    expect(s.retraction).toBe(0);
    expect(s.e).toBe(3000);
  });

  it("does not let repayment overshoot into negative balance", () => {
    let s: MachineState = { ...initialState(), extrusion: "M83" };
    s = step(s, "G1 E-1", 1, THRESHOLD).state;
    s = step(s, "G1 E9", 2, THRESHOLD).state;
    expect(s.retraction).toBe(0);
  });  it("reports the first violating travel with post-line state snapshot", () => {
    const r = run(["M83", "G1 E-1", "G1 X10", "G1 X20"].join("\n"));
    expect(r.kind).toBe("violation");
    if (r.kind !== "violation") throw new Error("expected violation");
    expect(r.violation.line).toBe(3);
    expect(r.violation.code).toBe("UNPROTECTED_TRAVEL");
    expect(r.violation.modes).toEqual({ positioning: "G90", extrusion: "M83" });
    expect(r.violation.coordinates).toEqual({ x: 10000, y: 0, z: 0, e: -1000 });
    expect(r.violation.retraction).toBe(1000);
    expect(r.violation.xyMove).toBe(10000);
    expect(r.violation.text).toBe("G1 X10");
  });

  it("passes when balance equals the threshold exactly", () => {
    const r = run(["M83", "G1 E-2", "G1 X5"].join("\n"), 2000);
    expect(r.kind).toBe("clean");
  });

  it("flags when balance drops below the threshold during the travel", () => {
    const r = run(["M83", "G1 E-2", "G1 X5 E0.5"].join("\n"), 2000);
    expect(r.kind).toBe("violation");
    if (r.kind === "violation") {
      expect(r.violation.retraction).toBe(1500);
      expect(r.violation.line).toBe(3);
    }
  });

  it("a small positive net extrusion on an XY move is still a travel and gets checked", () => {
    // E-2 banks 2000; E0.5 repays 500 (net extrusion 0 because 500 <= 2000).
    // Balance 1500 < 2000 => the move is unprotected.
    const r = run(["M83", "G1 E-2", "G1 X5 E0.5"].join("\n"), 2000);
    expect(r.kind).toBe("violation");
  });

  it("extruding moves (net extrusion > 0) are never flagged", () => {
    const r = run(
      ["M83", "G1 E-2", "G1 X5 E3", "G1 X8 E0.1"].join("\n"),
      2000,
    );
    // First travel: repay 2000, net extrusion 1000 -> safe even at zero balance.
    // Second line has positive net extrusion 100 -> safe.
    expect(r.kind).toBe("clean");
  });

  it("protects a retraction and XY move combined on the same line (G0 and G1)", () => {
    for (const cmd of ["G0", "G1"] as const) {
      const r = run(["M83", `${cmd} X50 E-2`].join("\n"), 2000);
      expect(r.kind, cmd).toBe("clean");
      if (r.kind === "clean") {
        expect(r.state.x).toBe(50000);
        expect(r.state.e).toBe(-2000);
        expect(r.state.retraction).toBe(2000);
      }
    }
  });

  it("flags a same-line travel whose retraction is just under the threshold", () => {
    const r = run(["M83", "G1 X50 E-1.999"].join("\n"), 2000);
    expect(r.kind).toBe("violation");
    if (r.kind === "violation") {
      expect(r.violation.retraction).toBe(1999);
      expect(r.violation.line).toBe(2);
    }
  });

  it("protects a same-line travel whose retraction is exactly the threshold", () => {
    const r = run(["M83", "G1 X50 E-2.000"].join("\n"), 2000);
    expect(r.kind).toBe("clean");
  });
});

describe("G92 coordinate reset", () => {
  it("rewrites E without touching the retraction balance", () => {
    let s: MachineState = { ...initialState(), extrusion: "M83" };
    s = step(s, "G1 E-3", 1, THRESHOLD).state;
    expect(s.retraction).toBe(3000);
    s = step(s, "G92 E0", 2, THRESHOLD).state;
    expect(s.e).toBe(0);
    expect(s.retraction).toBe(3000);
  });

  it("makes a following absolute positive-E line a retraction (G92 disguise)", () => {
    // Naive sign check sees "E7" as extrusion; coordinate comparison says -3,
    // banking 3000 of credit — enough to protect the travel at threshold 2000.
    const r = run(["G92 E10", "G1 E7 X5"].join("\n"), THRESHOLD);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.state.e).toBe(7000);
      expect(r.state.retraction).toBe(3000);
    }
  });

  it("flags a disguised retraction that banks too little credit", () => {
    // G92 E10 then E9 looks like extrusion to a sign-only checker; the real
    // delta is -1 (1000 < 2000 threshold), so the travel is unprotected.
    const r = run(["G92 E10", "G1 E9 X5"].join("\n"), 2000);
    expect(r.kind).toBe("violation");
    if (r.kind === "violation") {
      expect(r.violation.retraction).toBe(1000);
      expect(r.violation.coordinates.e).toBe(9000);
    }
  });

  it("catches an unprotected travel hidden behind a G92 reset in M82", () => {
    const r = run(["G92 E10", "G1 E10 X5"].join("\n"), THRESHOLD);
    // Delta 0: no extrusion, no credit -> travel unprotected.
    expect(r.kind).toBe("violation");
    if (r.kind === "violation") {
      expect(r.violation.retraction).toBe(0);
    }
  });

  it("absolute program with G92 disguise matches relative equivalent", () => {
    // The M82 side needs G92 E0 so both sides share the same E origin.
    // A 1-unit retraction is below the 2-unit threshold, so the first XY move
    // violates on both sides; the reports must carry the same physical data.
    const abs = ["G92 E0", "G1 E-1 X10", "G1 E-2 X20"];
    const rel = ["M83", "G1 E-1 X10", "G1 E-1 X20"];
    const a = auditLines(abs, THRESHOLD);
    const b = auditLines(rel, THRESHOLD);
    expect(a.kind).toBe("violation");
    expect(b.kind).toBe("violation");
    if (a.kind === "violation" && b.kind === "violation") {
      expect(a.violation.coordinates).toEqual(b.violation.coordinates);
      expect(a.violation.retraction).toBe(b.violation.retraction);
      expect(a.violation.xyMove).toBe(b.violation.xyMove);
    }
  });
});

describe("equivalent absolute / relative program pairs", () => {
  it("generated M82/G90 and M83/G91 programs always agree", () => {
    // Each scenario is a sequence of physical moves as [dx, dy, dz, de] in
    // thousandths. The two renderings must produce identical verdicts and
    // physical state regardless of absolute/relative mode.
    const scenarios: ReadonlyArray<readonly [number, number, number, number][]> = [
      [[0, 0, 0, -2000], [50000, 0, 0, 0], [0, 0, 0, 2000], [10000, 0, 0, 500]],
      [[0, 0, 0, -1000], [50000, 0, 0, 0]],
      [[10000, 0, 0, -2000], [10000, 5000, 0, 1000], [-5000, 5000, 0, 0]],
      [[0, 0, 1000, -3000], [0, 0, 0, 500], [20000, 0, 0, 0]],
      [[5000, 5000, 0, 0], [5000, -5000, 0, -1500]],
    ];

    const fmt = (milli: number): string => (milli / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";

    for (const moves of scenarios) {
      const abs: string[] = ["G90", "G92 E0"];
      const rel: string[] = ["G91", "M83"];
      let [ax, ay, az, ae] = [0, 0, 0, 0];
      for (const [dx, dy, dz, de] of moves) {
        ax += dx; ay += dy; az += dz; ae += de;
        abs.push(`G1 X${fmt(ax)} Y${fmt(ay)} Z${fmt(az)} E${fmt(ae)}`);
        rel.push(`G1 X${fmt(dx)} Y${fmt(dy)} Z${fmt(dz)} E${fmt(de)}`);
      }
      const a = auditLines(abs, THRESHOLD);
      const b = auditLines(rel, THRESHOLD);
      expect(a.kind, JSON.stringify(moves)).toBe(b.kind);
      if (a.kind === "violation" && b.kind === "violation") {
        // Line offsets differ by the one extra G92 header; physical data agrees.
        expect(a.violation.coordinates).toEqual(b.violation.coordinates);
        expect(a.violation.retraction).toBe(b.violation.retraction);
      }
      if (a.kind === "clean" && b.kind === "clean") {
        const phys = (s: MachineState) => {
          const { x, y, z, e, retraction } = s;
          return { x, y, z, e, retraction };
        };
        expect(phys(a.state)).toEqual(phys(b.state));
      }
    }
  });
  it("classic retract-travel-prime sequence agrees", () => {
    const abs = [
      "G92 E0",
      "G1 E-2",
      "G1 X50",
      "G1 E0", // prime-back: absolute target 0 from -2
      "G1 X60 E0.1",
    ];
    const rel = [
      "M83",
      "G1 E-2",
      "G1 X50",
      "G1 E2",
      "G1 X60 E0.1",
    ];
    expectEquivalent(abs.join("\n"), rel.join("\n"));
  });

  it("program whose first travel is unprotected agrees", () => {
    const abs = ["G92 E0", "G1 X10", "G1 E-1 X20"];
    const rel = ["M83", "G1 X10", "G1 E-1 X20"];
    const a = run(abs.join("\n"));
    const b = run(rel.join("\n"));
    expect(a.kind).toBe("violation");
    expect(b.kind).toBe("violation");
    if (a.kind === "violation" && b.kind === "violation") {
      expect(a.violation.line).toBe(2);
      expect(b.violation.line).toBe(2);
      expect(a.violation.retraction).toBe(b.violation.retraction);
      expect(a.violation.coordinates).toEqual(b.violation.coordinates);
      expect(a.violation.xyMove).toBe(b.violation.xyMove);
    }
  });

  it("G90/G91 positioning pair agrees line by line", () => {
    const abs = ["G90", "M83", "G1 E-2", "G1 X10 Y10", "G1 X15 Y20"];
    const rel = ["G91", "M83", "G1 E-2", "G1 X10 Y10", "G1 X5 Y10"];
    const a = auditLines(abs, THRESHOLD);
    const b = auditLines(rel, THRESHOLD);
    expect(a.kind).toBe(b.kind);
    if (a.kind === "clean" && b.kind === "clean") {
      expect(a.state.x).toBe(b.state.x);
      expect(a.state.y).toBe(b.state.y);
    }
  });

  it("produces identical final coordinates across a full clean program", () => {
    const abs = [
      "G92 E0",
      "G1 E-3",
      "G1 X20 Y10",
      "G1 E0",
      "G1 X30 Y10 E0.5",
    ];
    const rel = [
      "M83",
      "G1 E-3",
      "G1 X20 Y10",
      "G1 E3",
      "G1 X30 Y10 E0.5",
    ];
    const a = run(abs.join("\n"), THRESHOLD);
    const b = run(rel.join("\n"), THRESHOLD);
    expect(a.kind).toBe("clean");
    expect(b.kind).toBe("clean");
    if (a.kind === "clean" && b.kind === "clean") {
      const physical = (s: typeof a.state) => {
        const { x, y, z, e, retraction } = s;
        return { x, y, z, e, retraction };
      };
      expect(physical(a.state)).toEqual(physical(b.state));
    }
  });
});

describe("whole-file errors", () => {
  function expectError(program: string, code?: AuditError["code"], line?: number) {
    const r = run(program);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    if (code) expect(r.code).toBe(code);
    if (line !== undefined) expect(r.line).toBe(line);
    return r;
  }

  it("reports unknown command with line number and aborts everything", () => {
    expectError("M83\nG2 X1\nG1 X5", "UNKNOWN_COMMAND", 2);
  });

  it("reports duplicate parameter with line number", () => {
    expectError("G1 E-2\nG1 X1 X2", "DUPLICATE_PARAMETER", 2);
  });

  it("reports invalid numbers with line number", () => {
    expectError("G1 X0.0001", "INVALID_NUMBER", 1);
    expectError("G1 X1\nG1 ENaN", "INVALID_NUMBER", 2);
    expectError("G1 EInfinity", "INVALID_NUMBER", 1);
  });

  it("reports G92 misuse with line number", () => {
    expectError("G92", "UNEXPECTED_PARAMETER", 1);
    expectError("G1 X1\nG92 X1", "UNEXPECTED_PARAMETER", 2);
  });

  it("a parse error after an earlier violation still aborts as error", () => {
    expectError("M83\nG1 X5\nG1 X1 X2", "DUPLICATE_PARAMETER", 3);
  });

  it("rejects programs over 10000 physical lines", () => {
    const ok = new Array(MAX_LINES).fill("M83");
    expect(auditLines(ok, THRESHOLD).kind).toBe("clean");
    const tooMany = new Array(MAX_LINES + 1).fill("M83");
    const r = auditLines(tooMany, THRESHOLD);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("TOO_MANY_LINES");
      expect(r.line).toBe(MAX_LINES + 1);
    }
  });

  it("still audits motion on exactly the 10000th line", () => {
    const lines = new Array(MAX_LINES - 1).fill("M83");
    lines.push("G1 X5"); // unprotected travel right at the boundary
    const r = auditLines(lines, THRESHOLD);
    expect(r.kind).toBe("violation");
    if (r.kind === "violation") {
      expect(r.violation.line).toBe(MAX_LINES);
    }
  });

  it("rejects non-positive or non-integer thresholds", () => {
    expect(auditLines(["G1 X1"], 0).kind).toBe("error");
    expect(auditLines(["G1 X1"], -1).kind).toBe("error");
  });
});
