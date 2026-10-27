/**
 * Tier-0 text helpers. Expected values in the *_REFERENCE tables were produced by running
 * the Python implementation (reygent/text.py) on the same inputs, so the port is checked
 * against the tested original rather than against itself.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { HTML5_ENTITIES, LEGACY_ENTITIES } from "@/core/htmlEntities";
import { cleanText, clipEnd, clipStart, companyKey, isNegated, normalizePunctuation, snippet, unescapeHtml, wellFormed } from "@/core/text";

/**
 * What Python makes of generated strings: [input, html.unescape(input), clean_text(input)].
 * Written by tests/fixtures/text/html_unescape.py, which says how the strings are built.
 */
const PYTHON_FIXTURE = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./fixtures/text/html_unescape.json", import.meta.url)), "utf8"),
) as { python: string; cases: Array<[string, string, string]> };

/** Characters outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const ROCKET = "\u{1F680}";
const PARTY = "\u{1F389}";

/** [raw, clean_text(raw)] */
const CLEAN_REFERENCE: ReadonlyArray<[string, string]> = [
  ["<p>Hello <b>world</b></p>", "Hello world"],
  ["&lt;p&gt;We&amp;rsquo;re hiring &amp;amp; growing&lt;/p&gt;", "We're hiring & growing"],
  ["&lt;div&gt;&lt;p&gt;Remote&amp;nbsp;(Worldwide)&lt;/p&gt;&lt;/div&gt;", "Remote (Worldwide)"],
  ["\u201cRemote-first\u201d \u2014 we don\u2019t require relocation", "\"Remote-first\" - we don't require relocation"],
  ["p95 < 100ms and > 5x", "p95 < 100ms and > 5x"],
  ["p95 &lt; 100ms and &gt; 5x", "p95 < 100ms and > 5x"],
  ["&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;", "alert(1)"],
  ["Line one  \t next\r\n\nLine   two", "Line one next \n\nLine two"],
  ["", ""],
  ["We&#39;re &#x201C;remote&#x201D; &#8211; always", "We're \"remote\" - always"],
  ["&nbsp;&nbsp;Senior&nbsp;Engineer&nbsp;", "Senior Engineer"],
  ["caf&eacute; &euro;80k &pound;60k &copy; &trade; &reg;", "caf\u00e9 \u20ac80k \u00a360k \u00a9 \u2122 \u00ae"],
  ["one&hellip; &bull; item &middot; x", "one\u2026 \u2022 item \u00b7 x"],
  ["don&#146;t &#150; ok", "don't - ok"],
  ["AT&T and R&D", "AT&T and R&D"],
  ["&bogus; &#xZZ; &;", "&bogus; &#xZZ; &;"],
  ['<br/>A<br>B<a href="https://x.test/?a=1&amp;b=2">link</a>', "A B link"],
  ["<li>One</li><li>Two</li>", "One Two"],
  ["\u22125 \u2013 10 \u2014 x\u00a0y \u2018a\u2019", "-5 - 10 - x y 'a'"],
  ["&AMP; &LT; &GT; &QUOT;", "& < > \""],
  ["<p unclosed and 1 < 2 > 1", "<p unclosed and 1 < 2 > 1"],
  ["a<b and c>d", "a d"],
  ["<!-- note -->kept", "<!-- note -->kept"],
  ["&#128512; ok", "\u{1f600} ok"],
  ["a&#0;b&#xD800;c&#x110000;d", "a\ufffdb\ufffdc\ufffdd"],
  ["a&#1;b&#x7f;c", "abc"],
  ["&Eacute;cole &Uuml;ber &ntilde; &szlig;", "\u00c9cole \u00dcber \u00f1 \u00df"],
  ["5 &times; 3 &rarr; 15 &deg; &frac12; &sect; &para;", "5 \u00d7 3 \u2192 15 \u00b0 \u00bd \u00a7 \u00b6"],
  ["&lsquo;a&rsquo; &ldquo;b&rdquo; &ndash; &mdash; &apos;", "'a' \"b\" - - '"],
  ["Tom &amp; Jerry &amp;amp; friends &amp;amp;amp; more", "Tom & Jerry & friends &amp; more"],
  ['<P CLASS="x">Upper</P> <img src=x onerror=alert(1)>', "Upper"],
  ["  \t leading and trailing \r ", "leading and trailing"],
  ["&#39;single&#39; &#34;double&#34; &#x27;hex&#x27; &#X27;HEX&#X27;", "'single' \"double\" 'hex' 'HEX'"],
  ["x &#38;#39; y", "x ' y"],
  ["&NBSP; &Amp; &nBsp;", "&NBSP; &Amp; &nBsp;"],
  ["&amp &lt &gt", "& < >"],
  ["&#39 no semicolon", "' no semicolon"],
  ["&#32income &#x41rest", "income Arest"],
  ["see https://x.test/?a=1&copy=2&region=us", "see https://x.test/?a=1\u00a9=2\u00aeion=us"],
];

