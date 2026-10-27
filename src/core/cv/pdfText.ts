/**
 * The text of a PDF as a résumé parser reads it (no dependencies).
 *
 * An applicant tracking system never looks at the page: it takes the text layer in the
 * order the file draws it. This reads that same layer back, so a CV can be checked for
 * what a parser will actually find in it — a keyword that is on the page but not in the
 * text layer, or that arrives split in two, is not found by anyone searching for it.
 *
 * Written for what Chrome prints (how Reygent makes every PDF, and how most CV builders
 * do): subset fonts with a ToUnicode map and explicitly positioned runs. Other PDFs are
 * read as far as they follow the same conventions; null means the text could not be read
 * at all, never that the file has none.
 */

import fs from "node:fs";
import zlib from "node:zlib";

import { expandHome } from "@/core/config";
import { IDENTITY, type Matrix, OPERATOR_RX, TOKEN_RX, multiply, toNumber } from "@/core/cop/pdfIntegrity";

// The file is decoded as latin1, one char per byte, and whitespace is spelled out: see pdfIntegrity.
const WS = String.raw`[ \t\n\r\f\v]`;
const OBJECT_RX = new RegExp(String.raw`(\d+)${WS}+\d+${WS}+obj\b(.*?)\bendobj\b`, "gs");
const STREAM_START_RX = /\bstream\r?\n/;
const PAGE_RX = new RegExp(String.raw`/Type${WS}*/Page(?![A-Za-z])`);
const PAGES_RX = new RegExp(String.raw`/Type${WS}*/Pages(?![A-Za-z])`);
const REFERENCE_RX = new RegExp(String.raw`(\d+)${WS}+\d+${WS}+R`, "g");
const HEX_PAIR_RX = /<([0-9A-Fa-f \t\n\r\f\v]*)>[ \t\n\r\f\v]*<([0-9A-Fa-f \t\n\r\f\v]*)>/g;
const HEX_RANGE_RX =
  /<([0-9A-Fa-f]+)>[ \t\n\r\f\v]*<([0-9A-Fa-f]+)>[ \t\n\r\f\v]*(?:<([0-9A-Fa-f \t\n\r\f\v]*)>|\[(.*?)\])/gs;

/** A run that starts further right than this many ems per glyph of the last one is a new block, not the next letter. */
const BLOCK_GAP_EMS = 0.5;
/** Kerning inside a TJ array beyond this (thousandths of an em) stands for a space. */
const KERNED_SPACE = 200;
/** Text that moved by more than this share of an em vertically is on another line. */
const LINE_SHIFT_EMS = 0.3;
const MAX_TREE_DEPTH = 16;

interface PdfObject {
  /** Everything before the stream: the object's dictionary (or its whole body). */
  dict: string;
  /** The stream, inflated; null when the object has none or it could not be inflated. */
  stream: string | null;
}

interface Font {
  /** Bytes per character code: 2 for the composite fonts Chrome writes. */
  bytes: number;
  /** Character code -> text, from the font's ToUnicode map; null when it has none. */
  unicode: Map<number, string> | null;
}

const LATIN1: Font = { bytes: 1, unicode: null };

function inflate(data: string): string | null {
  try {
    // Lenient about a truncated tail and the bytes after the stream's end: see pdfIntegrity.
    return zlib.inflateSync(Buffer.from(data, "latin1"), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("latin1");
  } catch {
    return null;
  }
}

function readObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  for (const [, id, body] of raw.matchAll(OBJECT_RX)) {
    const start = STREAM_START_RX.exec(body);
    if (!start) {
      objects.set(Number(id), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, start.index);
    const end = body.lastIndexOf("endstream");
    const data = body.slice(start.index + start[0].length, end > start.index ? end : undefined);
    objects.set(Number(id), { dict, stream: /\/FlateDecode\b/.test(dict) ? inflate(data) : data });
  }
  return objects;
}

/** The object number a dictionary entry points at ("/Pages 10 0 R" -> 10), if it is a reference. */
function reference(dict: string, key: string): number | null {
  const match = new RegExp(String.raw`/${key}(?![A-Za-z])${WS}*(\d+)${WS}+\d+${WS}+R`).exec(dict);
  return match ? Number(match[1]) : null;
}

const references = (text: string): number[] => Array.from(text.matchAll(REFERENCE_RX), (match) => Number(match[1]));

/** Page objects in reading order: the page tree walked from its root, else every page in file order. */
function pagesInOrder(objects: Map<number, PdfObject>): PdfObject[] {
  const pages: PdfObject[] = [];
  const seen = new Set<number>();
  const walk = (id: number, depth: number): void => {
    const node = objects.get(id);
    if (!node || seen.has(id) || depth > MAX_TREE_DEPTH) return;
    seen.add(id);
    if (!PAGES_RX.test(node.dict)) {
      if (PAGE_RX.test(node.dict)) pages.push(node);
      return;
    }
    const kids = new RegExp(String.raw`/Kids${WS}*\[(.*?)\]`, "s").exec(node.dict)?.[1] ?? "";
    for (const kid of references(kids)) walk(kid, depth + 1);
  };
  for (const [id, node] of objects) {
    if (PAGES_RX.test(node.dict) && reference(node.dict, "Parent") === null) walk(id, 0);
  }
  if (pages.length) return pages;
  return [...objects.values()].filter((node) => PAGE_RX.test(node.dict) && !PAGES_RX.test(node.dict));
}

/** The text a run of UTF-16BE hex digits spells ("00480069" -> "Hi"). */
function utf16(hex: string): string {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, "");
  let text = "";
  for (let at = 0; at + 4 <= digits.length; at += 4) text += String.fromCharCode(parseInt(digits.slice(at, at + 4), 16));
  return text;
}

