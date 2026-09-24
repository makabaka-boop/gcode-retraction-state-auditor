# motion-audit

G-code travel-move retraction auditor. It flags **UNPROTECTED_TRAVEL** moves:
XY travel across empty space where the filament has not been retracted enough,
so the nozzle strings along the move.

Unlike a naive per-line check of the E word's sign, motion-audit tracks the
full extrusion state, so it is not fooled by:

- **absolute vs. relative extrusion** (`M82`/`M83`) — in absolute mode
  `G1 E3` can be a retraction (from E=5) and `G1 E-1` after `G92 E0` is a
  1-unit retraction, not a coordinate jump;
- **`G92 E` origin resets** — only the E coordinate is redefined; the
  physical retraction balance is untouched;
- **deretraction** — positive E first repays the outstanding retraction
  balance; only the remainder counts as net extrusion.

## Model

All coordinates and the retraction balance are tracked as integers in
thousandths of a unit ("millis"), so mode switches and resets are exact.

- `G90`/`G91` select absolute/relative positioning for X, Y, Z.
- `M82`/`M83` select absolute/relative extrusion for E (independent of G90/G91).
- `G92 E<v>` redefines the E coordinate origin only.
- A negative E delta adds to the retraction balance; a positive delta first
  repays the balance, and any remainder is net extrusion.
- A `G0`/`G1` move that displaces X or Y **without positive net extrusion**
  is a travel move: after applying the line's E change, if the balance is
  **below the threshold**, the move is reported as `UNPROTECTED_TRAVEL`.
  A travel that retracts enough on its own line is protected.

## Accepted G-code subset

```
G0 / G1   X<v> Y<v> Z<v> E<v>   (each parameter at most once)
G90 / G91                        (no parameters)
M82 / M83                        (no parameters)
G92 E<v>                         (E only)
```

Values are signed decimals with at most three decimal places (`12`, `-1.5`,
`+0.125`, `.25`). Blank lines and `;` comments are ignored. Unknown commands,
unknown or duplicate parameters, and malformed or non-finite values abort the
whole file with an error naming the 1-based line number. Files are limited to
10000 lines.

## Usage

```
motion-audit --threshold <positive integer millis> <file.gcode>
```

The threshold is a positive integer in thousandths of a unit: `1500` means
travels need at least 1.500 units of outstanding retraction.

Exit codes: `0` clean, `1` unprotected travel found, `2` usage/parse/file error.

```
$ motion-audit --threshold 1500 samples/stringing.gcode
UNPROTECTED_TRAVEL line=8 mode=G90/M83 X=40.000 Y=40.000 Z=0.200 E=-0.500 balance=0.500 threshold=1.500
```

The report names the first violating line and the machine state after that
line executed: active modes, X/Y/Z/E coordinates, retraction balance, and the
configured threshold.

## Docker Compose

```
docker compose run --rm motion-audit                                   # audits samples/stringing.gcode
docker compose run --rm motion-audit --threshold 1500 /samples/clean.gcode
docker compose run --rm -v "$PWD:/data:ro" motion-audit -t 1500 /data/print.gcode
```

## Development

```
npm install
npm test        # Vitest: parser, state transitions, absolute/relative 对拍
npm run build   # compile to dist/
npm run audit -- --threshold 1500 samples/clean.gcode
```
