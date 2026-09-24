# motion-audit

A small TypeScript command-line auditor for G-code travel moves. It finds the
first travel that crosses empty space without enough retraction behind it —
the move that causes stringing/oozing.

Unlike a naive checker that only looks at the sign of the `E` word on a line,
motion-audit derives the real extruder **delta** from the previous E
coordinate, so it is not fooled by:

- **M82 absolute extrusion** (a move to `E9` after `G92 E10` is a −1
  retraction, not extrusion);
- **M83 relative extrusion**;
- **G92 E** coordinate resets (which rewrite the E coordinate only and never
  touch the retraction balance);
- **G90/G91** absolute/relative XYZ positioning.

## Accepted dialect

Only these lines are accepted; anything else fails the whole file with a line
number:

| Command | Allowed parameters |
| ------- | ------------------ |
| `G0`, `G1` | `X`, `Y`, `Z`, `E` |
| `G90`, `G91` | none |
| `M82`, `M83` | none |
| `G92` | `E` only |

Numbers are signed decimals with **at most three fractional digits**
(e.g. `10`, `-2.5`, `+0.001`). Exponents, `NaN`, `Infinity`, repeated
parameters, unknown commands and missing/non-finite values are all rejected.

## Accounting

All coordinates and the retraction balance are stored as integer
**thousandths**, so there is no floating-point drift (`0.007` is exactly `7`).

- A **negative E delta** adds its magnitude to the retraction balance.
- A **positive E delta** first repays the balance; only the remainder is
  positive net extrusion.
- **G92 E** rewrites the E coordinate and nothing else.

A line is reported as `UNPROTECTED_TRAVEL` when, after executing the line:

1. it produced an XY displacement, and
2. it produced no positive net extrusion, and
3. the remaining retraction balance is **below** the threshold.

The first violating line stops the audit. Balance equal to the threshold is
still protected.

## Usage

```
motion-audit <file.gcode> <threshold-thousandths>
```

The threshold is a positive integer in thousandths: `2000` means 2.000 units.
Files may contain at most 10000 physical lines.

Exit codes: `0` clean · `2` first UNPROTECTED_TRAVEL · `1` malformed input,
bad arguments, or file too long.

```console
$ node dist/cli.js examples/oozing.gcode 2000
{
  "code": "UNPROTECTED_TRAVEL",
  "line": 5,
  "text": "G1 X60 Y10",
  "modes": { "positioning": "G90", "extrusion": "M82" },
  "coordinates": { "x": 60000, "y": 10000, "z": 0, "e": 500 },
  "retraction": 0,
  "xyMove": 60000
}
```

## Docker Compose

The `motion-audit` container builds the TypeScript and audits a file mounted
read-only at `/input`:

```console
docker compose build
docker compose run --rm motion-audit /input/example.gcode 2000
```

The container exit code is the CLI exit code above.

## Development

```console
npm install
npm test        # Vitest: parser, state transitions, abs/rel pairs, CLI
npm run build   # tsc -> dist/
```

The Vitest suite covers state transitions, retraction/repayment bookkeeping,
equivalent M82↔M83 and G90↔G91 program pairs (differential testing),
same-line retraction+travel, G92 disguises, and every malformed-input class.