function readToUnicode(cmap: string): Font {
  const unicode = new Map<number, string>();
  const space = /begincodespacerange[ \t\n\r\f\v]*<([0-9A-Fa-f]+)>/.exec(cmap)?.[1];
  for (const [, block] of cmap.matchAll(/beginbfchar(.*?)endbfchar/gs)) {
    for (const [, code, text] of block.matchAll(HEX_PAIR_RX)) unicode.set(parseInt(code.replace(/\s/g, ""), 16), utf16(text));
  }
  for (const [, block] of cmap.matchAll(/beginbfrange(.*?)endbfrange/gs)) {
    for (const [, low, high, first, each] of block.matchAll(HEX_RANGE_RX)) {
      const from = parseInt(low, 16);
      const to = Math.min(parseInt(high, 16), from + 0xffff);
      if (each !== undefined) {
        Array.from(each.matchAll(/<([0-9A-Fa-f \t\n\r\f\v]*)>/g), ([, text]) => utf16(text))
          .slice(0, to - from + 1)
          .forEach((text, offset) => unicode.set(from + offset, text));
        continue;
      }
      // A range counts up from its first target: only the last UTF-16 unit changes.
      const start = utf16(first ?? "");
      if (!start) continue;
      const last = start.charCodeAt(start.length - 1);
      for (let code = from; code <= to; code += 1) {
        unicode.set(code, start.slice(0, -1) + String.fromCharCode(last + code - from));
      }
    }
  }
  return { bytes: space ? Math.max(1, space.length / 2) : 2, unicode };
}