/** [raw, clean_text(raw)]: listings that hide a scam marker behind a character reference. */
const OBFUSCATED_REFERENCE: ReadonlyArray<[string, string]> = [
  ["Earn &dollar;900 per day", "Earn $900 per day"],
  ["registration&Tab;fee", "registration fee"],
  ["experience&NewLine;required", "experience\nrequired"],
  ["t&period;me/", "t.me/"],
  ["Easy&nbspmoney", "Easy money"],
  // The same tricks after an ATS feed has escaped the listing once more.
  ["Earn &amp;dollar;900 per day", "Earn $900 per day"],
  ["Join t&amp;period;me&amp;sol;fastcash", "Join t.me/fastcash"],
  ["Pay a registration&amp;Tab;fee of &amp;#36;50", "Pay a registration fee of $50"],
];

describe("cleanText", () => {
  test.each(CLEAN_REFERENCE)("matches the Python reference for %j", (raw, expected) => {
    expect(cleanText(raw)).toBe(expected);
  });

  test("strips HTML tags, leaving a space where each one was", () => {
    expect(cleanText("<h2>About</h2><ul><li>Remote</li><li>Contract</li></ul>")).toBe("About Remote Contract");
    expect(cleanText('<a href="https://acme.test/jobs?id=1">Apply</a>')).toBe("Apply");
    expect(cleanText("<script>alert(1)</script>")).toBe("alert(1)");
  });

  test("decodes the double-escaped HTML that ATS feeds send", () => {
    // Greenhouse's `content` field is HTML that has been escaped a second time.
    const feed =
      "&lt;p&gt;We&amp;#39;re a &amp;quot;remote-first&amp;quot; team.&lt;/p&gt;\n" +
      "&lt;ul&gt;&lt;li&gt;Contractors&amp;nbsp;welcome &amp;amp; paid via Deel&lt;/li&gt;&lt;/ul&gt;";
    expect(cleanText(feed)).toBe('We\'re a "remote-first" team. \n Contractors welcome & paid via Deel');
  });

  test("turns curly quotes, dashes and non-breaking spaces into ASCII", () => {
    expect(cleanText("We don\u2019t sponsor \u201cvisas\u201d \u2013 sorry")).toBe("We don't sponsor \"visas\" - sorry");
    expect(cleanText("US\u00a0citizens only")).toBe("US citizens only");
    expect(cleanText("It&rsquo;s &ldquo;remote&rdquo; &mdash; anywhere")).toBe("It's \"remote\" - anywhere");
  });

  test("keeps a bare < or > in prose", () => {
    expect(cleanText("p95 < 100ms and > 5x")).toBe("p95 < 100ms and > 5x");
    expect(cleanText("latency <100ms, throughput >5x")).toBe("latency <100ms, throughput >5x");
    expect(cleanText("if a < b then b > a")).toBe("if a < b then b > a");
    expect(cleanText("<3 years of experience, >= 2 shipped products")).toBe("<3 years of experience, >= 2 shipped products");
  });

  test("keeps line breaks but collapses every other run of whitespace", () => {
    expect(cleanText("Senior   Engineer\n\tRemote \t (Worldwide)")).toBe("Senior Engineer\n Remote (Worldwide)");
  });

  test("treats a missing value as empty text", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
    expect(cleanText("   ")).toBe("");
  });

  test.each(OBFUSCATED_REFERENCE)("sees through the obfuscation in %j, as Python does", (raw, expected) => {
    expect(cleanText(raw)).toBe(expected);
  });

  test("reads references without a closing semicolon the way a browser does", () => {
    // Parity with Python's html.unescape, warts included: a scam filter that reads less
    // than the browser shows can be hidden from, so "&copy=2" in a URL does become "\u00a9=2".
    expect(cleanText("Easy&nbspmoney, &pound50 a day &amp more")).toBe("Easy money, \u00a350 a day & more");
    expect(cleanText("see https://x.test/?a=1&copy=2")).toBe("see https://x.test/?a=1\u00a9=2");
  });

  test("agrees with Python's clean_text on every generated string", () => {
    const wrong = PYTHON_FIXTURE.cases
      .map(([input, , expected]) => ({ input, expected, actual: cleanText(input) }))
      .filter((result) => result.actual !== result.expected);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });
});

