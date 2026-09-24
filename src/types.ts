/**
 * Domain types for the G-code motion auditor.
 *
 * All linear coordinates and the retraction balance are tracked as integers
 * in thousandths of a unit (millimetre), so 1.234 mm is represented as 1234.
 */

/** Positioning mode set by G90 / G91. */
export type PositioningMode = "G90" | "G91";

/** Extrusion mode set by M82 / M83. */
export type ExtrusionMode = "M82" | "M83";

/** Mutable machine state as seen before/after executing a single line. */
export interface MachineState {
  positioning: PositioningMode;
  extrusion: ExtrusionMode;
  /** Current X position in thousandths. */
  x: number;
  /** Current Y position in thousandths. */
  y: number;
  /** Current Z position in thousandths. */
  z: number;
  /** Current E (extruder) coordinate in thousandths. */
  e: number;
  /** Outstanding retraction credit in thousandths. */
  retraction: number;
}

/** Coordinate snapshot embedded in a violation report. */
export interface Coordinates {
  x: number;
  y: number;
  z: number;
  e: number;
}

/**
 * A travel move that moves in the XY plane while the outstanding retraction
 * credit is below the configured protection threshold.
 */
export interface Violation {
  code: "UNPROTECTED_TRAVEL";
  /** 1-based line number of the offending move. */
  line: number;
  /** Source text of the offending line (without line terminator). */
  text: string;
  /** Modes in effect when the move executed. */
  modes: {
    positioning: PositioningMode;
    extrusion: ExtrusionMode;
  };
  /** Coordinates after the line executed. */
  coordinates: Coordinates;
  /** Retraction balance after the line executed. */
  retraction: number;
  /** XY distance of the move in thousandths. */
  xyMove: number;
}

/** Whole-file failure caused by a malformed line. */
export interface AuditError {
  kind: "error";
  /** 1-based line number, or null when the failure is not tied to a line. */
  line: number | null;
  code:
    | "UNKNOWN_COMMAND"
    | "DUPLICATE_PARAMETER"
    | "UNEXPECTED_PARAMETER"
    | "INVALID_NUMBER"
    | "NON_FINITE_NUMBER"
    | "MISSING_VALUE"
    | "VALUE_OUT_OF_RANGE"
    | "TOO_MANY_LINES";
  message: string;
}

export interface AuditClean {
  kind: "clean";
  state: MachineState;
}

export interface AuditViolation {
  kind: "violation";
  violation: Violation;
  /** State at the moment of the first violation (same snapshot as in the report). */
  state: MachineState;
}

export type AuditResult = AuditClean | AuditViolation;
