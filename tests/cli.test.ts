import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

function runWith(content: string, ...argv: string[]) {
  return runCli(argv, { readFile: () => content });
}

describe("motion-audit CLI", () => {
  it("prints CLEAN and exits 0 for a protected program", () => {
    const out = runWith("M83\nG1 E-2\nG1 X10\n", "part.gcode", "2000");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("CLEAN");
    expect(out.stderr).toBe("");
  });

  it("prints the JSON report and exits 2 on the first violation", () => {
    const out = runWith("M83\nG1 X10\n", "part.gcode", "2000");
    expect(out.exitCode).toBe(2);
    const report = JSON.parse(out.stdout) as {
      code: string;
      line: number;
      coordinates: { x: number };
      retraction: number;
      modes: { positioning: string; extrusion: string };
    };
    expect(report.code).toBe("UNPROTECTED_TRAVEL");
    expect(report.line).toBe(2);
    expect(report.coordinates.x).toBe(10000);
    expect(report.retraction).toBe(0);
    expect(report.modes.extrusion).toBe("M83");
    expect(out.stderr).toBe("");
  });

  it("reports a malformed line on stderr and exits 1", () => {
    const out = runWith("G1 X1\nG1 X2 X3\n", "part.gcode", "2000");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("DUPLICATE_PARAMETER");
    expect(out.stderr).toContain("line 2");
    expect(out.stdout).toBe("");
  });

  it("reports the line number for files over 10000 lines", () => {
    const big = new Array(10001).fill("M83").join("\n");
    const out = runWith(big, "part.gcode", "2000");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("TOO_MANY_LINES");
    expect(out.stderr).toContain("line 10001");
  });

  it("validates the threshold argument", () => {
    expect(runWith("M83", "p.g", "0").exitCode).toBe(1);
    expect(runWith("M83", "p.g", "-1").exitCode).toBe(1);
    expect(runWith("M83", "p.g", "1.5").exitCode).toBe(1);
    expect(runWith("M83", "p.g", "abc").exitCode).toBe(1);
  });

  it("requires exactly two positional arguments", () => {
    const out = runWith("", "p.g");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("usage");
  });

  it("reports unreadable files", () => {
    const out = runCli(["missing.gcode", "2000"], {
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("cannot read");
  });

  it("counts physical lines the same way the CLI splits CRLF input", () => {
    const out = runWith("M83\r\nG1 E-2\r\nG1 X5\r\n", "p.g", "2000");
    expect(out.exitCode).toBe(0);
  });
});