describe("unescapeHtml", () => {
  /** [reference, html.unescape(reference)] for a spread of the named references in the table. */
  const NAMED: ReadonlyArray<[string, string]> = [
    ["&quot;", '"'], ["&amp;", "&"], ["&apos;", "'"], ["&lt;", "<"], ["&gt;", ">"], ["&nbsp;", "\u00a0"],
    ["&cent;", "\u00a2"], ["&pound;", "\u00a3"], ["&yen;", "\u00a5"], ["&euro;", "\u20ac"],
    ["&copy;", "\u00a9"], ["&reg;", "\u00ae"], ["&trade;", "\u2122"], ["&deg;", "\u00b0"],
    ["&plusmn;", "\u00b1"], ["&sup2;", "\u00b2"], ["&frac14;", "\u00bc"], ["&frac34;", "\u00be"],
    ["&Agrave;", "\u00c0"], ["&agrave;", "\u00e0"], ["&Ccedil;", "\u00c7"], ["&ccedil;", "\u00e7"],
    ["&Ouml;", "\u00d6"], ["&ouml;", "\u00f6"], ["&ETH;", "\u00d0"], ["&eth;", "\u00f0"],
    ["&oelig;", "\u0153"], ["&Scaron;", "\u0160"], ["&Omega;", "\u03a9"], ["&omega;", "\u03c9"],
    ["&ndash;", "\u2013"], ["&mdash;", "\u2014"], ["&lsquo;", "\u2018"], ["&rsquo;", "\u2019"],
    ["&ldquo;", "\u201c"], ["&rdquo;", "\u201d"], ["&bull;", "\u2022"], ["&hellip;", "\u2026"],
    ["&dagger;", "\u2020"], ["&Dagger;", "\u2021"], ["&prime;", "\u2032"], ["&Prime;", "\u2033"],
    ["&larr;", "\u2190"], ["&rarr;", "\u2192"], ["&rArr;", "\u21d2"], ["&ne;", "\u2260"],
    ["&le;", "\u2264"], ["&ge;", "\u2265"], ["&minus;", "\u2212"], ["&there4;", "\u2234"],
    ["&hearts;", "\u2665"], ["&lang;", "\u27e8"], ["&rang;", "\u27e9"], ["&COPY;", "\u00a9"],
    ["&TRADE;", "\u2122"], ["&REG;", "\u00ae"],
  ];

  test.each(NAMED)("decodes %s as Python's html.unescape does", (reference, expected) => {
    expect(unescapeHtml(reference)).toBe(expected);
  });

  test("decodes decimal and hexadecimal references", () => {
    expect(unescapeHtml("&#65;&#x41;&#X41;&#x1F600;&#233;")).toBe("AAA\u{1F600}\u00e9");
  });

  test("reads Windows-1252 numbers the way browsers do", () => {
    // Text pasted from Word arrives as &#145;\u2013&#151; rather than the real code points.
    expect(unescapeHtml("&#145;&#146;&#147;&#148;&#149;&#150;&#151;&#128;&#153;")).toBe(
      "\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u20ac\u2122",
    );
  });

  test("never produces control characters, lone surrogates or out-of-range code points", () => {
    expect(unescapeHtml("&#0;")).toBe("\ufffd");
    expect(unescapeHtml("&#xD800;&#xDFFF;")).toBe("\ufffd\ufffd");
    expect(unescapeHtml("&#x110000;&#99999999999999999999999;")).toBe("\ufffd\ufffd");
    expect(unescapeHtml("a&#1;b&#8;c&#11;d&#31;e&#127;f&#xFFFE;g&#x1FFFF;h&#xFDD0;i")).toBe("abcdefghi");
    expect(unescapeHtml("&#9;&#10;&#13;")).toBe("\t\n\r");
  });

  test("is a single pass: an escaped ampersand is decoded once", () => {
    expect(unescapeHtml("&amp;lt;")).toBe("&lt;");
    expect(unescapeHtml(unescapeHtml("&amp;lt;"))).toBe("<");
  });

  test("leaves unknown and malformed references as written", () => {
    for (const text of [
      "&bogus;", "&;", "&#;", "&#x;", "&#x", "&#xZZ;", "& amp;", "R&D;", "AT&T", "&Amp;", "&NBSP;", "&", "&&", "&am", "&a",
      "&dollar 900", // not a legacy name, so it needs its semicolon
    ]) {
      expect(unescapeHtml(text)).toBe(text);
    }
  });

  /** [text, html.unescape(text)] */
  const WITHOUT_SEMICOLON: ReadonlyArray<[string, string]> = [
    ["&amp", "&"], ["&AMP", "&"], ["&eacute", "\u00e9"], ["&lt3", "<3"], ["&gt;=", ">="],
    // the longest legacy name the text starts with is decoded, the rest is kept
    ["&nbspmoney", "\u{a0}money"], ["&notit;", "\u00acit;"], ["&notin", "\u00acin"], ["&notin;", "\u2209"],
    ["&Eacutecole", "\u00c9cole"], ["&copy=2", "\u00a9=2"], ["&region=us", "\u00aeion=us"],
    // numbers end where their digits end
    ["&#65", "A"], ["&#0065", "A"], ["&#32income", " income"], ["&#x41rest", "Arest"], ["&#x41east", "\u{41ea}st"],
  ];

  test.each(WITHOUT_SEMICOLON)("reads %j without its semicolon as Python's html.unescape does", (text, expected) => {
    expect(unescapeHtml(text)).toBe(expected);
  });

  /** [reference, html.unescape(reference)]: HTML5 names beyond the HTML 4 set. */
  const HTML5_ONLY: ReadonlyArray<[string, string]> = [
    ["&dollar;", "$"], ["&Tab;", "\t"], ["&NewLine;", "\n"], ["&period;", "."], ["&sol;", "/"],
    ["&lpar;&rpar;", "()"], ["&commat;", "@"], ["&num;", "#"], ["&excl;", "!"], ["&quest;", "?"],
    ["&percnt;", "%"], ["&plus;", "+"], ["&equals;", "="],
    ["&CounterClockwiseContourIntegral;", "\u2233"],
    // a few names stand for two code points
    ["&bne;", "=\u{20e5}"], ["&NotEqualTilde;", "\u{2242}\u{338}"], ["&fjlig;", "fj"], ["&ThickSpace;", "\u{205f}\u{200a}"],
  ];

  test.each(HTML5_ONLY)("decodes the HTML5 name %s as Python's html.unescape does", (reference, expected) => {
    expect(unescapeHtml(reference)).toBe(expected);
  });

  test("returns text with no ampersand untouched", () => {
    const text = "Senior Engineer; remote #1 <b>bold</b>";
    expect(unescapeHtml(text)).toBe(text);
    expect(unescapeHtml("")).toBe("");
  });

  test("agrees with Python's html.unescape on every generated string", () => {
    expect(PYTHON_FIXTURE.cases.length).toBeGreaterThan(900);
    const wrong = PYTHON_FIXTURE.cases
      .map(([input, expected]) => ({ input, expected, actual: unescapeHtml(input) }))
      .filter((result) => result.actual !== result.expected);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });
});

