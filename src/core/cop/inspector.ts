/**
 * The Cop Tool: 9-point invariant gatekeeper with auto-fix and quarantine.
 *
 * Nothing reaches a browser or an inbox without passing all nine checks:
 *
 *   1. Fact grounding        every metric, technology and employer traces to the verified bank
 *   2. Screening sanity      zero guessing — a work-status / tax / multiple-choice answer is sent
 *                            only when it is the user's own remembered answer, a verbatim profile
 *                            fact, or independently verified against the user's data
 *   3. Link verification     links are the candidate's own and resolve to live pages
 *   4. Asset integrity       no template tokens, no placeholders, a sound 1–2 page resume PDF
 *   5. Commitment guard      no promise of on-site presence or unverified availability
 *   6. Rate floor            no rate below the configured floor, in fields or in prose
 *   7. Scam filter           no pay-to-work schemes, chat-app recruiters or unverified domains
 *   8. De-duplication        one contact per company / domain / person per 30 days
 *   9. Tone                  no sycophantic filler or AI clichés
 *
 * Flaws that a rewrite can repair get up to two auto-fix attempts. Anything else — and
 * anything still failing after those attempts — is quarantined for the user.
 */

import { type CompensationConfig, type CopConfig, defaultConfig } from "@/core/config";
import { HttpLinkChecker, type LinkChecker, normalizeUrl, splitUrl } from "@/core/cop/links";
import { inspectPdf, roundHalfEven } from "@/core/cop/pdfIntegrity";
import { type Repository, toIso } from "@/core/db/repository";
import { CircuitBreakerError } from "@/core/llm/ledger";
import {
  type Achievement,
  type ApplicationDraft,
  type CandidateProfile,
  type DraftTextField,
  type JobOpportunity,
  COMPANY_BOARD_SOURCES,
  PLACEHOLDER,
  type ScreeningAnswer,
  achievementFactText,
  screeningFacts,
  verifiedAchievements,
  verifiedLinks,
  verifiedTechnologies,
} from "@/core/models";
import { modestOption, totalYearsOption } from "@/core/qualification/claims";
import { saysYes, workStatusAnswer } from "@/core/qualification/workStatus";
import { cleanText, companyKey, isNegated, normalizePunctuation } from "@/core/text";

/** (text, critiques) -> revised text */
export type Rewriter = (text: string, critiques: string[]) => Promise<string> | string;

/** The answer the user gave to exactly this screening question before, or null. */
export type StandingAnswer = (question: string) => string | null;

export interface AnswerVerdict {
  /** The answer is true according to the candidate's data. */
  supported: boolean;
  /** 0–1. */
  confidence: number;
}

/** An independent check of a screening answer against the candidate's data. */
export type AnswerVerifier = (question: string, answer: string, options: string[]) => Promise<AnswerVerdict>;

export const CopRule = {
  FACT_GROUNDING: "1_fact_grounding",
  SCREENING_SANITY: "2_screening_sanity",
  LINK_VERIFICATION: "3_link_verification",
  ASSET_INTEGRITY: "4_asset_integrity",
  COMMITMENT_GUARD: "5_commitment_guard",
  RATE_FLOOR: "6_rate_floor",
  SCAM_FILTER: "7_scam_filter",
  DEDUPLICATION: "8_deduplication",
  TONE: "9_tone",
} as const;
export type CopRule = (typeof CopRule)[keyof typeof CopRule];

