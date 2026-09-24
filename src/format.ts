/** Output formatting for the auditor. */

import type { MachineState } from './auditor.js';

/** Render integer thousandths as a fixed 3-decimal string (e.g. -1.500). */
export function formatMilli(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const intPart = Math.floor(abs / 1000);
  const fracPart = String(abs % 1000).padStart(3, '0');
  return `${sign}${intPart}.${fracPart}`;
}

/** Render the active modes as `G90/M82`-style tokens. */
export function formatMode(state: MachineState): string {
  const positioning = state.positioning === 'absolute' ? 'G90' : 'G91';
  const extrusion = state.extrusion === 'absolute' ? 'M82' : 'M83';
  return `${positioning}/${extrusion}`;
}

/** Render coordinates as `X=... Y=... Z=... E=...`. */
export function formatPosition(state: MachineState): string {
  return `X=${formatMilli(state.x)} Y=${formatMilli(state.y)} Z=${formatMilli(state.z)} E=${formatMilli(state.e)}`;
}

/** One-line, grep-friendly violation report. */
export function formatViolation(line: number, state: MachineState, threshold: number): string {
  return (
    `UNPROTECTED_TRAVEL line=${line} mode=${formatMode(state)} ` +
    `${formatPosition(state)} balance=${formatMilli(state.balance)} ` +
    `threshold=${formatMilli(threshold)}`
  );
}