describe("the HTML5 entity table", () => {
  test("is the whole of Python's html.entities.html5", () => {
    expect(HTML5_ENTITIES.size).toBe(2125);
    expect(LEGACY_ENTITIES.size).toBe(106);
    for (const name of LEGACY_ENTITIES) expect(HTML5_ENTITIES.has(name)).toBe(true);
  });

  test("keys are bare, case-sensitive names", () => {
    for (const name of HTML5_ENTITIES.keys()) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    expect(HTML5_ENTITIES.get("Eacute")).toBe("\u00c9");
    expect(HTML5_ENTITIES.get("eacute")).toBe("\u00e9");
    expect(HTML5_ENTITIES.get("amp")).toBe("&");
    expect(HTML5_ENTITIES.has("amp;")).toBe(false);
    expect(LEGACY_ENTITIES.has("amp")).toBe(true);
    expect(LEGACY_ENTITIES.has("dollar")).toBe(false);
  });

  test("every value is one or two characters", () => {
    for (const text of HTML5_ENTITIES.values()) expect([1, 2]).toContain([...text].length);
  });
});

describe("normalizePunctuation", () => {
  test("maps typographic punctuation to ASCII and nothing else", () => {
    expect(normalizePunctuation("\u2018a\u2019 \u201cb\u201d \u2013 \u2014 \u2212 x\u00a0y")).toBe("'a' \"b\" - - - x y");
    expect(normalizePunctuation("caf\u00e9 \u2026 \u2022 plain 'text' - \"ok\"")).toBe("caf\u00e9 \u2026 \u2022 plain 'text' - \"ok\"");
  });

  test("keeps the text the same length, so match offsets stay valid", () => {
    const text = "We can\u2019t \u2014 and won\u2019t \u2014 relocate\u00a0you";
    expect(normalizePunctuation(text)).toHaveLength(text.length);
  });
});