export const Verdict = {
  GREENLIT: "greenlit",
  QUARANTINED: "quarantined",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface Violation {
  rule: CopRule;
  /** "pitch", "cvBullets[0]", "screeningAnswers[2]", "job", "resumePdf", ... */
  field: string;
  message: string;
  /** True: rewriting the text in `field` can repair it. */
  fixable: boolean;
}

export interface InspectionResult {
  verdict: Verdict;
  /** The final draft, including any auto-fix rewrites. */
  draft: ApplicationDraft;
  violations: Violation[];
  retries: number;
  quarantineIds: number[];
  passed: boolean;
}

const violation = (rule: CopRule, field: string, message: string, fixable = false): Violation => ({
  rule, field, message, fixable,
});

// ---------- Python-compatible text semantics ----------
//
// The rules were written and tested in Python, where \w, \d, \s and \b are Unicode-aware.
// JavaScript's are ASCII-only, and for a gatekeeper that is not a cosmetic difference:
// "at Crédit Suisse" would be read as the organisation "Cr" and accepted against a verified
// "Crédit Agricole", and a metric written in full-width digits would not be a number at all.
// So every pattern taken from the reference is spelled exactly as it is there and compiled
// by `rx`, which gives those four escapes their Unicode meaning.

const WORD = String.raw`\p{L}\p{N}_`;
const DIGIT = String.raw`\p{Nd}`;
/** The characters Python's str.isspace() accepts: JS's \s plus U+001C–1F and U+0085, minus U+FEFF. */
const SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;

/** Compile `source` with Unicode-aware \w, \d, \s and \b. Always sets the `u` flag. */
function rx(source: string, flags = ""): RegExp {
  let inClass = false;
  const translated = source.replace(/\\.|\[\^?|\]/gs, (token) => {
    if (token === "]") {
      inClass = false;
    } else if (token[0] === "[") {
      inClass = true;
    } else if (token === "\\w") {
      return inClass ? WORD : `[${WORD}]`;
    } else if (token === "\\d") {
      return DIGIT;
    } else if (token === "\\s") {
      return inClass ? SPACE : `[${SPACE}]`;
    } else if (token === "\\b" && !inClass) {
      return BOUNDARY;
    } else if (/^\\[bBDSWAZ]$/.test(token)) {
      throw new SyntaxError(`${token} has no Unicode-aware translation here: ${source}`);
    }
    return token;
  });
  return new RegExp(translated, `${flags}u`);
}

const SPACES_RX = rx(String.raw`\s+`, "g");
const EDGE_SPACES_RX = rx(String.raw`^\s+|\s+$`, "g");
const NON_ASCII_DIGIT_RX = /[^\P{Nd}0-9]/gu;
const IS_DIGIT_RX = /^\p{Nd}$/u;

/** Python's str.strip(). */
const strip = (text: string): string => text.replace(EDGE_SPACES_RX, "");
/** Python's str.split(): the whitespace-separated words. */
const words = (text: string): string[] => text.split(SPACES_RX).filter(Boolean);
/** Python's " ".join(text.split()): trimmed, with every run of whitespace collapsed to one space. */
const squash = (text: string): string => words(text).join(" ");
/** Equal but for case and spacing: how an answer is compared with an option, a fact or a remembered answer. */
const same = (a: string, b: string): boolean => squash(a.toLowerCase()) === squash(b.toLowerCase());
const found = (pattern: RegExp, text: string): boolean => text.search(pattern) !== -1;
const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const withoutWww = (host: string): string => (host.startsWith("www.") ? host.slice(4) : host);

/**
 * Parse a run of digits (with an optional fraction) that \d matched.
 * Python's float() reads any Unicode decimal digit; Number() reads only ASCII ones.
 */
function parseNumber(digits: string): number {
  const ascii = digits.replace(NON_ASCII_DIGIT_RX, (char) => {
    // Unicode encodes decimal digits in contiguous runs of ten, each starting at its zero.
    const code = char.codePointAt(0) as number;
    let zero = code;
    while (IS_DIGIT_RX.test(String.fromCodePoint(zero - 1))) zero--;
    return String((code - zero) % 10);
  });
  return Number(ascii);
}

/** Python's f"{amount:,.0f}": rounded half-to-even, with thousands separators. */
function wholeDollars(amount: number): string {
  if (Number.isNaN(amount)) return "nan";
  const sign = amount < 0 || Object.is(amount, -0) ? "-" : "";
  if (!Number.isFinite(amount)) return `${sign}inf`;
  const digits = BigInt(roundHalfEven(Math.abs(amount), 0)).toString();
  return sign + digits.replace(/\B(?=(?:\d{3})+$)/g, ",");
}

// ---------- Draft text fields ----------

type TextField = [name: DraftTextField, text: string];

/** A free-text field, as the prose rules (1, 5 and 9) read it. */
interface ProseField {
  name: DraftTextField;
  text: string;
  /**
   * Rule 1 applies. False only for an answer the user typed themselves and Reygent
   * remembered: it may state facts the bank does not hold, and it is theirs to state.
   */
  grounded: boolean;
  /**
   * A rewrite may repair a flaw in it. False only for a remembered answer, which is
   * sent as the user gave it or not at all.
   */
  rewritable: boolean;
}

const FIELD_RX = /^(cvBullets|screeningAnswers)\[(\d+)\]$/;

/** Every piece of text the draft would send. */
function allFields(draft: ApplicationDraft): TextField[] {
  const fields: TextField[] = strip(draft.pitch) ? [["pitch", draft.pitch]] : [];
  // Present only when a model wrote it; the candidate's own summary is theirs and is not inspected.
  if (strip(draft.cvSummary ?? "")) fields.push(["cvSummary", draft.cvSummary ?? ""]);
  draft.cvBullets.forEach((bullet, i) => fields.push([`cvBullets[${i}]`, bullet.text]));
  draft.screeningAnswers.forEach((answer, i) => fields.push([`screeningAnswers[${i}]`, answer.answer]));
  return fields;
}

/** A copy of `draft` with one text field replaced; the original is left untouched. */
function withText(draft: ApplicationDraft, field: string, text: string): ApplicationDraft {
  const revised = structuredClone(draft);
  const match = FIELD_RX.exec(field);
  if (field === "pitch") revised.pitch = text;
  else if (field === "cvSummary") revised.cvSummary = text;
  else if (match?.[1] === "cvBullets") revised.cvBullets[Number(match[2])].text = text;
  else if (match) revised.screeningAnswers[Number(match[2])].answer = text;
  return revised;
}

// ---------- 1. Fact grounding ----------

const URL_SOURCE = String.raw`(?:https?://|www\.)[^\s<>"'\])]+|\b(?:github\.com|linkedin\.com)/[^\s<>"'\])]+`;
const URL_RX = rx(URL_SOURCE, "gi");
const EMAIL_SOURCE = String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const EMAIL_RX = rx(EMAIL_SOURCE, "g");
const WHOLE_EMAIL_RX = rx(`^(?:${EMAIL_SOURCE})$`);
const RATE_RX = rx(
  String.raw`\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\s*(?:usd\s*)?(?:/|per\s+|an?\s+)\s*` +
    String.raw`(hr|hour|h|day|week|wk|mo|month|yr|year|annum)\b`,
  "gi",
);
const NUMBER_RX = rx(
  String.raw`(?<![\w.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|percent\b|x\b|k\b|mm\b|m\b|bn\b|b\b|ms\b)?`,
  "gi",
);
const SCALE = new Map([["k", 1e3], ["m", 1e6], ["mm", 1e6], ["b", 1e9], ["bn", 1e9]]);
// Metrics written out in words are claims too: "doubled", "sixty percent", "millions of users".
const NUMBER_WORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty" +
  "|fifty|sixty|seventy|eighty|ninety|hundred|thousand)";
const QUANTITY_WORD_RX = rx(
  String.raw`\b(?:hundreds?|thousands?|millions?|billions?|dozens?|doubl\w+|tripl\w+|quadrupl\w+|halv\w+` +
    String.raw`|${NUMBER_WORD}[- ]?fold|${NUMBER_WORD}(?:[- ]${NUMBER_WORD})?\s+(?:percent|times)\b)`,
  "gi",
);

const TECH_LEXICON = [
  "python", "typescript", "javascript", "java", "kotlin", "golang", "rust", "ruby", "php", "scala",
  "elixir", "c++", "c#", "solidity", "haskell", "clojure", "erlang", "perl", "lua", "objective-c",
  "react", "react native", "next.js", "vue", "nuxt", "angular", "svelte", "sveltekit", "remix",
  "redux", "tailwind", "storybook", "vite", "webpack", "jquery", "flutter", "swiftui",
  "node.js", "deno", "django", "flask", "fastapi", "ruby on rails", "spring boot", "laravel",
  "nestjs", "express.js", "graphql", "grpc", "asp.net",
  "postgresql", "mysql", "mongodb", "redis", "sqlite", "elasticsearch", "opensearch", "kafka",
  "rabbitmq", "dynamodb", "cassandra", "snowflake", "bigquery", "clickhouse", "redshift",
  "databricks", "airflow", "dbt", "supabase", "firebase", "prisma",
  "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "ansible", "pulumi", "cloudflare",
  "vercel", "datadog", "prometheus", "grafana", "jenkins", "github actions",
  "langchain", "langgraph", "llamaindex", "mcp", "rag", "pgvector", "qdrant", "pinecone",
  "weaviate", "chroma", "milvus", "faiss", "pytorch", "tensorflow", "keras", "scikit-learn",
  "hugging face", "vllm", "ollama", "dspy", "crewai", "autogen",
  "playwright", "selenium", "cypress", "jest", "pytest", "puppeteer",
];
const TECH_ALIASES = new Map([
  ["postgres", "postgresql"], ["nextjs", "next.js"], ["next js", "next.js"], ["nodejs", "node.js"],
  ["node js", "node.js"], ["k8s", "kubernetes"], ["tailwindcss", "tailwind"], ["tailwind css", "tailwind"],
  ["model context protocol", "mcp"], ["google cloud", "gcp"], ["google cloud platform", "gcp"],
  ["amazon web services", "aws"], ["huggingface", "hugging face"], ["vue.js", "vue"], ["vuejs", "vue"],
  ["react.js", "react"], ["reactjs", "react"], ["llama index", "llamaindex"], ["mongo", "mongodb"],
  ["elastic search", "elasticsearch"], ["retrieval-augmented generation", "rag"],
  ["retrieval augmented generation", "rag"], ["scikit learn", "scikit-learn"], ["sklearn", "scikit-learn"],
]);
// Capitalised words after "at" that are not organisations.
const ORG_STOPWORDS = new Set([
  "i", "the", "a", "an", "your", "our", "my", "this", "that", "these", "those", "it", "we", "you",
  "series", "seed", "scale",
]);
// The lead-in ("at", "formerly", "ex-") is case-insensitive; the name after it is not,
// because a capital letter is the only thing that marks it as a name.
const ORG_RX = rx(
  String.raw`(?:(?i:\b(?:at|formerly(?:\s+(?:at|with|of))?|previously\s+(?:at|with)|joined|worked\s+(?:at|for|with)` +
    String.raw`|clients?\s+(?:like|such\s+as|including)))\s+|(?i:\bex-))` +
    String.raw`([A-Z][\w&'.-]*(?:\s+(?!I\b)[A-Z][\w&'.-]*){0,3})`,
  "g",
);

/** Blank out URLs and emails, which are verified by rule 3 rather than as claims. */
function maskContacts(text: string): string {
  return text.replace(URL_RX, " ").replace(EMAIL_RX, " ");
}

/**
 * Quantitative claims in `text` as {"value|kind": as written}; quoted rates are excluded.
 *
 * "45%", "45 percent" -> "45|%"; "300k" -> "300000|"; "$2M" -> "2000000|$";
 * "doubled" -> "doubled|word".
 */
function numbers(text: string): Map<string, string> {
  const claims = maskContacts(text).replace(RATE_RX, " ");
  const claimed = new Map<string, string>();
  for (const [written] of claims.matchAll(QUANTITY_WORD_RX)) {
    claimed.set(`${squash(written.toLowerCase())}|word`, written);
  }
  for (const [written, dollar, whole, fraction = "", suffix = ""] of claims.matchAll(NUMBER_RX)) {
    const unit = suffix.toLowerCase();
    const value = parseNumber(whole.replaceAll(",", "") + fraction) * (SCALE.get(unit) ?? 1);
    const kind = dollar ? "$" : unit === "%" || unit === "percent" ? "%" : unit === "x" || unit === "ms" ? unit : "";
    const claim = `${roundHalfEven(value, 6)}|${kind}`;
    if (!claimed.has(claim)) claimed.set(claim, strip(written));
  }
  return claimed;
}

function canonTech(term: string): string {
  const key = squash(term.toLowerCase());
  return TECH_ALIASES.get(key) ?? key;
}

/** Matches any known technology name, plus whatever stack the job itself lists. */
function techPattern(jobSkills: readonly string[]): RegExp {
  const terms = new Set([...TECH_LEXICON, ...TECH_ALIASES.keys()]);
  for (const skill of jobSkills) {
    const term = squash(skill.toLowerCase());
    if (term) terms.add(term);
  }
  // Longest first, so "react native" is not read as "react".
  const alternation = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![A-Za-z0-9_+#])(?:${alternation})(?![A-Za-z0-9_+#])`, "giu");
}

function orgAllowed(name: string, allowedKeys: ReadonlySet<string>): boolean {
  const key = companyKey(name);
  for (const allowed of allowedKeys) {
    if (key === allowed || key.startsWith(`${allowed} `) || allowed.startsWith(`${key} `)) return true;
  }
  return false;
}

function ungroundedClaims(
  text: string,
  allowedNumbers: ReadonlyMap<string, string>,
  allowedTech: ReadonlySet<string>,
  allowedOrgs: ReadonlySet<string>,
  tech: RegExp,
  source: string,
): string[] {
  const problems: string[] = [];
  for (const [claim, written] of numbers(text)) {
    if (!allowedNumbers.has(claim)) problems.push(`figure '${written}' is not in ${source}`);
  }
  const masked = maskContacts(text);
  const mentioned = new Set(Array.from(masked.matchAll(tech), ([term]) => canonTech(term)));
  for (const term of [...mentioned].filter((term) => !allowedTech.has(term)).sort()) {
    problems.push(`technology '${term}' is not in ${source}`);
  }
  for (const [, captured] of masked.matchAll(ORG_RX)) {
    const name = captured.replace(/[.,'-]+$/, "");
    if (!ORG_STOPWORDS.has(words(name)[0].toLowerCase()) && !orgAllowed(name, allowedOrgs)) {
      problems.push(`organisation '${name}' is not a verified employer or client`);
    }
  }
  return problems;
}

/** What claims may be grounded on for one listing: the verified bank, and how to spot a technology. */
interface FactBank {
  verified: Map<string, Achievement>;
  tech: RegExp;
  bankTech: Set<string>;
  bankOrgs: Set<string>;
  bankNumbers: Map<string, string>;
}

function factBank(job: JobOpportunity, profile: CandidateProfile, extraFacts: string): FactBank {
  const verified = new Map(verifiedAchievements(profile).map((achievement) => [achievement.id, achievement]));
  const tech = techPattern(job.skills);
  const bankTech = new Set(Array.from(verifiedTechnologies(profile), canonTech));
  const bankOrgs = new Set([job.company, ...profile.employers].filter(Boolean).map(companyKey));
  for (const achievement of verified.values()) {
    if (achievement.employer) bankOrgs.add(companyKey(achievement.employer));
  }
  const bankText = [...Object.values(screeningFacts(profile)), ...Array.from(verified.values(), achievementFactText)];
  // The candidate's own notes vouch for figures only: a technology or employer named there
  // is still not one the profile lists, so it grounds neither.
  if (strip(extraFacts)) bankText.push(extraFacts);
  return { verified, tech, bankTech, bankOrgs, bankNumbers: numbers(bankText.join(" ")) };
}

/** Claims in a CV bullet that its own achievement does not make: a bullet restates one achievement, not another. */
function ungroundedInAchievement(text: string, achievement: Achievement, bank: FactBank): string[] {
  return ungroundedClaims(
    text, numbers(achievementFactText(achievement)), new Set(achievement.technologies.map(canonTech)),
    bank.bankOrgs, bank.tech, `verified achievement '${achievement.id}'`,
  );
}

const ungroundedInBank = (text: string, bank: FactBank): string[] =>
  ungroundedClaims(text, bank.bankNumbers, bank.bankTech, bank.bankOrgs, bank.tech, "the verified fact bank");

/**
 * Rule 1 for one piece of text, for whoever writes it to ask before the draft is put
 * together: every figure, technology and employer in `text` that the verified facts do not
 * hold. With `achievementId` the text is a CV line and is held to that achievement alone;
 * without, to the whole bank. Empty when the text is grounded.
 */
export function groundingProblems(
  text: string,
  job: JobOpportunity,
  profile: CandidateProfile,
  options: { achievementId?: string; extraFacts?: string } = {},
): string[] {
  const bank = factBank(job, profile, options.extraFacts ?? "");
  if (options.achievementId === undefined) return ungroundedInBank(text, bank);
  const achievement = bank.verified.get(options.achievementId);
  return achievement
    ? ungroundedInAchievement(text, achievement, bank)
    : [`cites achievement '${options.achievementId}', which is not in the verified bank`];
}

function checkFactGrounding(
  draft: ApplicationDraft,
  job: JobOpportunity,
  profile: CandidateProfile,
  prose: readonly ProseField[],
  extraFacts: string,
): Violation[] {
  const rule = CopRule.FACT_GROUNDING;
  const bank = factBank(job, profile, extraFacts);
  const violations: Violation[] = [];
  for (const { name, text, grounded } of prose) {
    if (!grounded) continue;
    const match = FIELD_RX.exec(name);
    let problems: string[];
    if (match?.[1] === "cvBullets") {
      // A CV bullet must restate its own achievement, not borrow from another.
      const bullet = draft.cvBullets[Number(match[2])];
      const achievement = bank.verified.get(bullet.achievementId);
      if (!achievement) {
        violations.push(
          violation(rule, name, `cites achievement '${bullet.achievementId}', which is not in the verified bank`),
        );
        continue;
      }
      problems = ungroundedInAchievement(text, achievement, bank);
    } else {
      problems = ungroundedInBank(text, bank);
    }
    for (const problem of problems) violations.push(violation(rule, name, problem, true));
  }
  return violations;
}

// ---------- 2. Screening answer sanity (zero guessing) ----------

// "race" is the demographic unless it is followed by "condition": that one is a concurrency bug.
const SENSITIVE_TOPIC_RX = rx(
  String.raw`authori[sz]|sponsor|\bvisa\b|citizen|nationality|\bresiden(?:t|ce|cy)\b|right to work` +
    String.raw`|eligib\w+ to work|\blegal(?:ly)?\b|work (?:permit|status)|immigration|\btax|\bw-?[289]\b` +
    String.raw`|\b1099\b|\bvat\b|\bein\b|\bssn\b|social security|clearance|criminal|convict|background check` +
    String.raw`|disabilit|veteran|gender|\brace\b(?!\s+conditions?)|ethnic`,
  "i",
);

// The next four patterns are the drafting step's (DEMOGRAPHIC_TOPICS[].asked, DECLINE_OPTION_RX,
// PAY_QUESTION_RX and PAST_PAY_RX in drafting/tailor.ts). They are copied, not imported: the
// gate must not take its definitions from the module it checks. Keep them in step, or an
// answer the drafter considers settled will be held here.

// Voluntary self-identification: gender and sex, race and ethnicity, veteran and military
// status, disability, sexual orientation, pronouns.
const DEMOGRAPHIC_TOPIC_RX = new RegExp(
  [
    /\bgender\b|\bsex\b/,
    /\brace\b(?!\s+conditions?)|\bracial\b|\bethnic|\bhispanic\b|\blatin[oax]\b/,
    /\bveteran|\bmilitary service\b|\barmed forces\b/,
    /\bdisabilit|\bdisabled\b/,
    /\bsexual orientation\b|\blgbt/,
    /\bpronouns?\b/,
  ].map((topic) => topic.source).join("|"),
  "i",
);
const DECLINE_RX = /decline|prefer not|do not wish|don't wish|choose not|not to (?:say|answer|disclose|identify|specify)/i;
/** "I prefer not to say" is a decline; a paragraph that happens to contain "prefer not" is not. */
const MAX_DECLINE_WORDS = 8;
// Asks what the candidate expects to be paid. "Rate" counts only as a noun about pay:
// "How would you rate your Python?" is a different question.
const PAY_QUESTION_RX = new RegExp(
  [
    String.raw`\b(?:salary|salaries|compensation|remuneration)\b`,
    String.raw`\bpay\s+(?:expectations?|requirements?)\b|\b(?:expected|desired)\s+pay\b`,
    String.raw`\b(?:hourly|daily|day|weekly|monthly|contract(?:or|ing)?|consulting|freelance|billing|desired|expected` +
      String.raw`|target|minimum|preferred|your|what)\s+rates?\b`,
    String.raw`\brates?\s+(?:expectations?|requirements?|range|card)\b`,
    String.raw`^\W*rates?\W*(?:\([^)]*\)\W*)?$`,
  ].join("|"),
  "i",
);
// Asks what the candidate is or was paid, which the quoted rate does not answer.
const PAST_PAY_RX = /\b(?:current(?:ly)?|present|previous(?:ly)?|prior|last|past|most recent|existing|history)\b/i;

/** Touches work status, tax, legal standing or self-identification: an answer here is a statement about the candidate. */
const isSensitive = (text: string): boolean => found(SENSITIVE_TOPIC_RX, text) || DEMOGRAPHIC_TOPIC_RX.test(text);

/** The answer declines: the offered option it picks is a decline, or, as free text, it is a short decline and no more. */
function declines(item: ScreeningAnswer): boolean {
  if (item.options.length === 0) {
    return words(item.answer).length <= MAX_DECLINE_WORDS && DECLINE_RX.test(normalizePunctuation(item.answer));
  }
  const chosen = item.options.find((option) => same(item.answer, option));
  return chosen !== undefined && DECLINE_RX.test(normalizePunctuation(chosen));
}

/**
 * How a screening answer is judged.
 *
 *   remembered   the user answered this exact question before, with an answer this form can
 *                take; the draft must repeat it
 *   fact         a verbatim profile fact (`factKey`)
 *   declined     a demographic self-identification question answered by declining, or no
 *                accommodation asked for
 *   found        "how did you hear about us?", answered with where the listing really was, or
 *                "Other" when no option names that place
 *   counted      years of experience in all, answered with the option holding the profile's years
 *   status       may the candidate work there, need sponsorship, or move: settled by where
 *                they live and by the listing (qualification/workStatus), so the answer must
 *                say that yes or no
 *   acknowledged a privacy or data notice, confirmed with the form's own confirming option
 *   disclaims    "No" to experience with a technology the verified bank does not hold, or the
 *                option claiming the least: no experience or the least of it, a consent
 *                declined, a notice's only option. The CV is the record of what the candidate
 *                has done, and saying no more than it claims nothing
 *   attestation  a sensitive or multiple-choice question: a statement about the candidate,
 *                sent only if an independent check finds it true of the candidate's data
 *   prose        free text for an open question, judged by rules 1, 5 and 9 alone
 */
type JudgedAnswer =
  | { kind: "remembered"; remembered: string }
  | { kind: "status"; yes: boolean }
  | { kind: "fact" | "declined" | "found" | "counted" | "acknowledged" | "disclaims" | "attestation" | "prose" };

// "How did you hear about us?" has a known answer: where Reygent read the listing. This is
// the gate's own reading of it, not the drafting step's.
const HEARD_ABOUT_QUESTION_RX =
  /\bhow\s+(?:did|do)\s+you\s+(?:first\s+)?(?:hear|learn|find\s+out|come\s+across|discover|find)\b|\bwhere\s+did\s+you\s+(?:first\s+)?(?:hear|find|see|learn)\b|\bwhat\s+(?:platform|site|website|source|channel)\b[^?]{0,40}\b(?:apply|hear|find|learn)\b/i;
const JOB_SITE_NAMES: Readonly<Record<string, string>> = {
  remotive: "remotive", remoteok: "remoteok", jobicy: "jobicy", himalayas: "himalayas", workingnomads: "workingnomads",
  weworkremotely: "weworkremotely", realworkfromanywhere: "realworkfromanywhere", golangprojects: "golangprojects",
  python_org: "pythonorg", hn: "hackernews", hn_freelance: "hackernews",
};

/** True when `answer` names the place the listing was actually found: the careers page of a company board, or the job site. */
function namesWhereFound(answer: string, job: Pick<JobOpportunity, "source">): boolean {
  if (COMPANY_BOARD_SOURCES.has(job.source)) {
    return /\bcareers?\b|\b(?:company|corporate|your|our)\s*(?:web\s*)?site\b|\bwebsite\b/i.test(answer);
  }
  const site = JOB_SITE_NAMES[job.source];
  if (!site) return false;
  return answer.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(site) || /\bjob\s*(?:board|site|posting|search|listing)s?\b/i.test(answer);
}

// A notice the applicant confirms: privacy, GDPR, data processing, or a bare "I agree". The
// gate's own reading; one that mentions AI may be asking the applicant not to use it.
const ACKNOWLEDGEMENT_QUESTION_RX =
  /\backnowledg\w*|\bprivacy\b|\bgdpr\b|\bdata\s+(?:protection|processing|retention)\b|^\W*(?:I\s+)?(?:agree|confirm)\W*$/i;
const MENTIONS_AI_RX = /\bA\.?I\b|\bartificial\s+intelligence\b|\bgenerat(?:ed|ive)\b|\bChatGPT\b|\bLLMs?\b/i;
const CONFIRMS_RX = /\backnowledg\w*|\bconfirm\w*|\bagree\w*|\baccept\w*|\bconsent\w*|\bI\s+have\s+read\b|^\W*yes\b/i;
// Asks whether the candidate has used something: "Do you have production experience with React Native?"
const EXPERIENCE_QUESTION_RX =
  /\bexperience\b|\bexperienced\b|\bworked\s+(?:with|on|in)\b|\bused\b|\bfamiliar\b|\bproficien\w*|\bshipped\b|\bbuilt\b/i;

/** The technologies `question` names, as the bank would name them. */
const techsNamed = (question: string, job: Pick<JobOpportunity, "skills">): string[] =>
  Array.from(question.matchAll(techPattern(job.skills)), ([term]) => canonTech(term));

/** True when `item` answers "No" to having used technologies, every one of which the verified bank lacks. */
function disclaimsUnverified(item: ScreeningAnswer, job: Pick<JobOpportunity, "skills">, profile: CandidateProfile): boolean {
  if (saysYes(item.answer) || !EXPERIENCE_QUESTION_RX.test(item.question)) return false;
  const named = techsNamed(item.question, job);
  if (!named.length) return false;
  const verified = new Set(Array.from(verifiedTechnologies(profile), canonTech));
  return named.every((term) => !verified.has(term));
}

/**
 * True when `item` picks the option claiming the least (no experience, a consent declined, a
 * notice's only option) and the question names no technology the verified bank holds: the
 * least of one the CV shows would contradict the record, not stay within it.
 */
function claimsLeast(item: ScreeningAnswer, job: Pick<JobOpportunity, "skills">, profile: CandidateProfile): boolean {
  const modest = modestOption(item.question, item.options);
  if (modest === null || !same(item.answer, modest)) return false;
  const verified = new Set(Array.from(verifiedTechnologies(profile), canonTech));
  return !techsNamed(item.question, job).some((term) => verified.has(term));
}

function judgeAnswer(
  item: ScreeningAnswer,
  draft: ApplicationDraft,
  job: JobOpportunity,
  profile: CandidateProfile,
  standingAnswer: StandingAnswer | undefined,
): JudgedAnswer {
  const isChoice = item.options.length > 0;
  // One listing's answer to "may you work in this role's country?" is not another's, so no
  // remembered answer settles it.
  const status = workStatusAnswer(item.question, job, profile, item.options);
  if (status?.perJob) return { kind: "status", yes: status.yes };
  // A remembered answer binds only where it could be given. A blank one is no answer; and one
  // this form does not offer was given to the same question with other choices, so whichever
  // option the draft picked instead is judged on its own merits below.
  const remembered = standingAnswer?.(item.question) ?? "";
  if (strip(remembered) && (!isChoice || item.options.some((option) => same(remembered, option)))) {
    return { kind: "remembered", remembered };
  }
  if (item.factKey) return { kind: "fact" };
  // Declining to self-identify is always a truthful answer, so it needs no verification.
  if (DEMOGRAPHIC_TOPIC_RX.test(item.question) && declines(item)) return { kind: "declined" };
  // Asking for no accommodation is a request the candidate may always make, not a statement about them.
  if (/\baccommodat\w*/i.test(item.question) && (declines(item) || !saysYes(item.answer))) return { kind: "declined" };
  // Where the role was found is a fact about the listing, not a claim about the candidate;
  // so is "Other" when no option names that place.
  if (
    isChoice && HEARD_ABOUT_QUESTION_RX.test(item.question) &&
    (namesWhereFound(item.answer, job) || (/^\W*other\W*$/i.test(item.answer) && !item.options.some((option) => namesWhereFound(option, job))))
  ) {
    return { kind: "found" };
  }
  // Experience in all, as the option holding the years the profile states.
  if (isChoice && totalYearsOption(item.question, item.options, profile.yearsExperience) === item.answer) return { kind: "counted" };
  if (status) return { kind: "status", yes: status.yes };
  if (
    isChoice && ACKNOWLEDGEMENT_QUESTION_RX.test(item.question) && !MENTIONS_AI_RX.test(item.question) &&
    !isSensitive(item.question) && CONFIRMS_RX.test(item.answer) && saysYes(item.answer)
  ) {
    return { kind: "acknowledged" };
  }
  if (disclaimsUnverified(item, job, profile)) return { kind: "disclaims" };
  if (isChoice && !isSensitive(item.question) && claimsLeast(item, job, profile)) return { kind: "disclaims" };
  if (isChoice) return { kind: "attestation" };
  // The quoted rate, stated in answer to "what do you expect to be paid" and saying nothing
  // on a sensitive topic itself, attests nothing: rule 6 checks the rate and the prose rules
  // the wording, even when the question also mentions tax or a 1099.
  const quotesRate =
    PAY_QUESTION_RX.test(item.question) &&
    !PAST_PAY_RX.test(item.question) &&
    statesOnlyQuotedRate(item.answer, draft) &&
    !isSensitive(item.answer);
  return { kind: isSensitive(item.question) && !quotesRate ? "attestation" : "prose" };
}

/**
 * The free text the prose rules read: the pitch, a written CV summary, the CV bullets, and every screening answer
 * that is not a choice among offered options or a verbatim profile fact. Passing rule 2 does
 * not exempt free text — a verified or remembered answer can still promise to relocate.
 */
function proseFields(draft: ApplicationDraft, judged: readonly JudgedAnswer[]): ProseField[] {
  const written = { grounded: true, rewritable: true };
  const fields: ProseField[] = strip(draft.pitch) ? [{ name: "pitch", text: draft.pitch, ...written }] : [];
  if (strip(draft.cvSummary ?? "")) fields.push({ name: "cvSummary", text: draft.cvSummary ?? "", ...written });
  draft.cvBullets.forEach((bullet, i) => fields.push({ name: `cvBullets[${i}]`, text: bullet.text, ...written }));
  draft.screeningAnswers.forEach((item, i) => {
    const { kind } = judged[i];
    if (item.options.length > 0 || kind === "fact") return;
    const own = kind === "remembered";
    fields.push({ name: `screeningAnswers[${i}]`, text: item.answer, grounded: !own, rewritable: !own });
  });
  return fields;
}

/**
 * Each answer is settled by the first of these that applies:
 *
 *   a. empty                          -> held: the user has to answer
 *   b. not one of the offered options -> held
 *   c. remembered answer this form can take -> must repeat it
 *   d. cites a profile fact           -> must be that fact, verbatim
 *   e. demographic question, declined -> fine
 *   f. work status                    -> must say the yes or no that residence and listing give
 *   g. a notice confirmed, "No" to a technology the bank lacks, or the option claiming the least -> fine
 *   h. sensitive, demographic or multiple-choice -> must be confirmed by `isSupported`
 *   i. anything else is prose, which rules 1, 5 and 9 judge instead
 *
 * `isSupported` is undefined when no verifier is configured; nothing at step h passes then.
 */
async function checkScreeningAnswers(
  draft: ApplicationDraft,
  profile: CandidateProfile,
  judged: readonly JudgedAnswer[],
  isSupported: ((item: ScreeningAnswer) => Promise<boolean>) | undefined,
): Promise<Violation[]> {
  const rule = CopRule.SCREENING_SANITY;
  const facts = screeningFacts(profile);
  const violations: Violation[] = [];
  for (const [i, item] of draft.screeningAnswers.entries()) {
    const question = `'${item.question}'`;
    const verdict = judged[i];
    let problem = "";
    if (!strip(item.answer)) {
      problem = `${question} could not be answered from your data — answer it once and Reygent will remember it`;
    } else if (item.options.length > 0 && !item.options.some((option) => same(item.answer, option))) {
      problem = `answer to ${question} is not one of the offered options`;
    } else if (verdict.kind === "remembered") {
      if (!same(item.answer, verdict.remembered)) {
        problem = `answer to ${question} differs from your remembered answer`;
      }
    } else if (verdict.kind === "fact") {
      // hasOwn, not a plain lookup: a fact key of "constructor" must not resolve to Object's.
      const fact = Object.hasOwn(facts, item.factKey) ? facts[item.factKey] : undefined;
      if (fact === undefined) {
        problem = `answer to ${question} cites fact '${item.factKey}', which the profile does not hold`;
      } else if (!same(item.answer, fact)) {
        problem = `answer to ${question} differs from the verified '${item.factKey}' fact`;
      }
    } else if (verdict.kind === "status") {
      if (saysYes(item.answer) !== verdict.yes) {
        problem =
          `answer to ${question} ("${item.answer}") says ${verdict.yes ? "no" : "yes"}, but where the candidate` +
          ` lives and this listing say ${verdict.yes ? "yes" : "no"}`;
      }
    } else if (verdict.kind === "attestation") {
      if (!isSupported) {
        problem = `${question} needs an answer from you: no decision model is configured to verify one`;
      } else if (!(await isSupported(item))) {
        problem =
          `answer to ${question} ("${item.answer}") is not supported by your data` +
          " — answer it once and Reygent will remember it";
      }
    }
    if (problem) violations.push(violation(rule, `screeningAnswers[${i}]`, problem));
  }
  return violations;
}

// ---------- 3. Link & contact verification ----------

async function checkLinks(
  draft: ApplicationDraft,
  profile: CandidateProfile,
  rewritable: ReadonlySet<string>,
  linkChecker: LinkChecker,
): Promise<Violation[]> {
  const rule = CopRule.LINK_VERIFICATION;
  const verified = new Set(Array.from(verifiedLinks(profile), normalizeUrl));
  const violations: Violation[] = [];
  const toCheck = new Set<string>();
  for (const [name, text] of allFields(draft)) {
    for (const [matched] of text.matchAll(URL_RX)) {
      const url = matched.replace(/[.,;:!?)]+$/, "");
      if (verified.has(normalizeUrl(url))) {
        toCheck.add(url);
      } else {
        violations.push(violation(
          rule, name, `link ${url} is not one of the candidate's verified links`, rewritable.has(name),
        ));
      }
    }
    for (const [email] of text.matchAll(EMAIL_RX)) {
      if (email.toLowerCase() !== profile.email.toLowerCase()) {
        violations.push(violation(
          rule, name, `email ${email} is not the candidate's verified address`, rewritable.has(name),
        ));
      }
    }
  }
  // Only links already matched to the fact bank are ever fetched.
  for (const url of [...toCheck].sort()) {
    const status = await linkChecker(url);
    if (!status.ok) violations.push(violation(rule, "links", `${url}: ${status.detail}`));
  }
  return violations;
}

// ---------- 4. Asset & format integrity ----------

const TEMPLATE_TOKEN_RX = rx(
  String.raw`\{\{.*?\}\}|\{%.*?%\}|\$\{[^}]*\}` +
    String.raw`|\[(?:your|my|company|name|role|position|title|insert|recipient|hiring manager|date|x+)\b[^\]]*\]` +
    String.raw`|<(?:placeholder|insert|your|company|name)\b[^>]*>` +
    String.raw`|\b${PLACEHOLDER}\b|\bTODO\b|\bTBD\b|\bXXX+\b|lorem ipsum`,
  "gis",
);

function checkAssets(
  draft: ApplicationDraft,
  profile: CandidateProfile,
  rewritable: ReadonlySet<string>,
  policy: CopConfig,
): Violation[] {
  const rule = CopRule.ASSET_INTEGRITY;
  const violations: Violation[] = [];
  if (profile.name.includes(PLACEHOLDER) || profile.email.includes(PLACEHOLDER)) {
    violations.push(violation(rule, "profile", "candidate name / email are still placeholders"));
  }
  const fields = allFields(draft);
  if (fields.length === 0) violations.push(violation(rule, "draft", "draft has no content"));
  for (const [name, text] of fields) {
    if (!strip(text)) violations.push(violation(rule, name, "text is empty"));
    for (const [token] of text.matchAll(TEMPLATE_TOKEN_RX)) {
      violations.push(violation(rule, name, `unresolved template token '${token}'`, rewritable.has(name)));
    }
  }
  if (draft.resumePdfPath) {
    for (const issue of inspectPdf(draft.resumePdfPath, policy.min_pdf_bytes, policy.max_pdf_pages)) {
      violations.push(violation(rule, "resumePdf", issue));
    }
  }
  // A tuned CV is read back as a parser reads it when it is printed. What that found wrong
  // and could not repair holds the draft: such a CV is not sent, and no other is sent in its place.
  for (const problem of draft.cvMatch?.problems ?? []) {
    violations.push(violation(rule, "resumePdf", `the tuned CV does not read back whole: ${problem}`));
  }
  return violations;
}

// ---------- 5. Commitment guard ----------

const ONSITE_PROMISE_RX = rx(
  String.raw`\brelocat\w*|\bon[- ]?site\b|\bin[- ]office\b|\b(?:in|into|to|at|from)\s+(?:the|your)\s+office\b` +
    String.raw`|\bin[- ]person\b|\bcommut\w+|\bhybrid\s+(?:role|work\w*|schedule|arrangement|set-?up)\b`,
  "gi",
);
const AVAILABILITY_SENTENCE_RX = rx(String.raw`\b(?:available|availability|start|begin|notice|onboard)\b`, "i");
const IMMEDIATE_RX = rx(String.raw`\b(?:immediate(?:ly)?|right away|asap|straight away|today|tomorrow)\b`, "i");
const DURATION_RX = rx(String.raw`(\d+)\s*(?:-\s*)?(?:business\s+|working\s+)?(day|week|month)`, "gi");
const SENTENCE_SPLIT_RX = rx(String.raw`(?<=[.!?])\s+|\n+`);

function availabilityTerms(text: string): Set<string> {
  const terms = new Set(Array.from(text.matchAll(DURATION_RX), ([, count, unit]) => `${count} ${unit.toLowerCase()}`));
  if (found(IMMEDIATE_RX, text)) terms.add("immediately");
  return terms;
}

function checkCommitments(profile: CandidateProfile, prose: readonly ProseField[]): Violation[] {
  const rule = CopRule.COMMITMENT_GUARD;
  const notice = screeningFacts(profile).notice_period ?? "";
  const verifiedTerms = availabilityTerms(notice);
  const violations: Violation[] = [];
  for (const { name, text, rewritable } of prose) {
    for (const match of text.matchAll(ONSITE_PROMISE_RX)) {
      if (!isNegated(text, match.index, match.index + match[0].length)) {
        violations.push(violation(
          rule, name, `'${match[0]}' implies on-site presence; the candidate is remote-only`, rewritable,
        ));
      }
    }
    for (const sentence of text.split(SENTENCE_SPLIT_RX)) {
      if (!found(AVAILABILITY_SENTENCE_RX, sentence)) continue;
      for (const term of [...availabilityTerms(sentence)].filter((term) => !verifiedTerms.has(term)).sort()) {
        violations.push(violation(
          rule, name,
          `availability '${term}' is not backed by the verified notice period (${notice || "none on file"})`,
          rewritable,
        ));
      }
    }
  }
  return violations;
}

// ---------- 6. Rate floor ----------

const PERIODS = new Map([
  ["hr", "hour"], ["hour", "hour"], ["h", "hour"], ["day", "day"], ["week", "week"], ["wk", "week"],
  ["mo", "month"], ["month", "month"], ["yr", "year"], ["year", "year"], ["annum", "year"],
]);
const COMP_QUESTION_RX = rx(String.raw`\b(?:rate|salary|compensation|pay|remuneration)\b`, "i");
const BARE_AMOUNT_RX = rx(String.raw`(\d[\d,]*(?:\.\d+)?)\s?(k)?`, "i");
const QUESTION_PERIODS: ReadonlyArray<[period: string, cues: string[]]> = [
  ["hour", ["hour", "/hr"]], ["month", ["month"]], ["year", ["annual", "year", "salary"]],
];

/** Describe how `amount` per `period` undercuts the floor, if it does. */
function floorShortfall(amount: number, period: string, comp: CompensationConfig): string | null {
  const hourly = { hour: amount, day: amount / 8, week: amount / 40 }[period];
  const monthly = { month: amount, year: amount / 12 }[period];
  if (hourly !== undefined && hourly < comp.hourly_floor_usd) {
    return `$${wholeDollars(amount)}/${period} is below the $${wholeDollars(comp.hourly_floor_usd)}/hr floor`;
  }
  if (monthly !== undefined && monthly < comp.monthly_floor_usd) {
    return `$${wholeDollars(amount)}/${period} is below the $${wholeDollars(comp.monthly_floor_usd)}/mo floor`;
  }
  return null;
}

function questionPeriod(question: string): string {
  const lowered = question.toLowerCase();
  return QUESTION_PERIODS.find(([, cues]) => cues.some((cue) => lowered.includes(cue)))?.[0] ?? "";
}

const amountOf = (digits: string, thousands: string | undefined): number =>
  parseNumber(digits.replaceAll(",", "")) * (thousands ? 1000 : 1);

/** True when `text` holds exactly one figure, and it is the rate the draft quotes, for the same period. */
function statesOnlyQuotedRate(text: string, draft: ApplicationDraft): boolean {
  const rates = Array.from(text.matchAll(RATE_RX));
  if (draft.quotedRateUsd == null || rates.length !== 1) return false;
  const [, digits, thousands, unit] = rates[0];
  return (
    amountOf(digits, thousands) === draft.quotedRateUsd &&
    PERIODS.get(unit.toLowerCase()) === draft.quotedRatePeriod &&
    numbers(text).size === 0 // every other figure and worded quantity; rates are already masked out
  );
}

function checkRates(draft: ApplicationDraft, comp: CompensationConfig): Violation[] {
  const rule = CopRule.RATE_FLOOR;
  const violations: Violation[] = [];
  const quoted = draft.quotedRateUsd ?? null;
  if (quoted !== null) {
    if (draft.quotedRatePeriod !== "hour" && draft.quotedRatePeriod !== "month") {
      violations.push(violation(rule, "quotedRate", "quoted rate has no hour / month period"));
    } else {
      const shortfall = floorShortfall(quoted, draft.quotedRatePeriod, comp);
      if (shortfall) violations.push(violation(rule, "quotedRate", `quoted rate ${shortfall}`));
    }
  }
  for (const [name, text] of allFields(draft)) {
    for (const [, digits, thousands, unit] of text.matchAll(RATE_RX)) {
      const amount = amountOf(digits, thousands);
      const period = PERIODS.get(unit.toLowerCase()) ?? "";
      const shortfall = floorShortfall(amount, period, comp);
      if (shortfall) {
        violations.push(violation(rule, name, `rate in text ${shortfall}`));
      } else if (quoted !== null && period === draft.quotedRatePeriod && amount !== quoted) {
        violations.push(violation(
          rule, name,
          `rate in text ($${wholeDollars(amount)}/${period}) contradicts the quoted $${wholeDollars(quoted)}/${period}`,
        ));
      }
    }
  }
  draft.screeningAnswers.forEach((item, i) => {
    const period = questionPeriod(item.question);
    const bare = BARE_AMOUNT_RX.exec(item.answer);
    if (period && bare && found(COMP_QUESTION_RX, item.question) && !found(RATE_RX, item.answer)) {
      const shortfall = floorShortfall(amountOf(bare[1], bare[2]), period, comp);
      if (shortfall) violations.push(violation(rule, `screeningAnswers[${i}]`, `stated compensation ${shortfall}`));
    }
  });
  return violations;
}

// ---------- 7. Suspicious employer & scam filter ----------

const KNOWN_APPLY_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "wellfound.com", "angel.co",
  "ycombinator.com", "workatastartup.com", "linkedin.com", "smartrecruiters.com", "bamboohr.com",
  "recruitee.com", "teamtailor.com", "breezy.hr", "jobvite.com", "myworkdayjobs.com", "icims.com",
  "rippling.com", "remoteok.com", "weworkremotely.com", "remotive.com", "x.com", "twitter.com",
  "github.com", "discord.com", "discord.gg",
  // The other job sites discovery reads: a listing found there links to its page there.
  "himalayas.app", "jobicy.com", "workingnomads.com", "realworkfromanywhere.com", "golangprojects.com", "python.org",
];
const URL_SHORTENERS = [
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rb.gy", "shorturl.at", "ow.ly",
  "rebrand.ly",
];
const RAW_IPV4_RX = rx(String.raw`^[\d.]+$`);
const SCAM_PATTERNS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ["pay-to-work scheme", rx(
    String.raw`\b(?:registration|application|training|onboarding|processing|admin(?:istration)?|starter[- ]kit` +
      String.raw`|equipment)\s+fee\b|\bdeposit\s+(?:is\s+)?required\b` +
      String.raw`|\bpay\s+(?:for|upfront)\s+(?:your\s+)?(?:own\s+)?(?:training|equipment|certification|background check)\b` +
      String.raw`|\b(?:purchase|buy)\s+(?:your\s+)?(?:own\s+)?equipment\s+from\s+our\b` +
      String.raw`|\b(?:buy|purchase|send)\s+(?:\w+\s+){0,3}gift\s+cards?\b|\b(?:send|wire)\s+(?:us\s+)?(?:money|funds)\b` +
      String.raw`|\bdeposit\s+(?:the|a|this|our)\s+che(?:ck|que)\b|\bwestern union\b|\bmoneygram\b` +
      String.raw`|\binvestment\s+(?:is\s+)?required\b`,
    "i",
  )],
  ["recruiter operating over an anonymous chat app", rx(
    String.raw`\btelegram\b|\bt\.me/|\bwhats\s?app\b|\bwa\.me/` +
      String.raw`|\binterview\s+(?:will\s+be\s+)?(?:conducted\s+)?(?:via|on|over)\s+(?:google\s+hangouts|signal|skype\s+chat)\b`,
    "i",
  )],
  ["too-good-to-be-true offer", rx(
    String.raw`\bno\s+experience\s+(?:needed|required|necessary)\b|\beasy\s+money\b` +
      String.raw`|\bearn\s+(?:up\s+to\s+)?\$\d[\d,]*\s*(?:per|a|/)\s*(?:day|week)\b` +
      String.raw`|\bguaranteed\s+(?:income|earnings|pay)\b`,
    "i",
  )],
];

const hostMatches = (host: string, domains: readonly string[]): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

function applyUrlProblem(job: JobOpportunity): string | null {
  if (!job.applyUrl) return null;
  const invalid = `apply link '${job.applyUrl}' is not a valid HTTPS URL`;
  let parts;
  try {
    parts = splitUrl(job.applyUrl);
  } catch {
    return invalid; // a host that cannot be parsed is not one to send an application to
  }
  if (parts.scheme === "mailto") return null;
  const host = parts.hostname;
  if (parts.scheme !== "https" || !host) return invalid;
  if (found(RAW_IPV4_RX, host) || host.includes(":")) return `apply link points at a raw IP address (${host})`;
  if (host.includes("xn--")) return `apply domain '${host}' uses look-alike (punycode) characters`;
  if (hostMatches(host, URL_SHORTENERS)) {
    return `apply link hides its destination behind a URL shortener (${host})`;
  }
  const ownDomain = withoutWww(job.companyDomain.toLowerCase());
  if (hostMatches(host, KNOWN_APPLY_HOSTS) || (ownDomain && hostMatches(host, [ownDomain]))) return null;
  // A listing read from the company's own board came with this link from the board's
  // provider: it is the employer's careers address even when it is on a domain of their
  // own (careers.example.com) that the listing does not otherwise name.
  if (COMPANY_BOARD_SOURCES.has(job.source)) return null;
  return `apply domain '${host}' is neither a known hiring platform nor the company's own domain`;
}

function checkScamSignals(draft: ApplicationDraft, job: JobOpportunity): Violation[] {
  const rule = CopRule.SCAM_FILTER;
  const violations: Violation[] = [];
  const problem = applyUrlProblem(job);
  if (problem) violations.push(violation(rule, "job", problem));
  const listing = cleanText(`${job.title}\n${job.description}\n${draft.contact}`);
  for (const [label, pattern] of SCAM_PATTERNS) {
    const match = pattern.exec(listing);
    if (match) violations.push(violation(rule, "job", `${label}: '${match[0]}'`));
  }
  return violations;
}

// ---------- 8. De-duplication ----------

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com",
  "proton.me", "protonmail.com", "hey.com", "pm.me",
]);
const DAY_MS = 86_400_000;
const TIMESTAMP_RX = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d)(?::(\d\d)(?:\.(\d{3}))?)?)?)?/;

