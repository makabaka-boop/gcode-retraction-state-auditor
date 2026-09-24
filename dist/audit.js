/**
 * State machine implementing the retraction/travel audit.
 *
 * The auditor tracks every axis in integer thousandths and keeps a single
 * retraction balance:
 *
 *   - a negative E delta (retraction) ADDS its magnitude to the balance;
 *   - a positive E delta first pays the balance back, any remainder extrudes;
 *   - G92 E only rewrites the E coordinate, it never touches the balance.
 *
 * Because deltas are derived from the previous E coordinate, absolute (M82)
 * and relative (M83) programs that encode the same physical moves produce
 * identical balances and verdicts. G92 can disguise a retraction in M82
 * mode ("G92 E10" followed by "G1 E9") and is handled correctly.
 */
import { LineParseError, parseThousandths, tokenizeLine, } from "./parser.js";
export const MAX_LINES = 10_000;
export function initialState() {
    return {
        positioning: "G90", // G90 absolute positioning is the machine default
        extrusion: "M82", // M82 absolute extrusion is the machine default
        x: 0,
        y: 0,
        z: 0,
        e: 0,
        retraction: 0,
    };
}
/**
 * Apply one physical line to the state.
 *
 * Blank lines leave the state untouched. Returns the new state plus, when the
 * line is the first offending travel move, a {@link Violation}. Throws
 * {@link LineParseError} for any malformed line; such an error aborts the
 * whole audit per the specification.
 */
export function step(state, rawLine, lineNumber, threshold) {
    const token = tokenizeLine(rawLine, lineNumber);
    if (token === null) {
        return { state, violation: null };
    }
    let next = { ...state };
    switch (token.command) {
        case "G90":
            next.positioning = "G90";
            return { state: next, violation: null };
        case "G91":
            next.positioning = "G91";
            return { state: next, violation: null };
        case "M82":
            next.extrusion = "M82";
            return { state: next, violation: null };
        case "M83":
            next.extrusion = "M83";
            return { state: next, violation: null };
        case "G92": {
            // G92 rewrites the current E coordinate only; the balance is untouched.
            const eText = token.params.get("E"); // validated by tokenizer
            next.e = parseThousandths(eText, lineNumber, "E");
            return { state: next, violation: null };
        }
        case "G0":
        case "G1":
            return applyMotion(next, { command: token.command, params: token.params }, lineNumber, threshold, rawLine);
    }
}
function applyMotion(state, token, lineNumber, threshold, rawLine) {
    const get = (letter) => {
        const text = token.params.get(letter);
        return text === undefined ? undefined : parseThousandths(text, lineNumber, letter);
    };
    // Resolve axis target/delta from the current positioning mode.
    const resolve = (letter, current) => {
        const value = get(letter);
        if (value === undefined) {
            return current;
        }
        return state.positioning === "G91" ? current + value : value;
    };
    const startX = state.x;
    const startY = state.y;
    state.x = resolve("X", state.x);
    state.y = resolve("Y", state.y);
    state.z = resolve("Z", state.z);
    const dx = state.x - startX;
    const dy = state.y - startY;
    const xyMove = Math.abs(dx) + Math.abs(dy);
    // Resolve the E delta from the current extrusion mode. In M82 mode it is
    // target minus stored coordinate, which is what defeats a naive sign check
    // after G92.
    const eValue = get("E");
    let eDelta = 0;
    if (eValue !== undefined) {
        if (state.extrusion === "M83") {
            eDelta = eValue;
            state.e = state.e + eValue;
        }
        else {
            eDelta = eValue - state.e;
            state.e = eValue;
        }
    }
    // Balance accounting: a retraction banks credit; a positive delta first
    // repays the balance and only the remainder is positive net extrusion.
    let netExtrusion = 0;
    if (eDelta < 0) {
        state.retraction += -eDelta;
    }
    else if (eDelta > 0) {
        const repay = Math.min(state.retraction, eDelta);
        state.retraction -= repay;
        netExtrusion = eDelta - repay;
    }
    // A travel with an XY component and no positive net extrusion is only safe
    // while enough retraction credit remains after this line.
    let violation = null;
    if (xyMove > 0 && netExtrusion <= 0 && state.retraction < threshold) {
        violation = {
            code: "UNPROTECTED_TRAVEL",
            line: lineNumber,
            text: rawLine.trim(),
            modes: {
                positioning: state.positioning,
                extrusion: state.extrusion,
            },
            coordinates: { x: state.x, y: state.y, z: state.z, e: state.e },
            retraction: state.retraction,
            xyMove,
        };
    }
    return { state, violation };
}
/**
 * Audit a complete program. Processing stops at the first violation and
 * returns it; any malformed line aborts the whole program with an error.
 *
 * @param lines physical lines without terminators (caller splits the file)
 * @param threshold retraction threshold in thousandths, a positive integer
 */
export function auditLines(lines, threshold, maxLines = MAX_LINES) {
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
        return {
            kind: "error",
            line: null,
            code: "VALUE_OUT_OF_RANGE",
            message: "threshold must be a positive integer in thousandths",
        };
    }
    if (lines.length > maxLines) {
        return {
            kind: "error",
            line: maxLines + 1,
            code: "TOO_MANY_LINES",
            message: `program exceeds the ${maxLines}-line limit (${lines.length} lines)`,
        };
    }
    let state = initialState();
    try {
        // Parsing and execution are separate passes: a malformed line anywhere in
        // the file must fail the WHOLE program, even if an earlier line would have
        // raised UNPROTECTED_TRAVEL.
        const tokens = lines.map((line, i) => tokenizeLine(line, i + 1));
        for (let i = 0; i < tokens.length; i += 1) {
            const token = tokens[i];
            if (token === null) {
                continue;
            }
            const result = applyToken(state, token, i + 1, threshold, lines[i]);
            state = result.state;
            if (result.violation !== null) {
                return { kind: "violation", violation: result.violation, state };
            }
        }
    }
    catch (err) {
        if (err instanceof LineParseError) {
            return {
                kind: "error",
                line: err.line,
                code: err.code,
                message: err.message,
            };
        }
        throw err;
    }
    return { kind: "clean", state };
}
function applyToken(stateIn, token, lineNumber, threshold, rawLine) {
    let next = { ...stateIn };
    switch (token.command) {
        case "G90":
            next.positioning = "G90";
            return { state: next, violation: null };
        case "G91":
            next.positioning = "G91";
            return { state: next, violation: null };
        case "M82":
            next.extrusion = "M82";
            return { state: next, violation: null };
        case "M83":
            next.extrusion = "M83";
            return { state: next, violation: null };
        case "G92": {
            // G92 rewrites the current E coordinate only; the balance is untouched.
            const eText = token.params.get("E"); // validated by tokenizer
            next.e = parseThousandths(eText, lineNumber, "E");
            return { state: next, violation: null };
        }
        case "G0":
        case "G1":
            return applyMotion(next, { command: token.command, params: token.params }, lineNumber, threshold, rawLine);
    }
}