/** [text, phrase, lookback, is_negated(text, start, end, lookback)] */
const NEGATION_REFERENCE: ReadonlyArray<[string, string, number, boolean]> = [
  ["No security clearance required", "security clearance", 30, true],
  ["citizenship is not required", "citizenship", 30, true],
  ["We can\u2019t relocate you", "relocate", 30, true],
  ["We can't relocate you", "relocate", 30, true],
  ["US citizenship required", "US citizenship", 30, false],
  ["No visa needed. US citizenship required", "US citizenship", 30, false],
  ["We do not sponsor; US citizenship required", "US citizenship", 30, false],
  ["Is this not great? Security clearance required", "Security clearance", 30, false],
  ["No agencies! Security clearance required", "Security clearance", 30, false],
  ["No agencies\n- Security clearance required", "Security clearance", 30, false],
  ["No, really, this is quite a long preamble before the security clearance", "security clearance", 30, false],
  ["No, really, this is quite a long preamble before the security clearance", "security clearance", 200, true],
  ["Security clearance is not required", "Security clearance", 30, true],
  ["Security clearance will not be needed", "Security clearance", 30, true],
  ["Security clearance: not a requirement", "Security clearance", 30, true],
  ["Security clearance is definitely, absolutely, positively not required", "Security clearance", 30, false],
  ["Security clearance. Travel is not required", "Security clearance", 30, false],
  ["SECURITY CLEARANCE IS NOT REQUIRED", "SECURITY CLEARANCE", 30, true],
  ["A degree is not expected", "degree", 30, true],
  ["A degree is not mandatory", "degree", 30, true],
  ["A degree is not necessary", "degree", 30, true],
  ["A degree is not preferred", "degree", 30, false],
  ["A degree is required, not optional", "degree", 30, false],
  ["nonprofit security clearance", "security clearance", 30, false],
  ["non-US citizens welcome", "US citizens", 30, true],
  ["Unable to sponsor visas", "sponsor visas", 30, true],
  ["You know security clearance", "security clearance", 30, false],
  ["Notable security clearance", "security clearance", 30, false],
  ["without security clearance", "security clearance", 30, true],
  ["never needs security clearance", "security clearance", 30, true],
  ["neither relocation nor security clearance", "security clearance", 30, true],
  ["zero security clearance", "security clearance", 30, true],
  ["we cannot offer security clearance", "security clearance", 30, true],
  ["we won\u2019t require security clearance", "security clearance", 30, true],
  ["we don\u2019t require security clearance", "security clearance", 30, true],
  ["it doesn\u2019t need security clearance", "security clearance", 30, true],
  ["this isn\u2019t a security clearance", "security clearance", 30, true],
  ["these aren\u2019t security clearance", "security clearance", 30, true],
  ["NOT a security clearance", "security clearance", 30, true],
  ["security clearance", "security clearance", 30, false],
  ["Must relocate. Citizenship is\u00a0not required", "Citizenship", 30, true],
  ["Relocation \u2013 not required", "Relocation", 30, true],
  ["relocation is not\nrequired", "relocation", 30, true],
  ["relocation\nis not required", "relocation", 30, false],
];

function negated(text: string, phrase: string, lookback?: number): boolean {
  const start = text.indexOf(phrase);
  expect(start).toBeGreaterThanOrEqual(0);
  return isNegated(text, start, start + phrase.length, lookback);
}