/** Who a dispatch reaches: the company, its own email/web domain, and the person. */
export function dedupKeys(
  draft: ApplicationDraft,
  job: JobOpportunity,
): { companyKey: string; domain: string; contact: string } {
  const contact = strip(draft.contact).toLowerCase();
  let domain = withoutWww(job.companyDomain.toLowerCase());
  if (!domain && WHOLE_EMAIL_RX.test(contact)) {
    const contactDomain = contact.slice(contact.lastIndexOf("@") + 1);
    domain = FREE_MAIL.has(contactDomain) ? "" : contactDomain;
  }
  return { companyKey: companyKey(job.company), domain, contact };
}

/**
 * The calendar fields of a stored timestamp, as epoch milliseconds read as if they were UTC.
 * Dates are reported as the timestamp itself spells them, whatever UTC offset it carries.
 */
function wallClock(iso: string): number {
  const match = TIMESTAMP_RX.exec(iso);
  if (!match) throw new Error(`Invalid dispatch timestamp: '${iso}'`);
  const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map((part) => Number(part ?? 0));
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

// ---------- 9. Tone ----------

const FLUFF_RX = rx(
  String.raw`\bI hope this (?:e-?mail|message|note|letter) finds you\b|\bI am writing to (?:express|apply|inquire)\b` +
    String.raw`|\bto whom it may concern\b|\bdear (?:sir|madam|hiring manager|recruiter)\b` +
    String.raw`|\b(?:thrilled|delighted|honou?red|humbled|ecstatic)\b|\b(?:super|incredibly|extremely|very) excited\b` +
    String.raw`|\bpassionate\b|\bpassion for\b|\bdelve\b|\btapestry\b|\btestament to\b` +
    String.raw`|\bin today's (?:fast-paced|digital|ever-changing|competitive)\b` +
    String.raw`|\bcutting[- ]edge\b|\bgame[- ]chang\w+|\bsynerg\w+|\bworld[- ]class\b|\bbest[- ]in[- ]class\b` +
    String.raw`|\bstate[- ]of[- ]the[- ]art\b|\brock ?star\b|\bninja\b|\bguru\b` +
    String.raw`|\bresults?[- ]driven\b|\bdetail[- ]oriented\b|\bteam player\b|\bself[- ]starter\b` +
    String.raw`|\bhighly motivated\b|\bgo-getter\b|\bproven track record\b|\bwealth of experience\b` +
    String.raw`|\bhit the ground running\b|\bthink outside the box\b|\bperfect (?:fit|match|candidate)\b` +
    String.raw`|\bideal candidate\b|\bdream (?:job|role|company)\b|\besteemed\b|\bprestigious\b` +
    String.raw`|\bgroundbreaking\b|\brevolutioni[sz]\w+|\bunparalleled\b|\bseamless(?:ly)?\b|\bspearhead\w*` +
    String.raw`|\bleverag\w+|\bunlock\w*|\bI am confident that\b`,
  "gi",
);
const EMOJI_RX = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

/** Rule 9 for one piece of text: the filler, exclamation marks and emoji in it. Empty when it reads plainly. */
export function toneProblems(text: string): string[] {
  const phrases = new Set(Array.from(text.matchAll(FLUFF_RX), ([phrase]) => phrase.toLowerCase()));
  const problems = [...phrases].sort().map((phrase) => `filler or cliché: '${phrase}'`);
  if (text.split("!").length - 1 > 1) problems.push("more than one exclamation mark");
  if (EMOJI_RX.test(text)) problems.push("contains emoji");
  return problems;
}

function checkTone(draft: ApplicationDraft, prose: readonly ProseField[], policy: CopConfig): Violation[] {
  const rule = CopRule.TONE;
  const violations: Violation[] = [];
  for (const { name, text, rewritable } of prose) {
    for (const problem of toneProblems(text)) violations.push(violation(rule, name, problem, rewritable));
  }
  const count = words(draft.pitch).length;
  if (count > policy.max_pitch_words) {
    violations.push(violation(
      rule, "pitch", `pitch runs ${count} words; keep it under ${policy.max_pitch_words}`, true,
    ));
  }
  return violations;
}

// ---------- Gatekeeper ----------

export interface CopInspectorOptions {
  policy?: CopConfig;
  compensation?: CompensationConfig;
  linkChecker?: LinkChecker;
  rewriter?: Rewriter;
  clock?: () => Date;
  /** Answers the user has already given; a remembered answer is theirs, not a guess. */
  standingAnswer?: StandingAnswer;
  /** Independent check of an attestation; without one, every attestation is held for the user. */
  verifyAnswer?: AnswerVerifier;
  /** Confidence `verifyAnswer` must reach for an answer to count as supported (default 0.85). */
  answerConfidence?: number;
  /**
   * Free text the candidate has written about themselves (their screening notes). Figures in
   * it may be quoted in the pitch and in prose answers; it adds no technologies or employers.
   */
  extraFacts?: string;
}

/** Answers already put to the verifier during one inspection, so a rewrite pass does not pay twice. */
type Verdicts = Map<string, boolean>;

/** Runs the nine invariants, auto-fixes what a rewrite can repair, quarantines the rest. */
export class CopInspector {
  private readonly policy: CopConfig;
  private readonly compensation: CompensationConfig;
  private readonly linkChecker: LinkChecker;
  private readonly rewriter: Rewriter | undefined;
  private readonly clock: () => Date;
  private readonly standingAnswer: StandingAnswer | undefined;
  private readonly verifyAnswer: AnswerVerifier | undefined;
  private readonly answerConfidence: number;
  private readonly extraFacts: string;

  constructor(
    private readonly repo: Repository,
    options: CopInspectorOptions = {},
  ) {
    this.policy = options.policy ?? defaultConfig().cop;
    this.compensation = options.compensation ?? defaultConfig().compensation;
    if (options.linkChecker) {
      this.linkChecker = options.linkChecker;
    } else {
      const http = new HttpLinkChecker();
      this.linkChecker = (url) => http.check(url);
    }
    this.rewriter = options.rewriter;
    this.clock = options.clock ?? (() => new Date());
    this.standingAnswer = options.standingAnswer;
    this.verifyAnswer = options.verifyAnswer;
    this.answerConfidence = options.answerConfidence ?? 0.85;
    this.extraFacts = options.extraFacts ?? "";
  }

  /**
   * All nine checks, in rule order. Nothing is rewritten or quarantined; the only calls
   * out are to the link checker (verified links) and the answer verifier (attestations).
   */
  async runChecks(draft: ApplicationDraft, job: JobOpportunity, profile: CandidateProfile): Promise<Violation[]> {
    return this.check(draft, job, profile, new Map());
  }

  private async check(
    draft: ApplicationDraft,
    job: JobOpportunity,
    profile: CandidateProfile,
    verdicts: Verdicts,
  ): Promise<Violation[]> {
    const judged = draft.screeningAnswers.map((item) => judgeAnswer(item, draft, job, profile, this.standingAnswer));
    const prose = proseFields(draft, judged);
    const rewritable = new Set<string>(prose.filter((field) => field.rewritable).map((field) => field.name));
    const verify = this.verifyAnswer;
    const isSupported = verify && ((item: ScreeningAnswer) => this.isSupported(item, verify, verdicts));
    return [
      ...checkFactGrounding(draft, job, profile, prose, this.extraFacts),
      ...(await checkScreeningAnswers(draft, profile, judged, isSupported)),
      ...(await checkLinks(draft, profile, rewritable, this.linkChecker)),
      ...checkAssets(draft, profile, rewritable, this.policy),
      ...checkCommitments(profile, prose),
      ...checkRates(draft, this.compensation),
      ...checkScamSignals(draft, job),
      ...this.checkDuplicates(draft, job),
      ...checkTone(draft, prose, this.policy),
    ];
  }

  /** Whether the verifier backs this answer with enough confidence. Anything short of a clear yes is a no. */
  private async isSupported(item: ScreeningAnswer, verify: AnswerVerifier, verdicts: Verdicts): Promise<boolean> {
    const key = JSON.stringify([item.question, item.answer, item.options]);
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    let supported = false;
    try {
      const verdict = await verify(item.question, item.answer, [...item.options]);
      supported =
        verdict?.supported === true &&
        typeof verdict.confidence === "number" &&
        verdict.confidence >= this.answerConfidence;
    } catch (error) {
      // The spend cap must stop the whole run; any other failure just means "not verified".
      if (error instanceof CircuitBreakerError) throw error;
    }
    verdicts.set(key, supported);
    return supported;
  }

  /**
   * Gate `draft` before dispatch.
   *
   * Greenlit drafts are returned (possibly rewritten) for dispatch. Otherwise the
   * draft is written to `quarantined_items` — one row per violated rule — and
   * its job is marked quarantined. Non-fixable violations quarantine immediately,
   * without spending a rewrite. The caller's draft is never modified.
   */
  async inspectApplicationDraft(
    draft: ApplicationDraft,
    job: JobOpportunity,
    profile: CandidateProfile,
  ): Promise<InspectionResult> {
    const verdicts: Verdicts = new Map();
    let current = draft;
    let retries = 0;
    let violations = await this.check(current, job, profile, verdicts);
    while (
      violations.length > 0 &&
      this.rewriter &&
      retries < this.policy.max_autofix_retries &&
      violations.every((flaw) => flaw.fixable)
    ) {
      current = await this.autoFix(current, violations, this.rewriter);
      retries += 1;
      violations = await this.check(current, job, profile, verdicts);
    }
    if (violations.length === 0) {
      return { verdict: Verdict.GREENLIT, draft: current, violations, retries, quarantineIds: [], passed: true };
    }

    const critiques = new Map<CopRule, string[]>();
    for (const flaw of violations) {
      const messages = critiques.get(flaw.rule) ?? [];
      messages.push(`[${flaw.field}] ${flaw.message}`);
      critiques.set(flaw.rule, messages);
    }
    const originalContent = JSON.stringify(current);
    const quarantineIds = this.repo.quarantine(
      Array.from(critiques, ([rule, messages]) => ({
        jobId: job.id, violationRule: rule, originalContent, critique: messages.join("; "), retryCount: retries,
      })),
    );
    return { verdict: Verdict.QUARANTINED, draft: current, violations, retries, quarantineIds, passed: false };
  }

  /** Log a sent draft so the 30-day de-duplication guard can see it. */
  recordDispatch(draft: ApplicationDraft, job: JobOpportunity): void {
    this.repo.recordDispatch({
      jobId: job.id, channel: draft.channel, ...dedupKeys(draft, job), dispatchedAt: toIso(this.clock()),
    });
  }

  private checkDuplicates(draft: ApplicationDraft, job: JobOpportunity): Violation[] {
    const windowMs = this.policy.dedup_window_days * DAY_MS;
    const since = new Date(this.clock().getTime() - windowMs);
    const previous = this.repo.lastDispatch(toIso(since), dedupKeys(draft, job));
    if (!previous) return [];
    const sent = wallClock(previous.dispatchedAt);
    return [violation(
      CopRule.DEDUPLICATION, "job",
      `${job.company} was already contacted on ${isoDate(sent)} (job ${previous.jobId});` +
        ` next contact allowed from ${isoDate(sent + windowMs)}`,
    )];
  }

  /** Rewrite each flawed field once, passing the rewriter that field's critiques. */
  private async autoFix(draft: ApplicationDraft, violations: Violation[], rewriter: Rewriter): Promise<ApplicationDraft> {
    const critiques = new Map<string, string[]>();
    for (const flaw of violations) {
      const messages = critiques.get(flaw.field) ?? [];
      messages.push(flaw.message);
      critiques.set(flaw.field, messages);
    }
    const texts = new Map<string, string>(allFields(draft));
    let revisedDraft = draft;
    for (const [name, messages] of critiques) {
      const text = texts.get(name);
      if (text === undefined) continue;
      let revised: string;
      try {
        revised = strip(await rewriter(text, messages));
      } catch (error) {
        // The spend cap must stop the whole run, not be mistaken for one bad rewrite.
        if (error instanceof CircuitBreakerError) throw error;
        continue; // a failed rewrite leaves the flaw in place; it counts as a spent retry
      }
      if (revised) revisedDraft = withText(revisedDraft, name, revised);
    }
    return revisedDraft;
  }
}

/**
 * Auto-fix rewriter backed by Fireworks, constrained to the verified fact bank.
 *
 * `client` is typed by shape, so anything that can generate text (the Fireworks client,
 * a test double) fits without this module depending on it.
 */
export function fireworksRewriter(
  client: { generate(prompt: string, options: { taskType: string; system?: string }): Promise<{ text: string }> },
  profile: CandidateProfile,
): Rewriter {
  const facts = verifiedAchievements(profile)
    .map((a) => `- ${a.headline}: ${a.impactMetric} [${a.technologies.join(", ")}]`)
    .join("\n");
  const system =
    "You edit job-application text for a senior software engineer. Fix only the listed problems." +
    " Never introduce a number, technology, employer, link, rate or availability that is not in" +
    " the verified facts. Write plainly, engineer to engineer, with no flattery or filler." +
    " Return only the revised text.";

  return async (text, critiques) => {
    const problems = critiques.map((critique) => `- ${critique}`).join("\n");
    const prompt = `Verified facts:\n${facts || "- (none)"}\n\nProblems to fix:\n${problems}\n\nText:\n${text}`;
    return (await client.generate(prompt, { taskType: "cop_autofix", system })).text;
  };
}
