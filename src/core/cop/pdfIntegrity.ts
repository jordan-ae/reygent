/**
 * Resume PDF integrity checks for the Cop Tool (no dependencies).
 *
 * Verifies that a compiled resume is a real, complete PDF of 1–2 pages with no text
 * drawn on top of other text. Anything that cannot be verified is reported as an
 * issue, so an unreadable file is never waved through.
 */

import fs from "node:fs";
import zlib from "node:zlib";

import { expandHome } from "@/core/config";

// A PDF is bytes, and JavaScript regexes only run on strings, so the file is decoded as
// latin1: one char per byte, nothing lost. \b and \d are ASCII-only without the `u` flag,
// which is what a byte-level grammar needs. Whitespace is spelled out as [ \t\n\r\f\v],
// because \s would also match 0xA0, a byte that is not whitespace in a PDF.
const STREAM_RX = /stream\r?\n(.*?)endstream/gs;
const PAGE_RX = /\/Type[ \t\n\r\f\v]*\/Page(?![A-Za-z])/g;
const TEXT_OBJECT_RX = /\bBT\b.*?\bET\b/s;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)`;
/** One token of a content stream: a string, a number, a name, an array bracket or an operator. */
export const TOKEN_RX = new RegExp(
  String.raw`\((?:\\.|[^\\()])*\)` + // literal string
    String.raw`|<[0-9A-Fa-f \t\n\r\f\v]*>` + // hex string
    `|${NUMBER}` +
    String.raw`|/[^ \t\n\r\f\v/\[\]()<>]*` + // name
    String.raw`|[\[\]]|[A-Za-z'"*]+`, // array delimiter or operator
  "gs",
);
const NUMBER_RX = new RegExp(`^${NUMBER}$`);
const BLANK_STRING_RX = /^(?:\([ \t\n\r\f\v]*\)|<[ \t\n\r\f\v]*>)$/;
export const OPERATOR_RX = /^(?:[A-Za-z]|['"]$)/;

/** A transformation matrix [a b c d e f]; a malformed stream can leave it short. */
export type Matrix = readonly number[];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The content stream does not follow the operator grammar, so its layout cannot be trusted. */
export class LayoutError extends Error {}

/**
 * Round to `digits` decimals like Python's `round()`: the result is correctly rounded
 * from the exact binary value, and an exact tie goes to the even neighbour.
 *
 * `toFixed` is exact too but sends ties upward (72.25 -> "72.3", Python 72.2), so two
 * origins a hair apart could be merged by one implementation and not by the other.
 */
export function roundHalfEven(value: number, digits: number): number {
  // A tie means value × 10^digits ends in exactly .5, i.e. value × 2^(digits+1) is an odd
  // integer. Scaling by a power of two is exact, so this test has no rounding error.
  const odd = value * 2 ** (digits + 1);
  if (value === 0) return value; // toFixed would drop the sign of -0
  if (!Number.isInteger(odd) || odd % 2 === 0) return Number(value.toFixed(digits));
  const doubled = BigInt(odd) * 5n ** BigInt(digits); // 2 × value × 10^digits
  const lower = (doubled - 1n) / 2n;
  return Number(`${lower % 2n === 0n ? lower : lower + 1n}e-${digits}`);
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  if (m.length !== 6 || n.length !== 6) throw new LayoutError("a matrix needs six numbers");
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = n;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

export function toNumber(token: string): number {
  if (!NUMBER_RX.test(token)) throw new LayoutError(`expected a number, found '${token}'`);
  return Number(token);
}

/** Every stream body as latin1 text, inflated when it is Flate-compressed. */
function decodedStreams(raw: string): string[] {
  const streams: string[] = [];
  for (const match of raw.matchAll(STREAM_RX)) {
    const body = match[1];
    try {
      // Z_SYNC_FLUSH keeps whatever inflated cleanly from a truncated stream instead of
      // throwing, and bytes after the end of the stream (the EOL before "endstream") are
      // ignored. Bodies that are not Flate data at all throw and are kept as they are.
      const inflated = zlib.inflateSync(Buffer.from(body, "latin1"), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      streams.push(inflated.toString("latin1"));
    } catch {
      streams.push(body);
    }
  }
  return streams;
}

/** Page content is operator text; embedded fonts and images are binary. */
function isContentStream(data: string): boolean {
  if (!TEXT_OBJECT_RX.test(data)) return false;
  let printable = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data.charCodeAt(i);
    if ((byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13) printable++;
  }
  return printable >= 0.85 * data.length;
}

/**
 * Count places in a content stream where text is drawn twice at the same origin.
 *
 * Tracks the graphics state (q/Q/cm) and text positioning (Tm/Td/TD/T*) and records
 * where each run of text starts. Only explicitly positioned runs are compared,
 * since the advance after a run depends on font metrics.
 */
function overlappingTextOrigins(content: string): number {
  let ctm = IDENTITY;
  const saved: Matrix[] = [];
  let line = IDENTITY;
  let leading = 0;
  let positioned = false;
  let operands: string[] = [];
  const origins = new Map<string, number>();

  const numbers = (count: number): number[] => operands.slice(-count).map(toNumber);

  const show = (textOperands: string[]): void => {
    const strings = textOperands.filter((token) => token[0] === "(" || token[0] === "<");
    const blank = strings.every((token) => BLANK_STRING_RX.test(token));
    if (positioned && !blank) {
      const [, , , , x, y] = multiply(line, ctm);
      // NaN (an overflowed matrix) is not a position, and must not collide with another NaN.
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        const origin = `${roundHalfEven(x, 1)},${roundHalfEven(y, 1)}`;
        origins.set(origin, (origins.get(origin) ?? 0) + 1);
      }
    }
    positioned = false;
  };

  for (const [token] of content.matchAll(TOKEN_RX)) {
    if (!OPERATOR_RX.test(token)) {
      operands.push(token);
      continue;
    }
    if (token === "q") {
      saved.push(ctm);
    } else if (token === "Q") {
      ctm = saved.pop() ?? ctm;
    } else if (token === "cm") {
      ctm = multiply(numbers(6), ctm);
    } else if (token === "BT") {
      line = IDENTITY;
      positioned = true;
    } else if (token === "Tm") {
      line = numbers(6);
      positioned = true;
    } else if (token === "Td" || token === "TD") {
      const offset = numbers(2);
      if (offset.length !== 2) throw new LayoutError(`${token} needs two numbers`);
      const [tx, ty] = offset;
      if (token === "TD") leading = -ty;
      line = multiply([1, 0, 0, 1, tx, ty], line);
      positioned = true;
    } else if (token === "TL") {
      const [value] = numbers(1);
      if (value === undefined) throw new LayoutError("TL needs a number");
      leading = value;
    } else if (token === "T*" || token === "'" || token === '"') {
      line = multiply([1, 0, 0, 1, 0, -leading], line);
      positioned = true;
      if (token !== "T*") show(operands.slice(-1));
    } else if (token === "Tj") {
      show(operands.slice(-1));
    } else if (token === "TJ") {
      show(operands);
    }
    operands = [];
  }
  let overlaps = 0;
  for (const count of origins.values()) overlaps += count - 1;
  return overlaps;
}

function readFile(path: string): Buffer | null {
  try {
    return fs.statSync(path).isFile() ? fs.readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** Return the integrity problems found in the PDF at `path` (empty when sound). */
export function inspectPdf(path: string, minBytes = 10 * 1024, maxPages = 2): string[] {
  const bytes = readFile(expandHome(path));
  if (bytes === null) return [`resume PDF not found: ${path}`];
  if (bytes.length <= minBytes) {
    return [`resume PDF is ${bytes.length} bytes; a real resume exceeds ${minBytes}`];
  }
  const raw = bytes.toString("latin1");
  if (!raw.startsWith("%PDF-") || !raw.slice(-2048).includes("%%EOF")) {
    return ["resume file is not a complete PDF (missing header or end-of-file marker)"];
  }
  if (raw.includes("/Encrypt")) return ["resume PDF is encrypted, so its contents cannot be verified"];

  const issues: string[] = [];
  const streams = decodedStreams(raw);
  const countPages = (data: string): number => data.match(PAGE_RX)?.length ?? 0;
  const pages = countPages(raw) + streams.reduce((total, stream) => total + countPages(stream), 0);
  if (pages < 1 || pages > maxPages) issues.push(`resume PDF has ${pages} pages; expected 1 to ${maxPages}`);

  let overlaps: number | null = 0;
  try {
    for (const stream of streams) {
      if (isContentStream(stream)) overlaps += overlappingTextOrigins(stream);
    }
  } catch {
    overlaps = null;
  }
  if (overlaps === null) {
    issues.push("resume PDF text layout could not be parsed, so overlap cannot be ruled out");
  } else if (overlaps > 0) {
    issues.push(`resume PDF draws text over other text at ${overlaps} position(s)`);
  }
  return issues;
}