describe("isNegated", () => {
  test.each(NEGATION_REFERENCE)("%j / %j (lookback %i) -> %s, as in Python", (text, phrase, lookback, expected) => {
    expect(negated(text, phrase, lookback)).toBe(expected);
  });

  test("sees a negation before the phrase", () => {
    expect(negated("No security clearance required", "security clearance")).toBe(true);
    expect(negated("Security clearance required", "Security clearance")).toBe(false);
  });

  test("sees a negation after the phrase", () => {
    expect(negated("citizenship is not required", "citizenship")).toBe(true);
    expect(negated("citizenship is required", "citizenship")).toBe(false);
  });

  test("understands curly apostrophes", () => {
    expect(negated("Sorry, we can\u2019t relocate you", "relocate")).toBe(true);
    expect(negated("We don\u2019t need a security clearance", "security clearance")).toBe(true);
  });

  test.each([".", ";", "!", "?", "\n"])("a clause boundary %j stops the lookback", (boundary) => {
    expect(negated(`We do not sponsor visas${boundary} US citizenship required`, "US citizenship")).toBe(false);
    expect(negated(`US citizenship${boundary} A degree is not required`, "US citizenship")).toBe(false);
  });

  test("a negation on the previous line never reaches a phrase that starts the next line", () => {
    // The Python original gets this wrong: its `$` also matches just before a trailing
    // newline, so `is_negated` returns True for both of these and the requirement is missed.
    expect(negated("We do not sponsor visas\nUS citizens only", "US citizens only")).toBe(false);
    expect(negated("No agencies\nSecurity clearance required", "Security clearance")).toBe(false);
  });

  test("looks back 30 characters by default and no further", () => {
    const far = `Not${" ".repeat(27)}clearance`; // "Not" starts 30 characters before the phrase
    const tooFar = `Not${" ".repeat(28)}clearance`;
    expect(negated(far, "clearance")).toBe(true);
    expect(negated(tooFar, "clearance")).toBe(false);
    expect(negated(tooFar, "clearance", 31)).toBe(true);
  });

  test("works at the very start and end of the text", () => {
    expect(isNegated("clearance", 0, 9)).toBe(false);
    expect(isNegated("no clearance", 3, 12)).toBe(true);
    expect(isNegated("clearance not required", 0, 9)).toBe(true);
  });

  // An emoji is one character to Python and two UTF-16 units to JavaScript. The windows
  // (30 back, 45 forward, 25 before "not") are counted in characters, as Python counts them.
  /** [text, phrase, lookback, is_negated(text, start, end, lookback)] */
  const EMOJI_REFERENCE: ReadonlyArray<[string, string, number, boolean]> = [
    [`not ${ROCKET.repeat(10)} really, US citizenship`, "US citizenship", 30, true],
    [`Not${ROCKET.repeat(27)}clearance`, "clearance", 30, true],
    [`Not${ROCKET.repeat(28)}clearance`, "clearance", 30, false],
    [`Not${ROCKET.repeat(28)}clearance`, "clearance", 31, true],
    [`citizenship ${ROCKET.repeat(20)} not required`, "citizenship", 30, true],
    [`citizenship ${ROCKET.repeat(12)} is not a requirement`, "citizenship", 30, true],
    [`citizenship${ROCKET.repeat(25)}not required`, "citizenship", 30, true],
    [`citizenship${ROCKET.repeat(26)}not required`, "citizenship", 30, false],
    [`citizenship${ROCKET.repeat(24)} not be mandatory`, "citizenship", 30, true],
    [`citizenship ${ROCKET.repeat(10)}.${ROCKET.repeat(3)} not required`, "citizenship", 30, false],
    [`no ${ROCKET} visa ${ROCKET} sponsorship`, "sponsorship", 30, true],
    [`${ROCKET.repeat(40)}we don\u2019t ${ROCKET.repeat(15)} sponsor visas`, "sponsor visas", 30, true],
    [`${ROCKET.repeat(40)}we don\u2019t ${ROCKET.repeat(20)} sponsor visas`, "sponsor visas", 30, true],
  ];

  test.each(EMOJI_REFERENCE)("counts an emoji as one character: %j / %j (lookback %i) -> %s", (text, phrase, lookback, expected) => {
    expect(negated(text, phrase, lookback)).toBe(expected);
  });

  // A negation word is a whole word in any script: Python's \b treats accented letters,
  // CJK and non-ASCII digits as word characters, where JavaScript's \b sees a boundary.
  /** [text, phrase, is_negated(text, start, end)] */
  const UNICODE_WORD_REFERENCE: ReadonlyArray<[string, string, boolean]> = [
    ["No\u00ebl bonus and US citizenship", "US citizenship", false],
    ["Not\u00edcias: US citizenship", "US citizenship", false],
    ["a\u00f1o no US citizenship", "US citizenship", true],
    ["se\u00f1or US citizenship", "US citizenship", false],
    ["citizenship is \u00fcnot required", "citizenship", false],
    ["citizenship is not required\u00e9", "citizenship", false],
    ["\u4e2d\u6587no security clearance", "security clearance", false],
    ["caf\u00e9 no security clearance", "security clearance", true],
    ["\u00b2no security clearance", "security clearance", false],
    ["no\u0301 security clearance", "security clearance", true],
    ["\u00e9zero security clearance", "security clearance", false],
    ["unable\u00e9 to get security clearance", "security clearance", false],
    ["non\u00e9 security clearance", "security clearance", false],
    ["\u00c9. Non security clearance", "security clearance", true],
    ["citizenship: \u00e9t\u00e9 not needed", "citizenship", true],
  ];

  test.each(UNICODE_WORD_REFERENCE)("a negation is a whole word in any script: %j / %j -> %s, as in Python", (text, phrase, expected) => {
    expect(negated(text, phrase)).toBe(expected);
  });
});

const LONG =
  "We are a distributed team of engineers building developer tools for the modern web and " +
  "candidates must hold an active security clearance before the start date because several of " +
  "our customers are government agencies with strict requirements.";
const MULTI = "First line of the listing\nApplicants need US citizenship for this role\nThird line here";
const WORDS = "alpha beta gamma delta MATCH epsilon zeta eta theta";