/** The fonts a page may select, by resource name ("F4"), looking up the page tree for inherited resources. */
function pageFonts(page: PdfObject, objects: Map<number, PdfObject>): Map<string, Font> {
  const fonts = new Map<string, Font>();
  let node: PdfObject | undefined = page;
  let listed = "";
  for (let depth = 0; node && !listed && depth < MAX_TREE_DEPTH; depth += 1) {
    const resources = reference(node.dict, "Resources");
    const holder = resources === null ? node.dict : (objects.get(resources)?.dict ?? "");
    const shared = reference(holder, "Font");
    listed =
      shared === null
        ? (new RegExp(String.raw`/Font(?![A-Za-z])${WS}*<<(.*?)>>`, "s").exec(holder)?.[1] ?? "")
        : (objects.get(shared)?.dict ?? "");
    const parent = reference(node.dict, "Parent");
    node = parent === null ? undefined : objects.get(parent);
  }
  const entry = new RegExp(String.raw`/([^ \t\n\r\f\v/\[\]()<>]+)${WS}+(\d+)${WS}+\d+${WS}+R`, "g");
  for (const [, name, id] of listed.matchAll(entry)) {
    const font = objects.get(Number(id));
    if (!font) continue;
    const map = reference(font.dict, "ToUnicode");
    const cmap = map === null ? null : (objects.get(map)?.stream ?? null);
    if (cmap !== null) fonts.set(name, readToUnicode(cmap));
    // With no map, a composite font's codes are glyph numbers that say nothing about the text.
    else fonts.set(name, /\/Type0\b|\/Identity-[HV]\b/.test(font.dict) ? { bytes: 2, unicode: new Map() } : LATIN1);
  }
  return fonts;
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/** The bytes of a string token, as one latin1 char each: "(a\051)" or "<0041>". */
function stringBytes(token: string): string {
  if (token[0] === "<") {
    const digits = token.replace(/[^0-9A-Fa-f]/g, "");
    let bytes = "";
    // An odd final digit is padded with zero, as the format says.
    for (let at = 0; at < digits.length; at += 2) bytes += String.fromCharCode(parseInt(digits.slice(at, at + 2).padEnd(2, "0"), 16));
    return bytes;
  }
  return token
    .slice(1, -1)
    .replace(/\\([0-7]{1,3}|\r\n|[\s\S])/g, (_, escaped: string) =>
      /^[0-7]/.test(escaped)
        ? String.fromCharCode(parseInt(escaped, 8) & 0xff)
        : /^[\r\n]/.test(escaped) ? "" : (ESCAPES[escaped] ?? escaped),
    );
}

/** A string token as text and as a count of glyphs. A code the font cannot map reads as U+FFFD. */
function decode(token: string, font: Font): { text: string; glyphs: number } {
  const bytes = stringBytes(token);
  if (!font.unicode) return { text: bytes, glyphs: bytes.length };
  let text = "";
  let glyphs = 0;
  for (let at = 0; at + font.bytes <= bytes.length; at += font.bytes) {
    let code = 0;
    for (let offset = 0; offset < font.bytes; offset += 1) code = code * 256 + bytes.charCodeAt(at + offset);
    text += font.unicode.get(code) ?? "�";
    glyphs += 1;
  }
  return { text, glyphs };
}

/** The text one content stream draws, in drawing order, with line breaks where the text moves to another line. */
function contentText(content: string, fonts: Map<string, Font>): string {
  let ctm = IDENTITY;
  const saved: Matrix[] = [];
  let line = IDENTITY;
  let leading = 0;
  let font = LATIN1;
  let size = 1;
  let operands: string[] = [];
  let out = "";
  /** Where the last run started, how many glyphs it drew and how big they were, in page units. */
  let last: { x: number; y: number; glyphs: number; em: number } | null = null;

  const numbers = (count: number): number[] => operands.slice(-count).map(toNumber);

  const show = (tokens: string[]): void => {
    let text = "";
    let glyphs = 0;
    for (const token of tokens) {
      if (token[0] === "(" || token[0] === "<") {
        const run = decode(token, font);
        text += run.text;
        glyphs += run.glyphs;
      } else if (/^[-+.\d]/.test(token) && -Number(token) > KERNED_SPACE && text && !text.endsWith(" ")) {
        text += " ";
      }
    }
    if (!text) return;
    const [a, b, , , x, y] = multiply(line, ctm);
    const em = Math.abs(size) * Math.hypot(a, b) || 1;
    if (last) {
      if (Math.abs(y - last.y) > LINE_SHIFT_EMS * Math.max(em, last.em)) out += "\n";
      else if (x - last.x > (last.glyphs + BLOCK_GAP_EMS) * last.em && !/\s$/.test(out) && !/^\s/.test(text)) out += " ";
    }
    out += text;
    last = { x, y, glyphs, em };
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
    } else if (token === "Tf") {
      font = fonts.get((operands.at(-2) ?? "").slice(1)) ?? LATIN1;
      size = toNumber(operands.at(-1) ?? "");
    } else if (token === "Tm") {
      line = numbers(6);
    } else if (token === "Td" || token === "TD") {
      const [tx, ty] = numbers(2);
      if (token === "TD") leading = -ty;
      line = multiply([1, 0, 0, 1, tx, ty], line);
    } else if (token === "TL") {
      [leading] = numbers(1);
    } else if (token === "T*" || token === "'" || token === '"') {
      line = multiply([1, 0, 0, 1, 0, -leading], line);
      if (token !== "T*") show(operands.slice(-1));
    } else if (token === "Tj") {
      show(operands.slice(-1));
    } else if (token === "TJ") {
      show(operands);
    }
    operands = [];
  }
  return out;
}

/** Each line trimmed and single-spaced, with blank lines dropped. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((row) => row.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** The file as latin1 text, or null when it is missing, is not a PDF or is encrypted. */
function readPdf(path: string): string | null {
  try {
    const raw = fs.readFileSync(expandHome(path)).toString("latin1");
    return raw.startsWith("%PDF-") && !raw.includes("/Encrypt") ? raw : null;
  } catch {
    return null;
  }
}

/** How many pages the PDF at `path` has; 0 when it cannot be read. */
export function pdfPageCount(path: string): number {
  const raw = readPdf(path);
  return raw === null ? 0 : pagesInOrder(readObjects(raw)).length;
}

/**
 * The text layer of the PDF at `path`, one line of the page per line, pages in order.
 * Null when the file is missing, is not a PDF, is encrypted, or its text cannot be read.
 */
export function extractPdfText(path: string): string | null {
  const raw = readPdf(path);
  if (raw === null) return null;
  const objects = readObjects(raw);
  const pages = pagesInOrder(objects);
  if (!pages.length) return null;
  try {
    const text: string[] = [];
    for (const page of pages) {
      const fonts = pageFonts(page, objects);
      const listed = new RegExp(String.raw`/Contents${WS}*\[(.*?)\]`, "s").exec(page.dict)?.[1];
      const single = reference(page.dict, "Contents");
      const contents = listed !== undefined ? references(listed) : single === null ? [] : [single];
      // Several streams are one program: an operator may sit in one and its operands in the last.
      const program = contents.map((id) => objects.get(id)?.stream ?? "").join("\n");
      text.push(tidy(contentText(program, fonts)));
    }
    return text.filter(Boolean).join("\n");
  } catch {
    // A content stream that does not follow the operator grammar: nothing read from it can be trusted.
    return null;
  }
}