/** [text, phrase, pad, snippet(text, start, end, pad)] */
const SNIPPET_REFERENCE: ReadonlyArray<[string, string, number, string]> = [
  [LONG, "security clearance", 40, "web and candidates must hold an active security clearance before the start date because several"],
  [LONG, "security clearance", 5, "security clearance"],
  [LONG, "security clearance", 0, "security clearance"],
  [LONG, "We are", 40, "We are a distributed team of engineers"],
  [LONG, "strict requirements.", 40, "customers are government agencies with strict requirements."],
  [MULTI, "US citizenship", 40, "Applicants need US citizenship for this role"],
  [MULTI, "US citizenship", 3, "US citizenship"],
  [MULTI, "First", 40, "First line of the listing"],
  [MULTI, "here", 40, "Third line here"],
  ["short text", "short", 40, "short text"],
  [`${"a".repeat(50)}MATCH${"b".repeat(54)}`, "MATCH", 10, "aaaaaaaaaaMATCHbbbbbbbbbb"],
  ["one  two\tthree   MATCH   four \t five  six", "MATCH", 12, "MATCH four"],
  [WORDS, "MATCH", 8, "delta MATCH"],
  [WORDS, "MATCH", 6, "MATCH"],
  [WORDS, "MATCH", 1, "MATCH"],
  ["\nMATCH on the second line", "MATCH", 40, "MATCH on the second line"],
  ["ends with newline MATCH\n", "MATCH", 40, "ends with newline MATCH"],
  ["a b c d e f g h i j k l m n o p MATCH q r s t u v w x y z", "MATCH", 4, "p MATCH q"],
];

function snip(text: string, phrase: string, pad?: number): string {
  const start = text.indexOf(phrase);
  expect(start).toBeGreaterThanOrEqual(0);
  return snippet(text, start, start + phrase.length, pad);
}

describe("snippet", () => {
  test.each(SNIPPET_REFERENCE)("%j around %j (pad %i), as in Python", (text, phrase, pad, expected) => {
    expect(snip(text, phrase, pad)).toBe(expected);
  });

  test("never cuts a word in half", () => {
    const words = new Set(LONG.split(" "));
    for (const pad of [0, 1, 7, 13, 25, 40, 80, 500]) {
      const result = snip(LONG, "security clearance", pad);
      expect(result).toContain("security clearance");
      for (const word of result.split(" ")) expect(words).toContain(word);
    }
  });

  test("stays on the line the match is on", () => {
    expect(snip(MULTI, "US citizenship", 500)).toBe("Applicants need US citizenship for this role");
    expect(snip("No visas\nUS citizenship required\nRemote", "US citizenship")).toBe("US citizenship required");
  });

  test("pads by 40 characters each side by default", () => {
    expect(snip(LONG, "security clearance")).toBe(snip(LONG, "security clearance", 40));
  });

  test("collapses runs of whitespace", () => {
    expect(snip("needs   an  active \t security clearance   today", "security clearance")).toBe(
      "needs an active security clearance today",
    );
  });

  const EMOJI_LINE =
    `We ${ROCKET} are ${ROCKET} hiring ${ROCKET} engineers ${ROCKET} who ${ROCKET} hold ${ROCKET} a ${ROCKET}` +
    ` security clearance ${ROCKET} and ${ROCKET} love ${ROCKET} remote ${ROCKET} work ${ROCKET} across` +
    ` ${ROCKET} time ${ROCKET} zones`;
  const PACKED = `${ROCKET.repeat(50)}MATCH${PARTY.repeat(50)}`;
  const FRAMED = `${ROCKET.repeat(30)} alpha beta MATCH gamma delta ${PARTY.repeat(30)}`;
  const LINES = `${ROCKET.repeat(3)} a\n${ROCKET.repeat(5)} b MATCH c ${PARTY.repeat(5)}\nd ${PARTY.repeat(3)}`;
  const TIGHT = `x ${ROCKET}MATCH${PARTY} y`;

  /** [text, phrase, pad, snippet(text, start, end, pad)] \u2014 the padding is counted in characters, as in Python. */
  const EMOJI_REFERENCE: ReadonlyArray<[string, string, number, string]> = [
    [EMOJI_LINE, "security clearance", 40, `hiring ${ROCKET} engineers ${ROCKET} who ${ROCKET} hold ${ROCKET} a ${ROCKET} security clearance ${ROCKET} and ${ROCKET} love ${ROCKET} remote ${ROCKET} work ${ROCKET} across`],
    [EMOJI_LINE, "security clearance", 20, `${ROCKET} who ${ROCKET} hold ${ROCKET} a ${ROCKET} security clearance ${ROCKET} and ${ROCKET} love ${ROCKET}`],
    [EMOJI_LINE, "security clearance", 12, `hold ${ROCKET} a ${ROCKET} security clearance ${ROCKET} and ${ROCKET}`],
    [EMOJI_LINE, "security clearance", 5, `a ${ROCKET} security clearance ${ROCKET}`],
    [EMOJI_LINE, "security clearance", 2, "security clearance"],
    [EMOJI_LINE, "security clearance", 1, "security clearance"],
    [PACKED, "MATCH", 7, `${ROCKET.repeat(7)}MATCH${PARTY.repeat(7)}`],
    [PACKED, "MATCH", 1, `${ROCKET}MATCH${PARTY}`],
    [PACKED, "MATCH", 0, "MATCH"],
    [FRAMED, "MATCH", 10, "beta MATCH gamma"],
    [FRAMED, "MATCH", 14, "alpha beta MATCH gamma delta"],
    [FRAMED, "MATCH", 40, "alpha beta MATCH gamma delta"],
    [LINES, "MATCH", 40, `${ROCKET.repeat(5)} b MATCH c ${PARTY.repeat(5)}`],
    [LINES, "MATCH", 6, "b MATCH c"],
    [TIGHT, "MATCH", 1, `${ROCKET}MATCH${PARTY}`],
    [TIGHT, "MATCH", 2, `${ROCKET}MATCH${PARTY}`],
    [TIGHT, "MATCH", 3, `x ${ROCKET}MATCH${PARTY} y`],
  ];

  test.each(EMOJI_REFERENCE)("counts an emoji as one character: %j around %j (pad %i), as in Python", (text, phrase, pad, expected) => {
    expect(snip(text, phrase, pad)).toBe(expected);
  });

  test("never cuts an emoji in half", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const text of [EMOJI_LINE, PACKED, FRAMED, LINES, TIGHT]) {
      const phrase = text.includes("MATCH") ? "MATCH" : "security clearance";
      for (let pad = 0; pad <= 60; pad += 1) expect(snip(text, phrase, pad)).not.toMatch(lone);
    }
  });
});

/** [name, company_key(name)] */
const COMPANY_REFERENCE: ReadonlyArray<[string, string]> = [
  ["Acme, Inc.", "acme"],
  ["ACME", "acme"],
  ["The Acme Company", "acme"],
  ["Acme GmbH", "acme"],
  ["Acme Co.", "acme"],
  ["ACME LLC", "acme"],
  ["Acme Corp", "acme"],
  ["Acme Ltd.", "acme"],
  ["Northwind Labs", "northwind labs"],
  ["Caf\u00e9 Inc", "caf"],
  ["", ""],
  ["Co", ""],
  ["A.I. Inc", "a i"],
  ["  acme  ", "acme"],
  ["Acme-Corp, The", "acme"],
  ["Incorporated Things", "incorporated things"],
  ["Company of Heroes Ltd", "of heroes"],
  ["O'Reilly & Co.", "o reilly"],
  ["37signals", "37signals"],
  ["ACME\tINC\n", "acme"],
];

describe("companyKey", () => {
  test.each(COMPANY_REFERENCE)("%j -> %j, as in Python", (name, expected) => {
    expect(companyKey(name)).toBe(expected);
  });

  test("the same employer written differently has one key", () => {
    expect(companyKey("Acme, Inc.")).toBe(companyKey("ACME"));
    expect(companyKey("Northwind Labs LLC")).toBe(companyKey("northwind-labs"));
  });

  test("different employers keep different keys", () => {
    expect(companyKey("Acme Labs")).not.toBe(companyKey("Acme"));
    expect(companyKey("Northwind")).not.toBe(companyKey("Southwind"));
  });

  test("a legal form or a job board's decoration at the end of a name is not part of it", () => {
    // Job boards and company boards name the same employer differently.
    expect(companyKey("Proxify AB")).toBe(companyKey("Proxify"));
    expect(companyKey("Automattic Careers")).toBe(companyKey("Automattic"));
    expect(companyKey("Tether Operations Limited")).toBe("tether operations");
    expect(companyKey("Acme Jobs")).toBe("acme");
    expect(companyKey("Nordwind GmbH AG")).toBe("nordwind");
    // Only at the end, and never the whole name.
    expect(companyKey("AB InBev")).toBe("ab inbev");
    expect(companyKey("SA Power Networks")).toBe("sa power networks");
    expect(companyKey("Jobs")).toBe("jobs");
    expect(companyKey("Careers AB")).toBe("careers");
  });
});

describe("cutting text without splitting an emoji", () => {
  const text = "Monzo! \u{1F642} hiring";
  test("a cut that would fall inside an emoji leaves the whole emoji out", () => {
    expect(clipStart(text, 8)).toBe("Monzo! ");
    expect(clipStart(text, 9)).toBe("Monzo! \u{1F642}");
    expect(clipEnd(text, 8)).toBe(" hiring");
    expect(clipEnd(text, 9)).toBe("\u{1F642} hiring");
    expect(clipStart(text, 0)).toBe("");
    expect(clipEnd(text, 0)).toBe("");
  });
  test("half an emoji left anywhere becomes U+FFFD; whole ones are kept", () => {
    expect(wellFormed("a\uD83D")).toBe("a\uFFFD");
    expect(wellFormed("\uDE42b")).toBe("\uFFFDb");
    expect(wellFormed(text)).toBe(text);
  });
});
