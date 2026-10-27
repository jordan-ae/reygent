/**
 * Job discovery. No network: every test injects a `fetchJson` backed by the fixtures in
 * tests/fixtures/discovery, which are trimmed copies of real provider responses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { type DiscoveryConfig, defaultConfig } from "@/core/config";
import {
  type DiscoveryState,
  type FetchJson,
  type FetchText,
  type FoundBoard,
  BOARDS_KEY,
  FetchError,
  READS_KEY,
  boardLinks,
  createFetchJson,
  createHttpClient,
  createMemoryState,
  discover,
  fetchAshby,
  fetchBreezy,
  fetchFeed,
  fetchGreenhouse,
  fetchHimalayas,
  fetchHnFreelance,
  fetchHnWhoIsHiring,
  fetchJobicy,
  fetchLever,
  fetchRecruitee,
  fetchRemoteOk,
  fetchRemotive,
  fetchTeamtailor,
  fetchWorkable,
  fetchWorkingNomads,
} from "@/core/discovery";
import { ashbyUrl } from "@/core/discovery/ashby";
import { breezyUrl } from "@/core/discovery/breezy";
import { boardTokens, createBoardFinder, createEmployerLookup, describesSameRole } from "@/core/discovery/employer";
import { feedUrl } from "@/core/discovery/feeds";
import { greenhouseUrl } from "@/core/discovery/greenhouse";
import { himalayasUrl } from "@/core/discovery/himalayas";
import { hnCommentsUrl, hnFirstLine, hnFreelanceThreadsUrl, hnThreadsUrl, parseHnGig, parseHnListing } from "@/core/discovery/hn";
import { jobicyUrl } from "@/core/discovery/jobicy";
import { leverUrl } from "@/core/discovery/lever";
import { recruiteeUrl } from "@/core/discovery/recruitee";
import { remoteOkUrl } from "@/core/discovery/remoteok";
import { remotiveUrl } from "@/core/discovery/remotive";
import { teamtailorUrl } from "@/core/discovery/teamtailor";
import { workableUrl } from "@/core/discovery/workable";
import { workingNomadsUrl } from "@/core/discovery/workingnomads";
import { type JobOpportunity, Channel, PipelineStage, createJob, jobId, sentByHand } from "@/core/models";
import { evaluateRemoteEligibility } from "@/core/qualification/eligibility";

const FIXTURES = fileURLToPath(new URL("./fixtures/discovery/", import.meta.url));

/** An RSS or XML fixture, as the text the feed served. */
function feedFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function fixture<T = unknown>(name: string): T {
  return JSON.parse(feedFixture(name)) as T;
}

interface Listing {
  [field: string]: unknown;
}
interface Board {
  jobs: Listing[];
}
interface AlgoliaPage {
  hits: Listing[];
  nbPages: number;
}

/** The October 2026 "Who is hiring?" thread the HN fixtures come from. */
const THREAD_ID = "49922569";
/** The freelancer threads of October, September (the one people answered) and June 2026. */
const FREELANCE_THREAD_ID = "49922572";
const FREELANCE_SEPTEMBER_ID = "49522905";
const FREELANCE_JUNE_ID = "48358236";
/** An Algolia page with nothing on it. */
const NO_HITS = { hits: [], nbPages: 0 };

/** Every fixture, keyed by the URL the source would request. A feed's value is its text. */
function routes(overrides: Record<string, unknown> = {}): Map<string, unknown> {
  return new Map<string, unknown>(
    Object.entries({
      [greenhouseUrl("gitlab")]: fixture("greenhouse_gitlab.json"),
      [greenhouseUrl("mongodb")]: fixture("greenhouse_mongodb.json"),
      [greenhouseUrl("sourcegraph91")]: fixture("greenhouse_sourcegraph91.json"),
      [ashbyUrl("posthog")]: fixture("ashby_posthog.json"),
      [ashbyUrl("ramp")]: fixture("ashby_ramp.json"),
      [ashbyUrl("openai")]: fixture("ashby_openai.json"),
      [ashbyUrl("mastra")]: fixture("ashby_mastra.json"),
      [ashbyUrl("supabase")]: fixture("ashby_supabase.json"),
      [leverUrl("metabase")]: fixture("lever_metabase.json"),
      [leverUrl("zoox")]: fixture("lever_zoox.json"),
      [workableUrl("huggingface")]: fixture("workable_huggingface.json"),
      [recruiteeUrl("tether")]: fixture("recruitee_tether.json"),
      [teamtailorUrl("axmed")]: feedFixture("teamtailor_axmed.xml"),
      [breezyUrl("abstractgroup")]: fixture("breezy_abstractgroup.json"),
      [hnThreadsUrl()]: fixture("hn_stories.json"),
      [hnCommentsUrl(THREAD_ID, 0, 100)]: fixture("hn_comments_page0.json"),
      [hnCommentsUrl(THREAD_ID, 1, 100)]: fixture("hn_comments_page1.json"),
      [hnFreelanceThreadsUrl()]: fixture("hn_freelance_stories.json"),
      [hnCommentsUrl(FREELANCE_JUNE_ID, 0, 100)]: fixture("hn_freelance_comments.json"),
      [remotiveUrl()]: fixture("remotive.json"),
      [remoteOkUrl()]: fixture("remoteok.json"),
      [jobicyUrl()]: fixture("jobicy_page1.json"),
      [jobicyUrl(fixture<{ nextCursor: string }>("jobicy_page1.json").nextCursor)]: fixture("jobicy_page2.json"),
      [himalayasUrl(1)]: fixture("himalayas_page1.json"),
      [himalayasUrl(2)]: fixture("himalayas_page2.json"),
      [workingNomadsUrl()]: fixture("workingnomads.json"),
      [feedUrl("weworkremotely")]: feedFixture("weworkremotely.xml"),
      [feedUrl("realworkfromanywhere")]: feedFixture("realworkfromanywhere.xml"),
      [feedUrl("golangprojects")]: feedFixture("golangprojects.xml"),
      [feedUrl("python_org")]: feedFixture("python_org.xml"),
      ...overrides,
    }),
  );
}

/** Fetchers that serve `table` and answer 404 for anything else, as the providers do. */
function fakeFetch(table: Map<string, unknown> = routes()): { fetchJson: FetchJson; fetchText: FetchText; calls: string[] } {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    if (!table.has(url)) throw new FetchError(404, url, "Not Found");
    return structuredClone(table.get(url));
  };
  return { fetchJson, fetchText: async (url) => String(await fetchJson(url)), calls };
}

/** Serve one payload whatever the URL. */
const serving = (payload: unknown): FetchJson => async () => structuredClone(payload);
/** Serve one feed whatever the URL. */
const servingText = (body: string): FetchText => async () => body;

/** A discovery config with every source off unless switched on. */
function config(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    ...defaultConfig().discovery,
    greenhouse_boards: [],
    ashby_orgs: [],
    lever_companies: [],
    workable_accounts: [],
    recruitee_companies: [],
    teamtailor_companies: [],
    breezy_companies: [],
    job_boards: [],
    hn_who_is_hiring: false,
    hn_freelancer: false,
    follow_board_links: false,
    ...overrides,
  };
}

/** What a job states, without its description: the fields a mapping test compares. */
const stated = ({ description: _description, ...rest }: JobOpportunity): Omit<JobOpportunity, "description"> => rest;

const byTitle = (jobs: JobOpportunity[], title: string): JobOpportunity => {
  const job = jobs.find((candidate) => candidate.title === title);
  if (!job) throw new Error(`no job titled ${title}`);
  return job;
};

// ---------- Greenhouse ----------

describe("fetchGreenhouse", () => {
  test("maps every field of a listing", async () => {
    const board = fixture<Board>("greenhouse_gitlab.json");
    const jobs = await fetchGreenhouse("gitlab", fakeFetch().fetchJson);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      id: jobId("greenhouse", "gitlab:8704363002"),
      source: "greenhouse",
      sourceId: "gitlab:8704363002",
      company: "GitLab",
      title: "Backend Engineer (Python),AI Engineering: Agent Foundations",
      location: "Remote, Canada; Remote, Poland; Remote, United Kingdom",
      // Passed through exactly as served: entity-escaped HTML, which the scorer decodes.
      description: board.jobs[0].content,
      applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8704363002",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: null,
      employmentType: "",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-08-19T13:38:27.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(jobs[0].description).toContain("&lt;p&gt;");
  });

  test("never guesses remote from the location wording", async () => {
    const jobs = await fetchGreenhouse("sourcegraph91", fakeFetch().fetchJson);
    // The board exposes no custom fields at all (metadata: null).
    expect(jobs.map((job) => [job.location, job.isRemote])).toEqual([
      ["Remote", null],
      ["Remote", null],
    ]);
  });

  test("reads the employment type from the employer's custom field, and nothing else from it", async () => {
    const jobs = await fetchGreenhouse("mongodb", fakeFetch().fetchJson);

    expect(byTitle(jobs, "Contract Sourcer").employmentType).toBe("contract");
    const engineer = byTitle(jobs, "Senior Software Engineer, Cluster Scalability");
    expect(engineer.employmentType).toBe("full_time");
    // This board links to the employer's own careers site.
    expect(engineer.applyUrl).toBe("https://www.mongodb.com/careers/job/?gh_jid=8221182");
    // Its custom fields carry salary budgets, but with no stated period: not structured pay.
    expect([engineer.compMin, engineer.compMax, engineer.compPeriod]).toEqual([null, null, ""]);
  });

  test("skips a malformed listing but fails when no listing can be read", async () => {
    const board = fixture<Board>("greenhouse_gitlab.json");
    const oneBroken = { ...board, jobs: [{ id: 1, absolute_url: "https://example.test/1" }, ...board.jobs.slice(1)] };
    expect(await fetchGreenhouse("gitlab", serving(oneBroken))).toHaveLength(2);

    const allBroken = { jobs: [{ nothing: "useful" }, { id: 2 }] };
    await expect(fetchGreenhouse("gitlab", serving(allBroken))).rejects.toThrow(
      "none of the 2 listings matched the expected shape",
    );
    await expect(fetchGreenhouse("gitlab", serving({ error: "Job not found" }))).rejects.toThrow(
      "unexpected response shape (jobs:",
    );
  });

  test("an empty board is not an error", async () => {
    expect(await fetchGreenhouse("remotecom", serving({ jobs: [], meta: { total: 0 } }))).toEqual([]);
  });
});

// ---------- Ashby ----------

describe("fetchAshby", () => {
  test("maps every field of a listing", async () => {
    const board = fixture<Board>("ashby_ramp.json");
    const jobs = await fetchAshby("ramp", fakeFetch().fetchJson);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      id: jobId("ashby", "ramp:d1183b00-6590-4fe4-a585-28d84e578fe3"),
      source: "ashby",
      sourceId: "ramp:d1183b00-6590-4fe4-a585-28d84e578fe3",
      // The payload does not name the company; it comes from the slug.
      company: "Ramp",
      title: "Software Engineer, Security, Stablecoin",
      location: "New York, NY (HQ); San Francisco, CA; Remote (US)",
      description: board.jobs[0].descriptionHtml,
      applyUrl: "https://jobs.ashbyhq.com/ramp/d1183b00-6590-4fe4-a585-28d84e578fe3/application",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: 189000,
      compMax: 330000,
      compPeriod: "year",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-05-13T20:28:09.574Z",
      stage: PipelineStage.DISCOVERED,
    });
  });

  test("takes remote from the workplace type, not from isRemote", async () => {
    const jobs = await fetchAshby("ramp", fakeFetch().fetchJson);

    // "Hybrid" comes with isRemote: true in the payload. It is neither remote nor on-site,
    // so the flag stays null and the location wording is left for the scorer.
    const hybrid = byTitle(jobs, "Software Engineer, Frontend");
    expect(hybrid.isRemote).toBeNull();
    expect(hybrid.location).toBe("New York, NY (HQ); Remote (Canada); San Francisco, CA; Remote (US); Miami, FL");

    const onSite = byTitle(jobs, "IT Site Specialist");
    expect(onSite.isRemote).toBe(false);
    // "Temporary" is not one of Reygent's employment types.
    expect(onSite.employmentType).toBe("");

    const posthog = await fetchAshby("posthog", fakeFetch().fetchJson);
    expect(posthog.map((job) => [job.company, job.location, job.isRemote])).toEqual([
      ["Posthog", "Remote", true],
      ["Posthog", "Remote (EMEA)", true],
    ]);
  });

  test("leaves remote unknown when the board states no workplace type", async () => {
    const jobs = await fetchAshby("openai", fakeFetch().fetchJson);
    expect(byTitle(jobs, "Software Engineer, Data Infrastructure").isRemote).toBeNull();
  });

  test("falls back to isRemote only when there is no workplace type", async () => {
    const board = fixture<Board>("ashby_posthog.json");
    const [first, second] = board.jobs;
    const older = { jobs: [{ ...first, workplaceType: null, isRemote: true }, { ...second, workplaceType: null, isRemote: false }] };
    expect((await fetchAshby("posthog", serving(older))).map((job) => job.isRemote)).toEqual([true, false]);
  });

  test("maps structured compensation and contract work", async () => {
    const contract = byTitle(await fetchAshby("openai", fakeFetch().fetchJson), "Recruiting Coordinator - Contract");
    expect(contract).toMatchObject({
      employmentType: "contract",
      compMin: 57,
      compMax: 70,
      compPeriod: "hour",
      compCurrency: "USD",
    });

    // PostHog publishes no pay range: nothing is filled in.
    const [posthog] = await fetchAshby("posthog", fakeFetch().fetchJson);
    expect(posthog).toMatchObject({ compMin: null, compMax: null, compPeriod: "", compCurrency: "USD" });
  });

  test("ignores compensation it cannot represent", async () => {
    const board = fixture<Board>("ashby_ramp.json");
    const withSalary = (salary: Record<string, unknown>): Board => ({
      jobs: [{ ...board.jobs[0], compensation: { summaryComponents: [{ compensationType: "Salary", ...salary }], compensationTiers: [] } }],
    });
    const mapped = async (salary: Record<string, unknown>) => {
      const [job] = await fetchAshby("ramp", serving(withSalary(salary)));
      return [job.compMin, job.compMax, job.compPeriod, job.compCurrency];
    };

    expect(await mapped({ interval: "1 MONTH", currencyCode: "eur", minValue: 6000, maxValue: null })).toEqual([6000, null, "month", "EUR"]);
    // A weekly rate has no period in the model; a range without a currency is not comparable.
    expect(await mapped({ interval: "1 WEEK", currencyCode: "USD", minValue: 2000, maxValue: 3000 })).toEqual([null, null, "", "USD"]);
    expect(await mapped({ interval: "1 YEAR", currencyCode: null, minValue: 100000, maxValue: 120000 })).toEqual([null, null, "", "USD"]);
    // Zero is the provider's placeholder for "not set".
    expect(await mapped({ interval: "1 YEAR", currencyCode: "USD", minValue: 0, maxValue: 0 })).toEqual([null, null, "", "USD"]);
  });

  test("skips postings the employer has unlisted", async () => {
    const board = fixture<Board>("ashby_posthog.json");
    const jobs = await fetchAshby("posthog", serving({ jobs: [{ ...board.jobs[0], isListed: false }, board.jobs[1]] }));
    expect(jobs.map((job) => job.title)).toEqual(["Technical Customer Success Manager - EMEA"]);
  });
});

// ---------- Lever ----------

describe("fetchLever", () => {
  test("maps every field of a posting", async () => {
    const [job] = await fetchLever("metabase", fakeFetch().fetchJson);
    const { description, ...rest } = job;

    expect(rest).toEqual({
      id: jobId("lever", "metabase:85f454d8-e795-4978-8a2b-4b8bfa7d7c37"),
      source: "lever",
      sourceId: "metabase:85f454d8-e795-4978-8a2b-4b8bfa7d7c37",
      company: "Metabase",
      title: "Software Engineer (Backend)",
      location: "Global Remote",
      applyUrl: "https://jobs.lever.co/metabase/85f454d8-e795-4978-8a2b-4b8bfa7d7c37/apply",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      // The closing section quotes "$110K–$210K annually" in prose; only structured pay is mapped.
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2020-05-19T21:19:18.802Z",
      stage: PipelineStage.DISCOVERED,
    });
  });

  test("joins the opening, the requirement lists and the closing section into the description", async () => {
    const [posting] = fixture<Listing[]>("lever_metabase.json");
    const [job] = await fetchLever("metabase", fakeFetch().fetchJson);

    expect(job.description.startsWith(posting.description as string)).toBe(true);
    expect(job.description).toContain("<h3>About You</h3><ul>");
    expect(job.description).toContain("Experience in Clojure");
    expect(job.description).toContain(posting.additional as string);
  });

  test("maps the workplace type, the commitment and the salary range", async () => {
    const zoox = await fetchLever("zoox", fakeFetch().fetchJson);
    expect(zoox.map((job) => [job.isRemote, job.employmentType, job.compMin, job.compMax, job.compPeriod])).toEqual([
      // hybrid, "Contract", no range
      [null, "contract", null, null, ""],
      // onsite, no commitment given, yearly salary
      [false, "", 138000, 192000, "year"],
      // onsite, "Full-time", hourly wage
      [false, "full_time", 66, 84, "hour"],
    ]);

    const success = byTitle(await fetchLever("metabase", fakeFetch().fetchJson), "Success Engineer (Global)");
    expect(success).toMatchObject({ isRemote: true, compMin: 90000, compMax: 190000, compPeriod: "year", compCurrency: "USD" });
  });

  test("rejects a response that is not a list of postings", async () => {
    await expect(fetchLever("plaid", serving({ ok: false, error: "Document not found" }))).rejects.toThrow(
      "unexpected response shape (response:",
    );
    expect(await fetchLever("mistral", serving([]))).toEqual([]);
  });
});

// ---------- Hacker News ----------

describe("fetchHnWhoIsHiring", () => {
  test("finds the hiring thread and pages through its top-level comments", async () => {
    const { fetchJson, calls } = fakeFetch();
    const jobs = await fetchHnWhoIsHiring(fetchJson);

    expect(calls).toEqual([hnThreadsUrl(), hnCommentsUrl(THREAD_ID, 0, 100), hnCommentsUrl(THREAD_ID, 1, 100)]);
    expect(jobs.map((job) => [job.sourceId, job.company, job.title])).toEqual([
      ["50033036", "Chronograph", "Platform Engineer"],
      ["49995549", "Mastra", "AI Engineer"],
      ["49991656", "Flowstate", "Founding Engineer"],
      ["49976350", "Comograph", "Go-To-Market (GTM) Specialist"],
      ["49975827", "Pairio", "Senior Swift Engineer"],
      ["49964448", "ALBERT", "Hiring principal and distinguished engineers to build net new products"],
      ["49962075", "Revieve Oy", "Senior Product Engineer"],
      ["49936893", "ClickHouse", "Research Scientist (all levels)"],
    ]);
  });

  test("picks the thread by title, not by position", async () => {
    const stories = fixture<AlgoliaPage>("hn_stories.json");
    // "Who wants to be hired?" is posted in the same minute and can sort first.
    const reordered = { ...stories, hits: [stories.hits[1], stories.hits[0], ...stories.hits.slice(2)] };
    const { fetchJson, calls } = fakeFetch(routes({ [hnThreadsUrl()]: reordered }));

    expect(await fetchHnWhoIsHiring(fetchJson)).toHaveLength(8);
    expect(calls[1]).toBe(hnCommentsUrl(THREAD_ID, 0, 100));
  });

  test("maps every field of a listing", async () => {
    const page = fixture<AlgoliaPage>("hn_comments_page0.json");
    const [job] = await fetchHnWhoIsHiring(fakeFetch().fetchJson);

    expect(job).toEqual({
      id: jobId("hn", "50033036"),
      source: "hn",
      sourceId: "50033036",
      company: "Chronograph",
      title: "Platform Engineer",
      location: "Remote (US)",
      // The whole comment, markup included.
      description: page.hits[0].comment_text,
      applyUrl: "https://news.ycombinator.com/item?id=50033036",
      companyDomain: "chronograph.pe",
      channel: Channel.FOUNDER_DIRECT,
      // "Remote (US)" and "$175,000 - $215,000 USD" are wording, not structured fields.
      isRemote: null,
      employmentType: "full_time",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-10T13:55:55.000Z",
      stage: PipelineStage.DISCOVERED,
    });
  });

  test("skips comments that are not parseable listings", async () => {
    const pages = [fixture<AlgoliaPage>("hn_comments_page0.json"), fixture<AlgoliaPage>("hn_comments_page1.json")];
    const firstLines = new Map(
      pages.flatMap((page) => page.hits).map((hit) => [hit.objectID as string, hnFirstLine(hit.comment_text as string)]),
    );
    const parsed = new Set((await fetchHnWhoIsHiring(fakeFetch().fetchJson)).map((job) => job.sourceId));
    const skipped = [...firstLines].filter(([id]) => !parsed.has(id)).map(([, line]) => line);

    expect(skipped).toEqual([
      // A job seeker answering the wrong thread.
      "Location: Bangalore, India (IST, UTC+5:30)",
      // Prose with no header.
      "I lead the A3 Lab at Aarhus University and are hiring a Three-year PhD in Physical AI; onsite in Aarhus, Denmark.",
      // A role, but the header never names the company.
      "Senior Python Backend Engineer | REMOTE (EMEA/APAC)",
    ]);
  });

  test("ignores replies if the top-level filter is not applied", async () => {
    const page = fixture<AlgoliaPage>("hn_comments_page0.json");
    const withReply = { ...page, nbPages: 1, hits: [{ ...page.hits[0], objectID: "50040000", parent_id: 50033036 }, ...page.hits] };
    const { fetchJson } = fakeFetch(routes({ [hnCommentsUrl(THREAD_ID, 0, 100)]: withReply }));

    const ids = (await fetchHnWhoIsHiring(fetchJson)).map((job) => job.sourceId);
    expect(ids).not.toContain("50040000");
    expect(ids).toContain("50033036");
  });

  test("honours the paging options", async () => {
    const { fetchJson, calls } = fakeFetch(routes({ [hnCommentsUrl(THREAD_ID, 0, 6)]: fixture("hn_comments_page0.json") }));
    const jobs = await fetchHnWhoIsHiring(fetchJson, { hitsPerPage: 6, maxPages: 1 });

    expect(calls).toEqual([hnThreadsUrl(), hnCommentsUrl(THREAD_ID, 0, 6)]);
    expect(jobs).toHaveLength(4);
  });

  test("fails when there is no hiring thread", async () => {
    const stories = fixture<AlgoliaPage>("hn_stories.json");
    const seekersOnly = { ...stories, hits: stories.hits.filter((hit) => !String(hit.title).includes("Who is hiring")) };
    await expect(fetchHnWhoIsHiring(serving(seekersOnly))).rejects.toThrow('no "Who is hiring?" thread');
  });
});

describe("parseHnListing", () => {
  const listingOf = async (id: string): Promise<JobOpportunity> => {
    const jobs = await fetchHnWhoIsHiring(fakeFetch().fetchJson);
    const job = jobs.find((candidate) => candidate.sourceId === id);
    if (!job) throw new Error(`comment ${id} was not parsed`);
    return job;
  };

  test("reads a header that ends at a line break rather than a paragraph", async () => {
    expect(await listingOf("49995549")).toMatchObject({
      company: "Mastra",
      title: "AI Engineer",
      location: "REMOTE (AMER or EMEA time zones)",
      employmentType: "full_time",
    });
  });

  test("reads a header separated by dashes, with the place beside the company name", async () => {
    expect(await listingOf("49991656")).toMatchObject({ company: "Flowstate", title: "Founding Engineer", location: "London, UK" });
  });

  test("keeps the location wording the scorer needs", async () => {
    expect((await listingOf("49964448")).location).toBe("REMOTE ALMOST ANYWHERE IN THE WORLD");
    expect((await listingOf("49976350")).location).toBe("Remote (Global / US/EU/Africa time zones welcome)");
  });

  test("maps contract and freelance engagements", async () => {
    // "Contract, full-time", "Employee or freelance", "Full-time / Contract"
    expect((await listingOf("49962075")).employmentType).toBe("contract");
    expect((await listingOf("49975827")).employmentType).toBe("contract");
    expect((await listingOf("49976350")).employmentType).toBe("contract");
  });

  test("reads the employment type from the header's own words", () => {
    const typeOf = (terms: string) => parseHnListing(`Acme Robotics | Staff Engineer | REMOTE | ${terms}`)?.employmentType;

    expect(typeOf("Full-time")).toBe("full_time");
    expect(typeOf("FT")).toBe("full_time");
    expect(typeOf("Fractional (2 days/week)")).toBe("fractional");
    expect(typeOf("Contract-to-hire")).toBe("contract");
    expect(typeOf("Full-time, no contractors")).toBe("full_time");
    // Part-time and internships are not among Reygent's employment types.
    expect(typeOf("Part-time")).toBe("");
    expect(typeOf("Internship")).toBe("");
  });

  test("takes the role from the body when the header names only the company", async () => {
    expect(await listingOf("49936893")).toMatchObject({
      company: "ClickHouse",
      title: "Research Scientist (all levels)",
      location: "Remote",
      companyDomain: "clickhouse.com",
    });
  });

  test("states a company domain only when the link carries the company's name", () => {
    const header = (rest: string) => parseHnListing(`Greenzie | Robotics Software Engineer | Atlanta, GA | ${rest}`);

    expect(header('<a href="https:&#x2F;&#x2F;greenzie.com&#x2F;careers">https:&#x2F;&#x2F;greenzie.com&#x2F;careers</a>')?.companyDomain).toBe("greenzie.com");
    // A hosted ATS page and a URL shortener are not the employer's domain.
    expect(header("https:&#x2F;&#x2F;greenzie.applytojob.com&#x2F;apply&#x2F;UdRcDlWSzs")?.companyDomain).toBe("");
    expect(header("https:&#x2F;&#x2F;grnh.se&#x2F;rlbk86k09us")?.companyDomain).toBe("");
    expect(header("ONSITE")).toMatchObject({ company: "Greenzie", location: "Atlanta, GA; ONSITE", companyDomain: "" });
  });

  test("returns null rather than inventing a company or a role", () => {
    // No role anywhere.
    expect(parseHnListing("vvd | Worldbuilding and storytelling platform (Remote &#x2F; EU&#x2F;NA timezones)<p>This role is for a junior dev.")).toBeNull();
    // The poster withholds the company's name.
    expect(parseHnListing("Stealth startup | Founding Engineer | REMOTE | Full-time")).toBeNull();
    // A link and nothing else.
    expect(parseHnListing('<a href="https:&#x2F;&#x2F;grnh.se&#x2F;rlbk86k09us">https:&#x2F;&#x2F;grnh.se&#x2F;rlbk86k09us</a><p>Hiring for multiple roles')).toBeNull();
    // A recruiter's header with the role first.
    expect(parseHnListing("Software Engineer — Remote — US Only<p>Kaveronix is looking for experienced Software Engineers.")).toBeNull();
    expect(parseHnListing("")).toBeNull();
  });
});

// ---------- Hacker News freelancer thread ----------

describe("fetchHnFreelance", () => {
  /** The search as it stood in June 2026, the last month a client posted: later threads trimmed away. */
  const asOfJune = () => {
    const stories = fixture<AlgoliaPage>("hn_freelance_stories.json");
    return { ...stories, hits: stories.hits.filter((hit) => /\((?:January|February|March|April|May|June) 2026\)/.test(String(hit.title))) };
  };

  test("finds the newest thread by its title, whoever posted it", async () => {
    // The whoishiring account stopped posting this thread; a member posts it now.
    const { fetchJson, calls } = fakeFetch(routes({ [hnCommentsUrl(FREELANCE_THREAD_ID, 0, 100)]: NO_HITS }));
    expect(await fetchHnFreelance(fetchJson)).toEqual([]);
    expect(calls).toEqual([hnFreelanceThreadsUrl(), hnCommentsUrl(FREELANCE_THREAD_ID, 0, 100)]);
  });

  test("of two threads posted for one month, reads the one people answered", async () => {
    const stories = fixture<AlgoliaPage>("hn_freelance_stories.json");
    // September had two: one with 24 comments, and an earlier one with 2 that sorts second here.
    const september = { ...stories, hits: [stories.hits[2], stories.hits[1], ...stories.hits.slice(3)] };
    const { fetchJson, calls } = fakeFetch(
      routes({ [hnFreelanceThreadsUrl()]: september, [hnCommentsUrl(FREELANCE_SEPTEMBER_ID, 0, 100)]: NO_HITS }),
    );

    await fetchHnFreelance(fetchJson);
    expect(calls[1]).toBe(hnCommentsUrl(FREELANCE_SEPTEMBER_ID, 0, 100));
  });

  test("keeps the clients' posts and maps every field of one", async () => {
    const page = fixture<AlgoliaPage>("hn_freelance_comments.json");
    const jobs = await fetchHnFreelance(fakeFetch(routes({ [hnFreelanceThreadsUrl()]: asOfJune() })).fetchJson);

    // Three comments on the page; the two that open "SEEKING WORK" are freelancers, not listings.
    expect(jobs).toEqual([
      {
        id: jobId("hn_freelance", "48361270"),
        source: "hn_freelance",
        sourceId: "48361270",
        // The post names no company and no role: the poster's handle and the thread's own word stand in.
        company: "fnmnlmusic (Hacker News user)",
        title: "Freelancer",
        location: "Remote (US+EU only)",
        description: page.hits[0].comment_text,
        applyUrl: "https://news.ycombinator.com/item?id=48361270",
        companyDomain: "",
        channel: Channel.CONTRACT_GIGS,
        isRemote: null,
        employmentType: "contract",
        compMin: null,
        compMax: null,
        compPeriod: "",
        compCurrency: "USD",
        skills: [],
        postedAt: "2026-06-01T19:12:37.000Z",
        stage: PipelineStage.DISCOVERED,
      },
    ]);
    // A comment is not a form: the reply is the user's to send, although the channel is not founder-direct.
    expect(sentByHand(jobs[0])).toBe(true);
    // "US+EU only" in the header is what the scorer acts on.
    expect(evaluateRemoteEligibility(jobs[0]).reasonCodes).toContain("GEO_RESTRICTED");
  });

  test("fails when no freelancer thread is among the latest stories", async () => {
    const stories = fixture<AlgoliaPage>("hn_freelance_stories.json");
    // A question about the thread mentions its title without being it.
    const onlyTheQuestion = { ...stories, hits: stories.hits.filter((hit) => String(hit.title).includes("threads gone")) };
    expect(onlyTheQuestion.hits).toHaveLength(1);
    await expect(fetchHnFreelance(serving(onlyTheQuestion))).rejects.toThrow('no "Freelancer? Seeking freelancer?" thread');
  });
});

describe("parseHnGig", () => {
  test("reads a company, a role and a place when the header gives them", () => {
    expect(parseHnGig("SEEKING FREELANCER | Acme Robotics | Senior React developer | REMOTE (Worldwide)<p>Three months, 20h a week.", "acme_cto")).toEqual({
      company: "Acme Robotics",
      title: "Senior React developer",
      location: "REMOTE (Worldwide)",
      employmentType: "contract",
      companyDomain: "",
    });
    expect(parseHnGig("SEEKING FREELANCER: Greenzie | https:&#x2F;&#x2F;greenzie.com | Atlanta, GA or remote", "x")).toMatchObject({
      company: "Greenzie", title: "Freelancer", location: "Atlanta, GA or remote", companyDomain: "greenzie.com",
    });
  });

  test("returns null for a freelancer's own post, and for a post with nobody to address", () => {
    expect(parseHnGig("SEEKING WORK | Sweden (CET) | Remote only<p>I modernise legacy services.", "someone")).toBeNull();
    expect(parseHnGig("Location: US<p>Remote: Yes", "someone")).toBeNull();
    // No company in the header and no handle on the comment.
    expect(parseHnGig("SEEKING FREELANCER | Remote", "")).toBeNull();
    expect(parseHnGig("", "someone")).toBeNull();
  });
});

// ---------- Job boards with a public API ----------

describe("fetchRemotive", () => {
  test("maps every field of a listing", async () => {
    const feed = fixture<Board>("remotive.json");
    const jobs = await fetchRemotive(fakeFetch().fetchJson);

    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toEqual({
      id: jobId("remotive", "2091045"),
      source: "remotive",
      sourceId: "2091045",
      company: "Unio Digital",
      title: "Tier III Service Desk Engineer",
      // Remotive's own wording of where the hire may be.
      location: "Worldwide",
      description: feed.jobs[0].description,
      // The listing on Remotive: its terms ask for the link back, and the application starts there.
      applyUrl: "https://remotive.com/remote-jobs/information-technology/tier-iii-service-desk-engineer-2091045",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      // "2026-10-07T01:11:09" carries no zone and is read as UTC wherever the test runs.
      postedAt: "2026-10-07T01:11:09.000Z",
      stage: PipelineStage.DISCOVERED,
    });
  });

  test("passes the region through as written and sends contract work to the gigs channel", async () => {
    const jobs = await fetchRemotive(fakeFetch().fetchJson);
    expect(jobs.map((job) => [job.title, job.location, job.employmentType, job.channel])).toEqual([
      ["Tier III Service Desk Engineer", "Worldwide", "full_time", Channel.ATS_INBOUND],
      ["Senior React Full-stack Developer", "Europe, USA, Canada, APAC", "full_time", Channel.ATS_INBOUND],
      ["Senior Shopify Developer", "Worldwide", "contract", Channel.CONTRACT_GIGS],
      // "freelance" is contract work too.
      ["Freelance Writer", "Worldwide", "contract", Channel.CONTRACT_GIGS],
    ]);
    // Free-text pay ("OTE $25k - $35k") is never turned into numbers.
    expect(jobs.every((job) => job.compMin === null && job.compMax === null)).toBe(true);
  });

  test("rejects a response that is not the feed", async () => {
    await expect(fetchRemotive(serving({ error: "Too many requests" }))).rejects.toThrow("unexpected response shape (jobs:");
    await expect(fetchRemotive(serving({ jobs: [{ id: 1, title: "No company" }] }))).rejects.toThrow("none of the 1 listings matched the expected shape");
    expect(await fetchRemotive(serving({ jobs: [] }))).toEqual([]);
  });
});

describe("fetchRemoteOk", () => {
  test("skips the terms entry and maps every field of a listing", async () => {
    const feed = fixture<Listing[]>("remoteok.json");
    // The first element of the array is the API's terms, not a job.
    expect(feed[0]).toHaveProperty("legal");
    const jobs = await fetchRemoteOk(fakeFetch().fetchJson);

    expect(jobs).toHaveLength(feed.length - 1);
    expect(jobs[0]).toEqual({
      id: jobId("remoteok", "1137475"),
      source: "remoteok",
      sourceId: "1137475",
      company: "Lemon.io",
      title: "Senior React Full stack Developer",
      // The poster gave no location; "remote" alone is the flag below, not a place.
      location: "",
      description: feed[1].description,
      applyUrl: "https://remoteOK.com/remote-jobs/remote-senior-react-full-stack-developer-lemon-io-1137475",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "",
      // salary_min / salary_max come with no currency and no period.
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-09T13:09:18.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(byTitle(jobs, "Project Manager").location).toBe("Worldwide");
  });

  test("fails when nothing in the feed is a listing", async () => {
    const [terms] = fixture<Listing[]>("remoteok.json");
    await expect(fetchRemoteOk(serving([terms]))).rejects.toThrow("none of the 1 listings matched the expected shape");
    await expect(fetchRemoteOk(serving({ message: "blocked" }))).rejects.toThrow("unexpected response shape (response:");
  });
});

describe("fetchJobicy", () => {
  const firstPage = () => fixture<{ nextCursor: string; jobs: Listing[] }>("jobicy_page1.json");

  test("follows the cursor from page to page, up to the bound", async () => {
    const { fetchJson, calls } = fakeFetch();
    const jobs = await fetchJobicy(fetchJson, { maxPages: 2 });

    expect(calls).toEqual([jobicyUrl(), jobicyUrl(firstPage().nextCursor)]);
    expect(jobs.map((job) => job.sourceId)).toEqual(["155112", "155104", "155122", "155090", "150352", "145652"]);
  });

  test("stops when the feed says there is no more", async () => {
    const { fetchJson, calls } = fakeFetch(routes({ [jobicyUrl()]: { ...firstPage(), nextCursor: null, hasMore: false } }));
    expect(await fetchJobicy(fetchJson)).toHaveLength(4);
    expect(calls).toEqual([jobicyUrl()]);
  });

  test("maps every field of a listing, with its structured pay", async () => {
    const jobs = await fetchJobicy(fakeFetch().fetchJson, { maxPages: 1 });
    expect(stated(byTitle(jobs, "Applied Scientist, Pro Growth"))).toEqual({
      id: jobId("jobicy", "155122"),
      source: "jobicy",
      sourceId: "155122",
      company: "Thumbtack",
      title: "Applied Scientist, Pro Growth",
      location: "Canada",
      applyUrl: "https://jobicy.com/jobs/155122-applied-scientist-pro-growth",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: 161500,
      compMax: 209000,
      compPeriod: "year",
      compCurrency: "CAD",
      skills: [],
      postedAt: "2026-10-12T12:37:19.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(byTitle(jobs, "Content Lead").location).toBe("Anywhere");
    expect(byTitle(jobs, "Senior Accountant (6-Month Contract)")).toMatchObject({ employmentType: "contract", channel: Channel.CONTRACT_GIGS });
  });

  test("tidies the region's spacing and decodes escaped titles, and nothing else", async () => {
    const page = firstPage();
    const odd = { ...page, nextCursor: null, jobs: [{ ...page.jobs[0], jobGeo: "EMEA,  UK", jobTitle: "R&amp;D Engineer", salaryMin: 50, salaryMax: 80, salaryCurrency: "usd", salaryPeriod: "weekly" }] };
    const [job] = await fetchJobicy(serving(odd));
    expect([job.location, job.title]).toEqual(["EMEA, UK", "R&D Engineer"]);
    // A weekly rate has no period in the model.
    expect([job.compMin, job.compMax, job.compPeriod]).toEqual([null, null, ""]);
  });

  test("a page that fails is reported, not half-read", async () => {
    const table = routes();
    table.delete(jobicyUrl(firstPage().nextCursor));
    await expect(fetchJobicy(fakeFetch(table).fetchJson)).rejects.toThrow("HTTP 404");
    await expect(fetchJobicy(serving({ success: false, error: "Rate limit exceeded" }))).rejects.toThrow("unexpected response shape (jobs:");
  });
});

describe("fetchHimalayas", () => {
  test("reads the worldwide search page by page, up to the bound", async () => {
    const { fetchJson, calls } = fakeFetch();
    const jobs = await fetchHimalayas(fetchJson, { maxPages: 2 });

    expect(calls).toEqual([himalayasUrl(1), himalayasUrl(2)]);
    expect(calls[0]).toContain("worldwide=true");
    expect(jobs).toHaveLength(5);
  });

  test("stops at an empty page", async () => {
    const page = fixture<{ totalCount: number; jobs: Listing[] }>("himalayas_page1.json");
    const { fetchJson, calls } = fakeFetch(routes({ [himalayasUrl(2)]: { ...page, jobs: [] } }));
    expect(await fetchHimalayas(fetchJson)).toHaveLength(3);
    expect(calls).toEqual([himalayasUrl(1), himalayasUrl(2)]);
    // ...and when everything there is has been seen.
    expect(await fetchHimalayas(serving({ ...page, totalCount: 3 }))).toHaveLength(3);
  });

  test("maps every field of a listing, with its structured pay", async () => {
    const jobs = await fetchHimalayas(fakeFetch().fetchJson, { maxPages: 1 });
    expect(stated(jobs[1])).toEqual({
      id: jobId("himalayas", "companies/xperteez-technology/jobs/qa-engineer-2d-creative-applications-remote-contract"),
      source: "himalayas",
      sourceId: "companies/xperteez-technology/jobs/qa-engineer-2d-creative-applications-remote-contract",
      company: "Xperteez Technology",
      title: "QA Engineer – 2D & Creative Applications | Remote - Contract",
      location: "Worldwide",
      applyUrl: "https://himalayas.app/companies/xperteez-technology/jobs/qa-engineer-2d-creative-applications-remote-contract",
      companyDomain: "",
      channel: Channel.CONTRACT_GIGS,
      isRemote: true,
      employmentType: "contract",
      compMin: 90,
      compMax: 175,
      compPeriod: "hour",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-12T15:18:35.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(jobs[0]).toMatchObject({ employmentType: "full_time", compMin: 60000, compMax: 90000, compPeriod: "year" });
  });

  test("says worldwide only when neither a country nor a time zone restricts the role", async () => {
    const page = fixture<{ jobs: Listing[] }>("himalayas_page1.json");
    const withRestrictions = (restrictions: Record<string, unknown>) =>
      fetchHimalayas(serving({ jobs: [{ ...page.jobs[0], ...restrictions }], totalCount: 1 })).then(([job]) => job.location);

    // As recorded: no country, and every UTC offset there is.
    expect((page.jobs[0].timezoneRestrictions as number[]).length).toBeGreaterThan(24);
    expect(await withRestrictions({})).toBe("Worldwide");
    expect(await withRestrictions({ timezoneRestrictions: [] })).toBe("Worldwide");
    expect(await withRestrictions({ locationRestrictions: ["United States", "Canada"] })).toBe("United States, Canada");
    // American hours only: not open to everyone, so it is not called worldwide.
    const american = await withRestrictions({ timezoneRestrictions: [-8, -7, -6, -5, -3.5] });
    expect(american).toBe("Time zones: UTC-8, UTC-7, UTC-6, UTC-5, UTC-3.5");
    const [job] = await fetchHimalayas(serving({ jobs: [{ ...page.jobs[0], timezoneRestrictions: [-8, -7, -6, -5] }], totalCount: 1 }));
    expect(evaluateRemoteEligibility(job).tier).toBe("potentially_eligible");
  });

  test("rejects a response that is not a page of listings", async () => {
    await expect(fetchHimalayas(serving({ message: "Too Many Requests" }))).rejects.toThrow("unexpected response shape (jobs:");
  });
});

describe("fetchWorkingNomads", () => {
  test("maps every field of a listing", async () => {
    const feed = fixture<Listing[]>("workingnomads.json");
    const jobs = await fetchWorkingNomads(fakeFetch().fetchJson);

    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toEqual({
      id: jobId("workingnomads", "1925654"),
      source: "workingnomads",
      // The number in the link; the payload carries no other id.
      sourceId: "1925654",
      company: "Proxify",
      title: "Senior Backend Developer (Node.js / Nest.js)",
      location: "Time zone: CET (+/- 3 hours)",
      description: feed[0].description,
      // Working Nomads' forwarding link, kept as given and never resolved here.
      applyUrl: "https://www.workingnomads.com/job/go/1925654/",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-08T16:54:14.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(jobs.map((job) => job.location)).toEqual([
      "Time zone: CET (+/- 3 hours)", "Europe, LATAM, APAC, the U.S., Canada", "Global", "Remote, USA Only",
    ]);
  });

  test("rejects a response that is not a list", async () => {
    await expect(fetchWorkingNomads(serving({ detail: "Not found." }))).rejects.toThrow("unexpected response shape (response:");
  });
});

// ---------- Job boards with an RSS feed ----------

describe("fetchFeed", () => {
  test("We Work Remotely: splits company from title and passes the region through", async () => {
    const jobs = await fetchFeed("weworkremotely", fakeFetch().fetchText);

    expect(stated(jobs[0])).toEqual({
      id: jobId("weworkremotely", "toptal-applied-ai-engineers-for-telecommunications-company"),
      source: "weworkremotely",
      sourceId: "toptal-applied-ai-engineers-for-telecommunications-company",
      // "Toptal: Applied AI Engineers for telecommunications company"
      company: "Toptal",
      title: "Applied AI Engineers for telecommunications company",
      // The feed's <region>, verbatim: this is what rules the listing out.
      location: "USA Only",
      applyUrl: "https://weworkremotely.com/remote-jobs/toptal-applied-ai-engineers-for-telecommunications-company",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-12T16:38:01.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    // The description is HTML again once the feed's escaping is undone.
    expect(jobs[0].description).toContain("<strong>Headquarters:</strong>");
    expect(evaluateRemoteEligibility(jobs[0]).tier).toBe("ineligible");

    const contract = byTitle(jobs, "Senior Product Engineer");
    expect(contract).toMatchObject({ company: "Semaphore", employmentType: "contract", channel: Channel.CONTRACT_GIGS });
    expect(contract.location.startsWith("Anywhere in the World")).toBe(true);
    expect(evaluateRemoteEligibility(contract).tier).toBe("confirmed");
    expect(byTitle(jobs, "Fullstack Web3 Engineer (Solidity / Rust / Typescript)").location).toBe("Remote - Americas");
  });

  test("Real Work From Anywhere: takes the company from <author> and states no location", async () => {
    const jobs = await fetchFeed("realworkfromanywhere", fakeFetch().fetchText);

    expect(jobs.map((job) => [job.company, job.title])).toEqual([
      ["Supabase", "Platform Engineer, Managed Postgres"],
      ["LiveKit", "Senior Product Operations Manager"],
      ["DuckDuckGo", "Senior Frontend Engineer, React/Typescript"],
    ]);
    expect(jobs[0]).toMatchObject({
      sourceId: "platform-engineer-managed-postgres-supabase-3762",
      // The feed gives no place. The board's name is not the listing's wording.
      location: "",
      isRemote: true,
      employmentType: "",
      applyUrl: "https://www.realworkfromanywhere.com/jobs/platform-engineer-managed-postgres-supabase-3762",
      postedAt: "2026-10-09T17:17:39.000Z",
    });
    expect(jobs[0].description.startsWith("<h2>")).toBe(true);
  });

  test("Golangprojects: reads the no-break-spaced title and the place that opens the description", async () => {
    // The feed writes "Title @ Company" with U+00A0 on both sides of the "@".
    expect(feedFixture("golangprojects.xml")).toContain("Engineer @ Prenosis");
    const jobs = await fetchFeed("golangprojects", fakeFetch().fetchText);

    expect(jobs.map((job) => [job.company, job.title, job.location])).toEqual([
      ["Prenosis", "Sr. Software Engineer", "Remote"],
      ["Lunar", "Data Platform Engineer", "Copenhagen, Denmark"],
      ["Form3", "Senior Software Engineer (Go) - AI Resilience & Security Enhancements (Contract)", "Remote"],
    ]);
    // Not a remote-only board, no dates and no employment type in the feed: none is made up.
    expect(jobs.map((job) => [job.isRemote, job.postedAt, job.employmentType])).toEqual([[null, null, ""], [null, null, ""], [null, null, ""]]);
    expect(jobs[0].sourceId).toBe("golang-go-job-gkb-Remote-Sr-Software-Engineer-Prenosis-remotework");
  });

  test("Python.org: splits title from company at the last comma and lifts the place off the description", async () => {
    const jobs = await fetchFeed("python_org", fakeFetch().fetchText);

    expect(jobs.map((job) => [job.company, job.title, job.location])).toEqual([
      // The poster's own spelling of "worldwide" is kept.
      ["Micro1", "ML Engineer", "Remote, Worlwide, Worldwide"],
      // "…, ActivePrime, Inc.": the comma before a legal suffix is part of the name.
      ["ActivePrime, Inc.", "SENIOR Back-End Python Engineer - FULLY REMOTE-WORLDWIDE", "REMOTE"],
      ["NordVpn/NordSecurity", "Python/DevOps Engineer", "Vilnius / Kaunas / Warsaw, Lithuania/Poland"],
    ]);
    expect(jobs[0]).toMatchObject({ sourceId: "8136", applyUrl: "https://www.python.org/jobs/8136/", isRemote: null, postedAt: null });
    expect(jobs[0].description.startsWith("<p>We are looking for")).toBe(true);
  });

  test("skips an item it cannot read, and fails when it can read none", async () => {
    const feed = feedFixture("weworkremotely.xml");
    // A title with no "Company: " in front names no company.
    const oneBroken = feed.replace("<title>Toptal: Applied AI Engineers", "<title>Applied AI Engineers");
    expect(await fetchFeed("weworkremotely", servingText(oneBroken))).toHaveLength(3);
    const allBroken = feed.replace(/<title>[^<]*: /g, "<title>");
    await expect(fetchFeed("weworkremotely", servingText(allBroken))).rejects.toThrow("none of the 4 listings matched the expected shape");
  });

  test("rejects a page that is not a feed, and a board it does not know", async () => {
    // A feed that has moved answers 200 with a web page.
    await expect(fetchFeed("realworkfromanywhere", servingText("<!doctype html><html><body>Not found</body></html>"))).rejects.toThrow(
      "unexpected response shape (not an RSS feed)",
    );
    expect(await fetchFeed("python_org", servingText('<rss version="2.0"><channel><title>Python.org Jobs Feed</title></channel></rss>'))).toEqual([]);
    await expect(fetchFeed("no-such-board", servingText(""))).rejects.toThrow("no feed is known as no-such-board");
  });
});

// ---------- More company boards ----------

describe("fetchWorkable", () => {
  test("maps every field of a listing", async () => {
    const board = fixture<Board>("workable_huggingface.json");
    const jobs = await fetchWorkable("huggingface", fakeFetch().fetchJson);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      id: jobId("workable", "huggingface:81B46579FE"),
      source: "workable",
      sourceId: "huggingface:81B46579FE",
      // The payload names the company.
      company: "Hugging Face",
      title: "Open-Source Machine Learning Engineer - EMEA Remote",
      location: "Paris, Île-de-France, France",
      description: board.jobs[0].description,
      // The application form itself.
      applyUrl: "https://apply.workable.com/j/81B46579FE/apply",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-05-29T00:00:00.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(byTitle(jobs, "Wild Card").location).toBe("United States");
  });

  test("does not read 'not telecommuting' as on-site", async () => {
    const board = fixture<Board>("workable_huggingface.json");
    const [job] = await fetchWorkable("acme", serving({ jobs: [{ ...board.jobs[0], telecommuting: false }] }));
    expect(job.isRemote).toBeNull();
    // With no name in the payload the slug stands in.
    expect(job).toMatchObject({ company: "Acme", sourceId: "acme:81B46579FE" });
  });

  test("fails on an unknown account and on a changed payload", async () => {
    await expect(fetchWorkable("no-such-account", fakeFetch().fetchJson)).rejects.toThrow(`HTTP 404 from ${workableUrl("no-such-account")}`);
    await expect(fetchWorkable("acme", serving({ name: "Acme" }))).rejects.toThrow("unexpected response shape (jobs:");
    expect(await fetchWorkable("acme", serving({ name: "Acme", jobs: [] }))).toEqual([]);
  });
});

describe("fetchRecruitee", () => {
  test("maps every field of an offer", async () => {
    const board = fixture<{ offers: Listing[] }>("recruitee_tether.json");
    const jobs = await fetchRecruitee("tether", fakeFetch().fetchJson);

    expect(jobs).toHaveLength(3);
    expect(stated(jobs[0])).toEqual({
      id: jobId("recruitee", "tether:2780406"),
      source: "recruitee",
      sourceId: "tether:2780406",
      company: "Tether Operations Limited",
      title: "Frontend Desktop Engineer (100% remote - Worldwide)",
      // The headline location, then each listed place.
      location: "Remote job; Albania, Tiranë; Andorra",
      // The employer's own careers site.
      applyUrl: "https://careers.tether.io/o/frontend-desktop-engineer-100-remote-worldwide/c/new",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "full_time",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-10-12T14:19:22.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    // The requirements are a field of their own and are part of the description.
    expect(jobs[0].description).toBe(`${board.offers[0].description}\n${board.offers[0].requirements}`);
  });

  test("maps the remote flags, the salary and the offer status", async () => {
    const { offers } = fixture<{ offers: Listing[] }>("recruitee_tether.json");
    const mapped = async (changes: Record<string, unknown>) => (await fetchRecruitee("tether", serving({ offers: [{ ...offers[0], ...changes }] })))[0];

    expect((await mapped({ remote: false, on_site: true, hybrid: false })).isRemote).toBe(false);
    // Hybrid is neither remote nor on-site.
    expect((await mapped({ remote: false, on_site: true, hybrid: true })).isRemote).toBeNull();
    expect(await mapped({ salary: { min: "5000", max: 7000, period: "month", currency: "eur" }, employment_type_code: "contract" })).toMatchObject({
      compMin: 5000, compMax: 7000, compPeriod: "month", compCurrency: "EUR", employmentType: "contract",
    });
    expect(await fetchRecruitee("tether", serving({ offers: [{ ...offers[0], status: "draft" }] }))).toEqual([]);
  });

  test("fails on an unknown company and on a changed payload", async () => {
    await expect(fetchRecruitee("no-such-company", fakeFetch().fetchJson)).rejects.toThrow(`HTTP 404 from ${recruiteeUrl("no-such-company")}`);
    await expect(fetchRecruitee("tether", serving({ error: "Not Found" }))).rejects.toThrow("unexpected response shape (offers:");
  });
});

describe("fetchTeamtailor", () => {
  test("maps every field of an opening", async () => {
    const jobs = await fetchTeamtailor("axmed", fakeFetch().fetchText);

    expect(jobs).toHaveLength(3);
    expect(stated(jobs[0])).toEqual({
      id: jobId("teamtailor", "axmed:b944e119-b43d-475f-b2bf-144a45ffd2da"),
      source: "teamtailor",
      sourceId: "axmed:b944e119-b43d-475f-b2bf-144a45ffd2da",
      // From the feed's own title.
      company: "Axmed",
      title: "AI Engineer",
      location: "Spain, Remote",
      applyUrl: "https://axmed.teamtailor.com/jobs/8175859-ai-engineer",
      companyDomain: "",
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      // The feed states no employment type and no pay.
      employmentType: "",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-08-05T15:00:15.000Z",
      stage: PipelineStage.DISCOVERED,
    });
    // The feed escapes its HTML; the description is HTML again.
    expect(jobs[0].description).toMatch(/^<[a-z0-9]+>/);
    expect(jobs[0].description).not.toContain("&lt;");
  });

  test("reads every location and the remote status as stated", async () => {
    const jobs = await fetchTeamtailor("axmed", fakeFetch().fetchText);
    // remoteStatus "none" is the employer saying on-site, whatever the location names say.
    expect(byTitle(jobs, "QMS Lead")).toMatchObject({ isRemote: false, location: "Kenya, Remote; Nigeria, Remote" });
    expect(byTitle(jobs, "Global Health Advisory - Principal").location).toBe(
      "Switzerland, Remote; Spain, Remote; Kenya, Remote; Nigeria, Remote; South Africa, Remote; United Kingdom, Remote; Accra, Remote",
    );
    const hybrid = feedFixture("teamtailor_axmed.xml").replaceAll("<remoteStatus>fully</remoteStatus>", "<remoteStatus>hybrid</remoteStatus>");
    expect((await fetchTeamtailor("axmed", servingText(hybrid)))[0].isRemote).toBeNull();
  });

  test("fails on an unknown company and on a page that is not the feed", async () => {
    await expect(fetchTeamtailor("no-such-company", fakeFetch().fetchText)).rejects.toThrow(`HTTP 404 from ${teamtailorUrl("no-such-company")}`);
    await expect(fetchTeamtailor("axmed", servingText("<html><title>Teamtailor</title></html>"))).rejects.toThrow("not an RSS feed");
  });
});

describe("fetchBreezy", () => {
  test("maps every field of a position", async () => {
    const board = fixture<Listing[]>("breezy_abstractgroup.json");
    const jobs = await fetchBreezy("abstractgroup", fakeFetch().fetchJson);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      id: jobId("breezy", "abstractgroup:ba2aa4ce4eb701"),
      source: "breezy",
      sourceId: "abstractgroup:ba2aa4ce4eb701",
      company: "Abstract",
      title: "Full Stack Web Developer ⏤ Remote Contractor",
      // The place, its country, and the employer's own remote wording.
      location: "Stuttgart, DE; Germany; Fully remote, no location restrictions",
      description: board[0].description,
      applyUrl: "https://abstractgroup.breezy.hr/p/ba2aa4ce4eb701-full-stack-web-developer-remote-contractor",
      companyDomain: "",
      // A company board's listing goes in through its form, as on the other providers.
      channel: Channel.ATS_INBOUND,
      isRemote: true,
      employmentType: "contract",
      compMin: null,
      compMax: null,
      compPeriod: "",
      compCurrency: "USD",
      skills: [],
      postedAt: "2026-07-06T13:25:10.176Z",
      stage: PipelineStage.DISCOVERED,
    });
    expect(byTitle(jobs, "Business Development")).toMatchObject({ isRemote: null, employmentType: "full_time", location: "Stuttgart, DE; Germany" });
  });

  test("asks for descriptions, and fails on an unknown portal", async () => {
    expect(breezyUrl("abstractgroup")).toBe("https://abstractgroup.breezy.hr/json?verbose=true");
    await expect(fetchBreezy("no-such-company", fakeFetch().fetchJson)).rejects.toThrow(`HTTP 404 from ${breezyUrl("no-such-company")}`);
    await expect(fetchBreezy("abstractgroup", serving({ error: "portal not found" }))).rejects.toThrow("unexpected response shape (response:");
  });
});

// ---------- Links to company boards ----------

describe("boardLinks", () => {
  test("finds the boards a hiring post links to", () => {
    const page = fixture<AlgoliaPage>("hn_comments_page0.json");
    const mastra = page.hits.find((hit) => String(hit.comment_text).startsWith("Mastra"))!;
    // Hacker News writes the link as https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;mastra&#x2F;…
    expect(String(mastra.comment_text)).toContain("jobs.ashbyhq.com&#x2F;mastra");
    expect(boardLinks(String(mastra.comment_text))).toEqual([{ provider: "ashby", token: "mastra" }]);
  });

  test("recognises each provider's own hosts", () => {
    const linked = (url: string) => boardLinks(`Apply at <a href="${url}">${url}</a>.`);

    expect(linked("https://boards.greenhouse.io/gitlab/jobs/8704363002")).toEqual([{ provider: "greenhouse", token: "gitlab" }]);
    expect(linked("https://job-boards.greenhouse.io/embed/job_app?token=1&for=coast")).toEqual([{ provider: "greenhouse", token: "coast" }]);
    expect(linked("https://jobs.ashbyhq.com/duck-duck-go")).toEqual([{ provider: "ashby", token: "duck-duck-go" }]);
    expect(linked("https://jobs.lever.co/shieldai/5a1c")).toEqual([{ provider: "lever", token: "shieldai" }]);
    expect(linked("https://apply.workable.com/modash/j/C1507B65C3")).toEqual([{ provider: "workable", token: "modash" }]);
    expect(linked("https://sumble-inc.workable.com/")).toEqual([{ provider: "workable", token: "sumble-inc" }]);
    expect(linked("https://tether.recruitee.com/o/frontend-engineer")).toEqual([{ provider: "recruitee", token: "tether" }]);
    expect(linked("https://axmed.teamtailor.com/jobs/8175859-ai-engineer")).toEqual([{ provider: "teamtailor", token: "axmed" }]);
    expect(linked("https://abstractgroup.breezy.hr/p/ba2aa4ce4eb701")).toEqual([{ provider: "breezy", token: "abstractgroup" }]);
  });

  test("ignores links that name no company, and everything on other hosts", () => {
    // A Workable short link has no account in it; the rest are the providers' own pages and assets.
    for (const url of [
      "https://apply.workable.com/j/FE43DE896A",
      "https://www.greenhouse.io/blog",
      "https://api.ashbyhq.com/posting-api/job-board/acme",
      "https://help.lever.co/",
      "https://assets-cdn.breezy.hr/favicon.ico",
      "https://careers.teamtailor.com/jobs",
      "https://boards.eu.greenhouse.io/acme",
      // Hosted elsewhere: nothing says which provider is behind it, and nothing is fetched to find out.
      "https://careers.tether.io/o/frontend-engineer",
      "https://www.ycombinator.com/companies/acme/jobs/1",
      "https://www.linkedin.com/jobs/view/1",
    ]) {
      expect(boardLinks(`See ${url} for details`)).toEqual([]);
    }
    expect(boardLinks("")).toEqual([]);
  });

  test("returns each board once, keeps the token's case and drops a sentence's full stop", () => {
    const text = "Roles: https://jobs.ashbyhq.com/Acme/1 and https://jobs.ashbyhq.com/acme/2. More at https://jobs.lever.co/acme.";
    expect(boardLinks(text)).toEqual([{ provider: "ashby", token: "Acme" }, { provider: "lever", token: "acme" }]);
  });

  test("a provider's image host is not a company", () => {
    // Breezy serves the pictures in a posting from here; it was once read as a board, and failed every time.
    expect(boardLinks('<img src="https://gallery-cdn.breezy.hr/abc/team.png">')).toEqual([]);
  });
});

// ---------- The employer's own board ----------

describe("looking a role up on its employer's own board", () => {
  /** What the employer wrote, long enough to compare: a job site copies it nearly word for word. */
  const SCHEDULING =
    "<p>Larkspur builds the scheduling platform that regional hospitals rely on to staff their wards. You will own the " +
    "shift planning service from design through operation, working closely with nurses, clinicians and product managers. " +
    "Expect to write TypeScript and Postgres every day, review pull requests carefully, mentor newer engineers, improve " +
    "observability, reduce incident response times and shape quarterly roadmaps. Our distributed team spans eleven " +
    "countries and communicates mostly through written proposals, recorded demos and thoughtful asynchronous discussion. " +
    "Compensation includes equity, generous parental leave, annual learning budgets, home office equipment and retreats.</p>";
  /** The same title at another company: only the stock phrases of job postings are shared. */
  const LEDGER =
    "<p>Join the payments ledger group at a brokerage where every transaction must reconcile exactly. Candidates should " +
    "enjoy double entry bookkeeping, settlement files, regulatory audits, currency conversion, fraud detection models and " +
    "batch reconciliation pipelines written mainly in Kotlin. Weekly rotations cover trading hours across Singapore, " +
    "Frankfurt and Chicago. Benefits feature commuter subsidies, pension matching, private dental insurance, sabbatical " +
    "eligibility after four years and subsidised canteen lunches at headquarters.</p>";

  const posting = (id: number, title: string, location: string, content: string): Listing => ({
    id, title, absolute_url: `https://job-boards.greenhouse.io/larkspur/jobs/${id}`, company_name: "Larkspur, Inc.",
    location: { name: location }, content,
  });
  /** The role as a job site re-lists it: its own page, its own idea of the location. */
  const lead = (fields: Partial<JobOpportunity> = {}): JobOpportunity =>
    createJob({
      source: "weworkremotely", sourceId: "larkspur-senior-engineer", company: "Larkspur", title: "Senior Engineer",
      location: "Anywhere in the World", description: SCHEDULING,
      applyUrl: "https://weworkremotely.com/remote-jobs/larkspur-senior-engineer", ...fields,
    });
  const lookup = (table: Record<string, unknown>, known: Parameters<typeof boardTokens>[2] = []) => {
    const http = fakeFetch(new Map(Object.entries(table)));
    return { find: createEmployerLookup({ http, known }), calls: http.calls };
  };

  test("a company's names on a board: the one already known, then run together, hyphenated and in full", () => {
    expect(boardTokens("Sticker Mule", "ashby")).toEqual(["stickermule", "sticker-mule"]);
    expect(boardTokens("Vercel", "greenhouse")).toEqual(["vercel"]);
    // A board found through some other listing spells it its own way: that spelling is asked first.
    expect(boardTokens("DuckDuckGo", "ashby", [{ provider: "ashby", token: "Duck-Duck-Go" }, { provider: "lever", token: "duckduckgo-x" }]))
      .toEqual(["duck-duck-go", "duckduckgo"]);
    // The legal form and an aside are not part of the name; the article may be.
    expect(boardTokens("Prenosis Inc.", "recruitee")).toEqual(["prenosis", "prenosisinc"]);
    expect(boardTokens("NextAlpha (Nu Dawn)", "lever")).toEqual(["nextalpha"]);
    expect(boardTokens("The Agile Monkeys", "workable")).toEqual(["agilemonkeys", "agile-monkeys", "theagilemonkeys"]);
    expect(boardTokens("", "greenhouse")).toEqual([]);
  });

  test("a job site's copy is told from the same title at another company by what the two say", () => {
    // Trimmed and reformatted, the copy still says what the original does.
    expect(describesSameRole(SCHEDULING.replace(/<\/?p>/g, "").slice(0, 520), SCHEDULING)).toBe(true);
    expect(describesSameRole(SCHEDULING, LEDGER)).toBe(false);
    // A copy with next to no text cannot be compared, and is not held against the listing.
    expect(describesSameRole("Senior engineer wanted. Remote.", LEDGER)).toBe(true);
  });

  test("the role is found under the employer's name and returned as the employer lists it", async () => {
    const { find, calls } = lookup({
      [greenhouseUrl("larkspur")]: {
        jobs: [posting(7, "Senior Engineer (Remote)", "Remote - United States", SCHEDULING), posting(8, "Account Executive", "Austin", LEDGER)],
      },
    });
    const { listings, settled } = await find(lead());

    expect(settled).toBe(true);
    expect(listings).toHaveLength(1);
    // The employer's form and the employer's own word on where the role is, under the
    // company name the job site gave, so that both copies are one company's.
    expect(listings[0]).toMatchObject({
      source: "greenhouse", sourceId: "larkspur:7", company: "Larkspur", title: "Senior Engineer (Remote)",
      location: "Remote - United States", applyUrl: "https://job-boards.greenhouse.io/larkspur/jobs/7",
    });
    expect(sentByHand(listings[0])).toBe(false);
    // Every provider whose forms Reygent reads was asked once, by name; nothing else was fetched.
    expect(calls.sort()).toEqual(
      [ashbyUrl("larkspur"), greenhouseUrl("larkspur"), leverUrl("larkspur"), recruiteeUrl("larkspur"), workableUrl("larkspur")].sort(),
    );
  });

  test("a role open in several regions comes back as each of them", async () => {
    const { find } = lookup({
      [greenhouseUrl("larkspur")]: {
        jobs: [posting(7, "Senior Engineer", "Remote - United States", SCHEDULING), posting(9, "Senior Engineer", "Remote - EMEA", SCHEDULING)],
      },
    });
    expect((await find(lead())).listings.map((listing) => listing.location)).toEqual(["Remote - United States", "Remote - EMEA"]);
  });

  test("another company that goes by the same name is not taken for the employer", async () => {
    const { find } = lookup({ [greenhouseUrl("larkspur")]: { jobs: [posting(7, "Senior Engineer", "Chicago", LEDGER)] } });
    expect(await find(lead())).toEqual({ listings: [], settled: true });
    // Nor is a different role at the right company.
    const staff = lookup({ [greenhouseUrl("larkspur")]: { jobs: [posting(7, "Staff Engineer", "Remote", SCHEDULING)] } });
    expect(await staff.find(lead())).toEqual({ listings: [], settled: true });
  });

  test("a board that could not be asked leaves the question open", async () => {
    const down: FetchJson = async (url) => {
      if (url === greenhouseUrl("larkspur")) throw new Error("The operation was aborted due to timeout");
      throw new FetchError(404, url, "Not Found");
    };
    const find = createEmployerLookup({ http: { fetchJson: down, fetchText: async () => "" } });
    expect(await find(lead())).toEqual({ listings: [], settled: false });
  });

  test("a company's own boards are found by its name, and only where they list a role it advertised", async () => {
    const http = fakeFetch(new Map(Object.entries({
      [greenhouseUrl("larkspur")]: { jobs: [posting(7, "Senior Engineer (Remote)", "Remote", SCHEDULING)] },
      // Another Larkspur, on Lever, with nothing the job sites showed.
      [leverUrl("larkspur")]: [],
    })));
    const find = createBoardFinder({ http });
    expect(await find("Larkspur", ["Senior Engineer", "Data Engineer"])).toEqual({
      boards: [{ provider: "greenhouse", token: "larkspur" }], settled: true,
    });
    expect(await find("Larkspur", ["Account Executive"])).toEqual({ boards: [], settled: true });

    const down = createBoardFinder({
      http: { fetchJson: async () => Promise.reject(new Error("socket hang up")), fetchText: async () => "" },
    });
    expect(await down("Larkspur", ["Senior Engineer"])).toEqual({ boards: [], settled: false });
  });

  test("two roles at one company cost one read of its board", async () => {
    const { find, calls } = lookup({
      [greenhouseUrl("larkspur")]: {
        jobs: [posting(7, "Senior Engineer", "Remote", SCHEDULING), posting(9, "Platform Engineer", "Remote", LEDGER)],
      },
    });
    await find(lead());
    const asked = calls.length;
    const other = await find(lead({ sourceId: "larkspur-platform-engineer", title: "Platform Engineer", description: LEDGER }));

    expect(other.listings.map((listing) => listing.sourceId)).toEqual(["larkspur:9"]);
    expect(calls).toHaveLength(asked);
  });
});

// ---------- discover ----------

describe("discover", () => {
  const everySource = config({
    greenhouse_boards: ["gitlab"],
    ashby_orgs: ["posthog"],
    lever_companies: ["metabase"],
    hn_who_is_hiring: true,
  });

  test("runs every configured source and keeps the listings whose title matches a keyword", async () => {
    const { fetchJson, calls } = fakeFetch();
    const { jobs, errors } = await discover(everySource, { fetchJson });

    expect(errors).toEqual([]);
    // Each source in turn, its newest listing first. Dropped by the default keywords: the
    // account executive, the customer success manager, the account manager, and two HN
    // listings (a GTM specialist and a research scientist) whose title and first line
    // name no keyword.
    expect(jobs.map((job) => [job.source, job.title])).toEqual([
      ["greenhouse", "Fullstack Engineer (TypeScript), AI Engineering: Duo Client SDK"],
      ["ashby", "ClickHouse Operations Engineer"],
      ["lever", "Success Engineer (Global)"],
      ["hn", "Platform Engineer"],
      ["greenhouse", "Backend Engineer (Python),AI Engineering: Agent Foundations"],
      ["lever", "Software Engineer (Backend)"],
      ["hn", "AI Engineer"],
      ["hn", "Founding Engineer"],
      ["hn", "Senior Swift Engineer"],
      ["hn", "Hiring principal and distinguished engineers to build net new products"],
      ["hn", "Senior Product Engineer"],
    ]);
    expect(jobs.filter((job) => job.source === "hn").every((job) => job.channel === Channel.FOUNDER_DIRECT)).toBe(true);
    expect(jobs.filter((job) => job.source !== "hn").every((job) => job.channel === Channel.ATS_INBOUND)).toBe(true);

    // Read-only requests to the four public APIs and nothing else.
    const hosts = new Set(calls.map((url) => new URL(url).host));
    expect([...hosts].sort()).toEqual(["api.ashbyhq.com", "api.lever.co", "boards-api.greenhouse.io", "hn.algolia.com"]);
  });

  test("matches keywords as case-insensitive substrings of the title", async () => {
    const { jobs } = await discover(config({ ...everySource, title_keywords: ["BACKEND", "  swift "] }), fakeFetch());
    expect(jobs.map((job) => job.title)).toEqual([
      "Backend Engineer (Python),AI Engineering: Agent Foundations",
      "Software Engineer (Backend)",
      "Senior Swift Engineer",
    ]);
  });

  test("lets a Hacker News listing through on its first line as well as its title", async () => {
    const { jobs } = await discover(config({ ...everySource, title_keywords: ["typescript"] }), fakeFetch());
    expect(jobs.map((job) => [job.source, job.title])).toEqual([
      ["greenhouse", "Fullstack Engineer (TypeScript), AI Engineering: Duo Client SDK"],
      // "Flowstate (London, UK) — Founding Engineer — TypeScript / React / Postgres / AI"
      ["hn", "Founding Engineer"],
    ]);
    // An ATS listing is judged on its title alone, whatever its description says.
    const described = await discover(config({ greenhouse_boards: ["gitlab"], title_keywords: ["devsecops"] }), fakeFetch());
    expect(described.jobs).toEqual([]);
  });

  test("an empty keyword list keeps everything", async () => {
    const { jobs } = await discover(config({ ...everySource, title_keywords: [] }), fakeFetch());
    expect(jobs).toHaveLength(3 + 2 + 3 + 8);
  });

  test("a failing source does not stop the others", async () => {
    const table = routes({ [ashbyUrl("broken")]: { message: "maintenance" } });
    table.delete(hnCommentsUrl(THREAD_ID, 1, 100));
    const { fetchJson } = fakeFetch(table);

    const { jobs, errors } = await discover(
      config({
        greenhouse_boards: ["gitlab", "no-such-board"],
        ashby_orgs: ["broken"],
        lever_companies: ["metabase"],
        hn_who_is_hiring: true,
      }),
      { fetchJson },
    );

    expect(errors).toEqual([
      { source: "greenhouse:no-such-board", message: `HTTP 404 from ${greenhouseUrl("no-such-board")}: Not Found` },
      { source: "ashby:broken", message: "unexpected response shape (jobs: Invalid input: expected array, received undefined)" },
      // The second comment page failed, so the thread is reported rather than half-read.
      { source: "hn", message: `HTTP 404 from ${hnCommentsUrl(THREAD_ID, 1, 100)}: Not Found` },
    ]);
    expect(jobs.map((job) => job.source).sort()).toEqual(["greenhouse", "greenhouse", "lever", "lever"]);
  });

  test("reports a source that throws something other than an Error", async () => {
    const fetchJson: FetchJson = () => Promise.reject("socket hang up");
    const { jobs, errors } = await discover(config({ lever_companies: ["metabase"] }), { fetchJson });
    expect(jobs).toEqual([]);
    expect(errors).toEqual([{ source: "lever:metabase", message: "socket hang up" }]);
  });

  test("fetches a board once however often it is configured, and de-duplicates by job id", async () => {
    const board = fixture<Board>("greenhouse_gitlab.json");
    // The same listing served twice in one response.
    const repeated = { ...board, jobs: [...board.jobs, board.jobs[0]] };
    const { fetchJson, calls } = fakeFetch(routes({ [greenhouseUrl("gitlab")]: repeated }));

    const { jobs, errors } = await discover(config({ greenhouse_boards: ["gitlab", " GitLab ", "gitlab", ""] }), { fetchJson });

    expect(errors).toEqual([]);
    expect(calls).toEqual([greenhouseUrl("gitlab")]);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
  });

  test("caps the result at max_new_jobs_per_cycle, sharing the cap between sources", async () => {
    const { jobs } = await discover(config({ ...everySource, max_new_jobs_per_cycle: 5 }), fakeFetch());
    // One listing from each source before any source gets a second; the six-listing HN
    // thread does not crowd out the one-listing board. Within a source, newest first:
    // Lever dates its postings back to 2020 and they still make the cut.
    expect(jobs.map((job) => [job.source, job.title, job.postedAt])).toEqual([
      ["greenhouse", "Fullstack Engineer (TypeScript), AI Engineering: Duo Client SDK", "2026-08-21T01:22:41.000Z"],
      ["ashby", "ClickHouse Operations Engineer", "2026-08-25T07:00:51.155Z"],
      ["lever", "Success Engineer (Global)", "2020-05-19T22:42:58.039Z"],
      ["hn", "Platform Engineer", "2026-10-10T13:55:55.000Z"],
      ["greenhouse", "Backend Engineer (Python),AI Engineering: Agent Foundations", "2026-08-19T13:38:27.000Z"],
    ]);
  });

  test("drops listings the caller already tracks before applying the cap", async () => {
    const capped = config({ ...everySource, max_new_jobs_per_cycle: 5 });
    const tracked = new Set<string>();
    const titles: string[][] = [];

    // Three cycles drain all eleven listings, five at a time, with no repeats.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { jobs } = await discover(capped, { ...fakeFetch(), isKnown: (job) => tracked.has(job.id) });
      titles.push(jobs.map((job) => job.title));
      for (const job of jobs) tracked.add(job.id);
    }

    expect(titles.map((batch) => batch.length)).toEqual([5, 5, 1]);
    expect(titles[1]).toEqual([
      "Software Engineer (Backend)",
      "AI Engineer",
      "Founding Engineer",
      "Senior Swift Engineer",
      "Hiring principal and distinguished engineers to build net new products",
    ]);
    expect(titles[2]).toEqual(["Senior Product Engineer"]);
    expect(tracked.size).toBe(11);
  });

  test("source ids and job ids are stable across runs and carry the board token", async () => {
    const first = await discover(everySource, fakeFetch());
    const second = await discover(everySource, fakeFetch());

    expect(second.jobs.map((job) => [job.id, job.sourceId])).toEqual(first.jobs.map((job) => [job.id, job.sourceId]));
    for (const job of first.jobs) expect(job.id).toBe(jobId(job.source, job.sourceId));
    expect(new Set(first.jobs.map((job) => job.id)).size).toBe(first.jobs.length);

    const sourceIds = (source: string) => first.jobs.filter((job) => job.source === source).map((job) => job.sourceId);
    expect(sourceIds("greenhouse")).toEqual(["gitlab:8698330002", "gitlab:8704363002"]);
    expect(sourceIds("ashby")).toEqual(["posthog:43dbf072-0fc1-48c9-8c1e-7416db7d4a14"]);
    expect(sourceIds("lever")).toEqual([
      "metabase:20d0af01-5532-4c22-bf64-474f15b1df05",
      "metabase:85f454d8-e795-4978-8a2b-4b8bfa7d7c37",
    ]);
    // An HN comment id is unique on its own.
    expect(sourceIds("hn")).toEqual(["50033036", "49995549", "49991656", "49975827", "49964448", "49962075"]);
    // Typing the token in another case must not create a second copy of every job.
    const recased = await discover(config({ greenhouse_boards: ["GitLab"] }), fakeFetch(routes({ [greenhouseUrl("GitLab")]: fixture("greenhouse_gitlab.json") })));
    expect(recased.jobs.map((job) => job.sourceId)).toEqual(sourceIds("greenhouse"));
  });

  test("never has more than four requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchJson: FetchJson = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { jobs: [] };
    };
    const boards = Array.from({ length: 11 }, (_, index) => `board-${index}`);

    const { jobs, errors } = await discover(config({ greenhouse_boards: boards, ashby_orgs: boards }), { fetchJson });

    expect(jobs).toEqual([]);
    expect(errors).toEqual([]);
    expect(peak).toBe(4);
  });

  test("logs one line per source and a summary", async () => {
    const lines: string[] = [];
    await discover(config({ greenhouse_boards: ["gitlab", "no-such-board"], lever_companies: ["metabase"] }), {
      ...fakeFetch(),
      log: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "greenhouse:gitlab: 3 listings, 2 match the title keywords",
      `greenhouse:no-such-board: failed: HTTP 404 from ${greenhouseUrl("no-such-board")}: Not Found`,
      "lever:metabase: 3 listings, 2 match the title keywords",
      "discovery: 3 sources, 1 failed; 6 listings, 4 match the title keywords, 0 already known, 4 returned (cap 3000)",
    ]);
  });

  test("does nothing when no source is configured", async () => {
    const { fetchJson, calls } = fakeFetch();
    expect(await discover(config(), { fetchJson })).toEqual({ jobs: [], errors: [] });
    expect(calls).toEqual([]);
  });
});

describe("discover: more sources", () => {
  /** The job boards whose fixture is one request; Jobicy and Himalayas page on. */
  const singleRequestBoards = config({
    job_boards: ["remotive", "remoteok", "workingnomads", "weworkremotely", "realworkfromanywhere", "golangprojects", "python_org"],
  });

  test("reads the job boards and tracks a role once however many of them list it", async () => {
    const lines: string[] = [];
    const { fetchJson, fetchText, calls } = fakeFetch();
    const { jobs, errors } = await discover(singleRequestBoards, { fetchJson, fetchText, log: (line) => lines.push(line) });

    expect(errors).toEqual([]);
    expect(lines).toEqual([
      "remotive: 4 listings, 3 match the title keywords",
      "remoteok: 3 listings, 2 match the title keywords",
      "workingnomads: 4 listings, 2 match the title keywords",
      "weworkremotely: 4 listings, 3 match the title keywords",
      "realworkfromanywhere: 3 listings, 2 match the title keywords",
      "golangprojects: 3 listings, 3 match the title keywords",
      "python_org: 3 listings, 3 match the title keywords",
      "discovery: 7 sources, 0 failed; 24 listings, 18 match the title keywords, 2 also listed by another source, 0 already known, 16 returned (cap 3000)",
    ]);
    // Lemon.io's role is on Remotive, Remote OK ("Full stack") and Working Nomads: the first board read keeps it.
    const lemon = jobs.filter((job) => job.company === "Lemon.io");
    expect(lemon.map((job) => [job.source, job.title])).toEqual([["remotive", "Senior React Full-stack Developer"]]);
    expect(new Set(jobs.map((job) => job.source))).toEqual(new Set(singleRequestBoards.job_boards));
    // One request per board, each to the board's own host.
    expect(calls.map((url) => new URL(url).host).sort()).toEqual([
      "remoteok.com", "remotive.com", "weworkremotely.com", "www.golangprojects.com", "www.python.org",
      "www.realworkfromanywhere.com", "www.workingnomads.com",
    ]);
  });

  test("the company's own board keeps a role that a job board also lists", async () => {
    const both = config({ ashby_orgs: ["supabase"], job_boards: ["realworkfromanywhere"] });
    const { jobs } = await discover(both, fakeFetch());

    expect(jobs.map((job) => [job.source, job.company, job.title])).toEqual([
      ["ashby", "Supabase", "Platform Engineer, Managed Postgres"],
      ["realworkfromanywhere", "DuckDuckGo", "Senior Frontend Engineer, React/Typescript"],
    ]);
    // The board's listing carries the real form and the employer's own wording of the place.
    expect(jobs[0]).toMatchObject({ applyUrl: "https://jobs.ashbyhq.com/supabase/9073c0cd-2545-473a-b2ac-63e4615c69b5/application", location: "Remote, Global" });
    expect(evaluateRemoteEligibility(jobs[0]).tier).toBe("confirmed");
  });

  test("the same title from one source is not a duplicate of itself", async () => {
    const board = fixture<Board>("ashby_supabase.json");
    // The same role opened in two regions: two postings with one title.
    const twoRegions = { jobs: [board.jobs[0], { ...board.jobs[0], id: "another-posting", location: "Remote, AMER" }] };
    const { jobs } = await discover(config({ ashby_orgs: ["supabase"] }), fakeFetch(routes({ [ashbyUrl("supabase")]: twoRegions })));
    expect(jobs.map((job) => job.location).sort()).toEqual(["Remote, AMER", "Remote, Global"]);
  });

  test("reads the new company boards alongside the old", async () => {
    const boards = config({
      greenhouse_boards: ["gitlab"], workable_accounts: ["huggingface"], recruitee_companies: ["tether"],
      teamtailor_companies: ["axmed"], breezy_companies: ["abstractgroup", "no-such-company"],
    });
    const lines: string[] = [];
    const { jobs, errors } = await discover(boards, { ...fakeFetch(), log: (line) => lines.push(line) });

    expect(lines.slice(0, -1)).toEqual([
      "greenhouse:gitlab: 3 listings, 2 match the title keywords",
      "workable:huggingface: 3 listings, 2 match the title keywords",
      "recruitee:tether: 3 listings, 2 match the title keywords",
      "teamtailor:axmed: 3 listings, 1 match the title keywords",
      "breezy:abstractgroup: 3 listings, 1 match the title keywords",
      `breezy:no-such-company: failed: HTTP 404 from ${breezyUrl("no-such-company")}: Not Found`,
    ]);
    expect(errors).toEqual([{ source: "breezy:no-such-company", message: `HTTP 404 from ${breezyUrl("no-such-company")}: Not Found` }]);
    expect(jobs.every((job) => job.channel === Channel.ATS_INBOUND)).toBe(true);
    expect(new Set(jobs.map((job) => job.source))).toEqual(new Set(["greenhouse", "workable", "recruitee", "teamtailor", "breezy"]));
  });

  test("a freelance gig passes on its post's wording, since it has no title to match", async () => {
    const stories = fixture<AlgoliaPage>("hn_freelance_stories.json");
    const asOfJune = { ...stories, hits: stories.hits.filter((hit) => String(hit.title).includes("(June 2026)")) };
    const table = () => fakeFetch(routes({ [hnFreelanceThreadsUrl()]: asOfJune }));

    // The post asks for help with "design, UI/UX, and infrastructure": none of the default keywords.
    expect((await discover(config({ hn_freelancer: true }), table())).jobs).toEqual([]);
    const { jobs } = await discover(config({ hn_freelancer: true, title_keywords: ["infrastructure"] }), table());
    expect(jobs.map((job) => [job.source, job.title, job.channel])).toEqual([["hn_freelance", "Freelancer", Channel.CONTRACT_GIGS]]);
  });

  test("a caller that fakes one client never reaches the network through the other", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the network must not be touched");
    };
    try {
      const mixed = config({ greenhouse_boards: ["gitlab"], teamtailor_companies: ["axmed"], job_boards: ["weworkremotely"] });
      const { jobs, errors } = await discover(mixed, { fetchJson: fakeFetch().fetchJson });
      expect(errors).toEqual([
        { source: "teamtailor:axmed", message: "no feed reader was given" },
        { source: "weworkremotely", message: "no feed reader was given" },
      ]);
      expect(jobs.map((job) => job.source)).toEqual(["greenhouse", "greenhouse"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("with every source switched off nothing is requested", async () => {
    const { fetchJson, fetchText, calls } = fakeFetch();
    expect(await discover(config(), { fetchJson, fetchText })).toEqual({ jobs: [], errors: [] });
    expect(calls).toEqual([]);
  });

  test("starts one source per host in turn, and still reports in source order", async () => {
    const started: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      started.push(new URL(url).host);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { jobs: [] };
    };
    const lines: string[] = [];
    await discover(config({ greenhouse_boards: ["a", "b", "c"], ashby_orgs: ["a", "b"] }), { fetchJson, log: (line) => lines.push(line) });

    // Greenhouse does not take the first three slots while Ashby waits.
    expect(started).toEqual([
      "boards-api.greenhouse.io", "api.ashbyhq.com", "boards-api.greenhouse.io", "api.ashbyhq.com", "boards-api.greenhouse.io",
    ]);
    expect(lines.slice(0, 5).map((line) => line.split(":").slice(0, 2).join(":"))).toEqual([
      "greenhouse:a", "greenhouse:b", "greenhouse:c", "ashby:a", "ashby:b",
    ]);
  });
});

describe("discover: refresh intervals", () => {
  const AT = Date.parse("2026-10-12T08:00:00Z");
  const sources = config({ greenhouse_boards: ["gitlab"], hn_who_is_hiring: true, job_boards: ["remotive", "weworkremotely"] });

  /** One discovery run `minutes` after the first, against the same memory; returns the hosts it asked. */
  function runner(state: DiscoveryState | null) {
    return async (minutes: number, table = routes()) => {
      const { fetchJson, fetchText, calls } = fakeFetch(table);
      const lines: string[] = [];
      const result = await discover(sources, { fetchJson, fetchText, state, now: () => new Date(AT + minutes * 60_000), log: (line) => lines.push(line) });
      return { ...result, hosts: [...new Set(calls.map((url) => new URL(url).host))].sort(), summary: lines.at(-1)! };
    };
  }

  test("a source is not read again before its interval has passed", async () => {
    const run = runner(createMemoryState());

    expect((await run(0)).hosts).toEqual(["boards-api.greenhouse.io", "hn.algolia.com", "remotive.com", "weworkremotely.com"]);
    // Half an hour later nothing is due, and nothing is asked.
    const early = await run(30);
    expect(early.hosts).toEqual([]);
    expect(early.jobs).toEqual([]);
    expect(early.summary).toBe(
      "discovery: 0 sources (4 more not due yet), 0 failed; 0 listings, 0 match the title keywords, 0 already known, 0 returned (cap 3000)",
    );
    // After an hour the company board and the hiring thread are; the job boards are not.
    const hourly = await run(61);
    expect(hourly.hosts).toEqual(["boards-api.greenhouse.io", "hn.algolia.com"]);
    expect(hourly.summary).toContain("2 sources (2 more not due yet)");
    // We Work Remotely every three hours; Remotive, which asks for at most four reads a day, every six.
    expect((await run(182)).hosts).toEqual(["boards-api.greenhouse.io", "hn.algolia.com", "weworkremotely.com"]);
    expect((await run(300)).hosts).toEqual(["boards-api.greenhouse.io", "hn.algolia.com"]);
    expect((await run(361)).hosts).toEqual(["boards-api.greenhouse.io", "hn.algolia.com", "remotive.com"]);
  });

  test("the last read of each source is kept in the store it was given", async () => {
    const state = createMemoryState();
    await runner(state)(0);

    expect(state.getState(READS_KEY)).toEqual({
      "greenhouse:gitlab": "2026-10-12T08:00:00.000Z",
      hn: "2026-10-12T08:00:00.000Z",
      remotive: "2026-10-12T08:00:00.000Z",
      weworkremotely: "2026-10-12T08:00:00.000Z",
    });
    // A second process over the same store honours it: this is what the database gives the pipeline.
    expect((await runner(state)(30)).hosts).toEqual([]);
  });

  test("a failed read counts: a source in trouble is not asked sooner", async () => {
    const run = runner(createMemoryState());
    const down = routes();
    down.delete(remotiveUrl());

    const first = await run(0, down);
    expect(first.errors).toEqual([{ source: "remotive", message: `HTTP 404 from ${remotiveUrl()}: Not Found` }]);
    expect((await run(61)).hosts).not.toContain("remotive.com");
    expect((await run(361)).hosts).toContain("remotive.com");
  });

  test("with no memory every source is read every time", async () => {
    const run = runner(null);
    expect((await run(0)).hosts).toHaveLength(4);
    expect((await run(1)).hosts).toHaveLength(4);
  });

  test("reads from a damaged store as if there were none", async () => {
    const state = createMemoryState();
    state.setState(READS_KEY, ["not", "a", "record"]);
    state.setState(BOARDS_KEY, { "ashby:x": "nonsense", "workday:acme": { provider: "workday", token: "acme" } });
    expect((await runner(state)(0)).hosts).toHaveLength(4);
  });
});

describe("discover: boards found through listings", () => {
  const AT = Date.parse("2026-10-12T08:00:00Z");
  const HOUR = 60;
  const following = (overrides: Partial<DiscoveryConfig> = {}) => config({ hn_who_is_hiring: true, follow_board_links: true, ...overrides });
  const boards = (state: DiscoveryState) => state.getState<Record<string, FoundBoard>>(BOARDS_KEY) ?? {};

  function runner(state: DiscoveryState, settings = following()) {
    return async (minutes: number) => {
      const { fetchJson, fetchText, calls } = fakeFetch();
      const lines: string[] = [];
      const result = await discover(settings, { fetchJson, fetchText, state, now: () => new Date(AT + minutes * 60_000), log: (line) => lines.push(line) });
      return { ...result, calls, lines };
    };
  }

  test("a board found by the company's name lists its jobs under that name", async () => {
    const state = createMemoryState();
    state.setState(BOARDS_KEY, {
      "ashby:mastra": {
        provider: "ashby", token: "mastra", via: "name", foundAt: "2026-10-12T07:00:00.000Z", wanted: true,
        reads: 0, misses: 0, lastReadAt: null, retiredAt: null, company: "Mastra AI",
      },
    });
    const { jobs } = await runner(state, following({ hn_who_is_hiring: false }))(0);
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs.map((job) => job.company))).toEqual(new Set(["Mastra AI"]));
    expect(boards(state)["ashby:mastra"].company).toBe("Mastra AI");
  });

  test("remembers the boards the hiring thread links to, and reads them from the next cycle on", async () => {
    const state = createMemoryState();
    const run = runner(state);

    const first = await run(0);
    // Two posts in the thread link to their Ashby boards. Nothing is read from them yet.
    expect(first.calls.every((url) => new URL(url).host === "hn.algolia.com")).toBe(true);
    expect(first.lines).toContain("discovery: 2 company boards found through listings, 0 dropped for showing nothing; 2 are read in turn");
    expect(boards(state)).toEqual({
      "ashby:mastra": {
        provider: "ashby", token: "mastra", via: "hn", foundAt: "2026-10-12T08:00:00.000Z",
        // Linked from "Mastra | AI Engineer": a listing worth tracking.
        wanted: true, reads: 0, misses: 0, lastReadAt: null, retiredAt: null,
      },
      "ashby:clickhouse": {
        provider: "ashby", token: "clickhouse", via: "hn", foundAt: "2026-10-12T08:00:00.000Z",
        // Linked from a research-scientist post the keywords do not match.
        wanted: false, reads: 0, misses: 0, lastReadAt: null, retiredAt: null,
      },
    });

    const second = await run(61);
    expect(second.calls).toContain(ashbyUrl("mastra"));
    expect(second.lines).toContain("ashby:mastra: 2 listings, 2 match the title keywords");
    expect(second.jobs.filter((job) => job.source === "ashby").map((job) => [job.company, job.title, job.sourceId])).toEqual([
      ["Mastra", "AI Engineer", "mastra:531a3fe8-556f-4b83-bee7-20374f67f980"],
      ["Mastra", "Customer Engineer", "mastra:05172cb0-47ec-44f9-9fe8-07d4896d10ad"],
    ]);
    expect(boards(state)["ashby:mastra"]).toMatchObject({ reads: 1, misses: 0, lastReadAt: "2026-10-12T09:01:00.000Z", retiredAt: null });
  });

  test("follows a link in a post that could not be parsed into a listing", async () => {
    // "Senior Python Backend Engineer | REMOTE (EMEA/APAC)" names no company, so it is no
    // listing; here it is given the link such posts usually end with.
    const pages = ["hn_comments_page0.json", "hn_comments_page1.json"].map((name) => fixture<AlgoliaPage>(name));
    const withLink = pages.map((page) => ({
      ...page,
      hits: page.hits.map((hit) =>
        String(hit.comment_text).startsWith("Senior Python Backend Engineer")
          ? { ...hit, comment_text: `${hit.comment_text}<p>Apply: <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;kaveronix&#x2F;1">https:&#x2F;&#x2F;jobs.lever.co&#x2F;kaveronix&#x2F;1</a>` }
          : hit,
      ),
    }));
    const state = createMemoryState();
    const table = routes({ [hnCommentsUrl(THREAD_ID, 0, 100)]: withLink[0], [hnCommentsUrl(THREAD_ID, 1, 100)]: withLink[1] });
    const { jobs } = await discover(following(), { ...fakeFetch(table), state, now: () => new Date(AT) });

    expect(jobs.some((job) => job.description.includes("kaveronix"))).toBe(false);
    expect(boards(state)["lever:kaveronix"]).toMatchObject({ provider: "lever", token: "kaveronix", via: "hn", wanted: true, reads: 0 });
  });

  test("reads a bounded number per cycle, the wanted ones first, and comes round to the rest", async () => {
    const state = createMemoryState();
    const run = runner(state, following({ found_boards_per_cycle: 1 }));
    const boardsAsked = (calls: string[]) => calls.filter((url) => url.startsWith("https://api.ashbyhq.com/"));

    await run(0);
    expect(boardsAsked((await run(61)).calls)).toEqual([ashbyUrl("mastra")]);
    // Next cycle it is the other one's turn; Mastra was read an hour ago and waits for its own interval.
    expect(boardsAsked((await run(122)).calls)).toEqual([ashbyUrl("clickhouse")]);
    expect(boardsAsked((await run(183)).calls)).toEqual([]);
    // Six hours after its read, Mastra's board is due again.
    expect(boardsAsked((await run(61 + 6 * HOUR)).calls)).toEqual([ashbyUrl("mastra")]);
    // A budget of none reads none, and forgets none.
    const none = runner(state, following({ found_boards_per_cycle: 0 }));
    expect(boardsAsked((await none(20 * HOUR)).calls)).toEqual([]);
    expect(Object.keys(boards(state)).sort()).toEqual(["ashby:clickhouse", "ashby:mastra"]);
  });

  test("drops a board that shows nothing worth tracking in three reads, and does not find it again", async () => {
    const state = createMemoryState();
    const run = runner(state);
    await run(0);

    // The ClickHouse board is not in the fixtures, so every read of it fails.
    const failure = { source: "ashby:clickhouse", message: `HTTP 404 from ${ashbyUrl("clickhouse")}: Not Found` };
    expect((await run(61)).errors).toEqual([failure]);
    expect(boards(state)["ashby:clickhouse"]).toMatchObject({ reads: 1, misses: 1, retiredAt: null });
    expect((await run(61 + 6 * HOUR)).errors).toEqual([failure]);
    const third = await run(61 + 12 * HOUR);
    expect(third.errors).toEqual([failure]);
    expect(third.lines).toContain("discovery: 0 company boards found through listings, 1 dropped for showing nothing; 1 are read in turn");
    expect(boards(state)["ashby:clickhouse"]).toMatchObject({ reads: 3, misses: 3, retiredAt: "2026-10-12T21:01:00.000Z" });

    // The thread still links to it, and it stays dropped.
    const later = await run(61 + 18 * HOUR);
    expect(later.calls).not.toContain(ashbyUrl("clickhouse"));
    expect(later.errors).toEqual([]);
    expect(boards(state)["ashby:clickhouse"].retiredAt).toBe("2026-10-12T21:01:00.000Z");
    // Mastra's board keeps matching and stays.
    expect(boards(state)["ashby:mastra"]).toMatchObject({ misses: 0, retiredAt: null });
  });

  test("a board the user has configured is read as configured, not recorded as found", async () => {
    const state = createMemoryState();
    const run = runner(state, following({ ashby_orgs: ["Mastra"] }));

    const first = await run(0);
    expect(first.calls).toContain(ashbyUrl("Mastra"));
    expect(Object.keys(boards(state))).toEqual(["ashby:clickhouse"]);
  });

  test("follows nothing when the setting is off", async () => {
    const state = createMemoryState();
    const run = runner(state, following({ follow_board_links: false }));

    const first = await run(0);
    expect(first.lines.some((line) => line.includes("company boards found"))).toBe(false);
    expect(state.getState(BOARDS_KEY)).toBeNull();
    // Boards found earlier are left alone, unread, while it is off.
    state.setState(BOARDS_KEY, { "ashby:mastra": { provider: "ashby", token: "mastra", via: "hn", foundAt: "2026-10-01T00:00:00.000Z", wanted: true, reads: 0, misses: 0, lastReadAt: null, retiredAt: null } });
    expect((await run(61)).calls).not.toContain(ashbyUrl("mastra"));
  });
});

// ---------- The real HTTP client ----------

describe("createFetchJson", () => {
  interface Call {
    url: string;
    init: RequestInit | undefined;
    at: number;
  }

  function recordingFetch(respond: () => Response): { fetchImpl: typeof fetch; seen: Call[] } {
    const seen: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init, at: Date.now() });
      return respond();
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  test("sends a GET with the Reygent user agent and a timeout, and decodes the JSON body", async () => {
    const { fetchImpl, seen } = recordingFetch(() => Response.json({ jobs: [] }));
    const fetchJson = createFetchJson({ fetchImpl });

    expect(await fetchJson("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true")).toEqual({ jobs: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].init?.method).toBeUndefined();
    // The User-Agent says what is asking and why; it names no person.
    expect(seen[0].init?.headers).toEqual({
      Accept: "application/json",
      "User-Agent": "reygent/0.2 (personal job-search tool; reads public job feeds)",
    });
    expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("reads a feed as text through the same client", async () => {
    const { fetchImpl, seen } = recordingFetch(() => new Response("<rss><channel></channel></rss>", { headers: { "content-type": "application/rss+xml" } }));
    const { fetchText } = createHttpClient({ fetchImpl });

    expect(await fetchText("https://weworkremotely.com/remote-jobs.rss")).toBe("<rss><channel></channel></rss>");
    expect(seen[0].init?.headers).toMatchObject({ Accept: expect.stringContaining("application/rss+xml"), "User-Agent": expect.stringContaining("reygent/") });
    const failing = createHttpClient({ fetchImpl: (async () => new Response("gone", { status: 410 })) as typeof fetch });
    await expect(failing.fetchText("https://example.test/feed.rss")).rejects.toMatchObject({ status: 410 });
  });

  test("asks one host for one thing at a time, JSON and feeds alike", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(new URL(String(input)).pathname);
      inFlight -= 1;
      return Response.json([]);
    }) as typeof fetch;
    const { fetchJson, fetchText } = createHttpClient({ fetchImpl, minHostIntervalMs: 0 });

    await Promise.all([
      fetchJson("https://jobicy.com/api/v2/remote-jobs?count=200"),
      fetchText("https://jobicy.com/jobs/feed"),
      fetchJson("https://jobicy.com/api/v2/remote-jobs?count=200&cursor=x"),
    ]);

    // Each waited for the one before it, although all three were asked for at once.
    expect(peak).toBe(1);
    expect(order).toEqual(["/api/v2/remote-jobs", "/jobs/feed", "/api/v2/remote-jobs"]);
  });

  test("a failed request does not hold up the next one to that host", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return Response.json({ ok: true });
    }) as typeof fetch;
    const fetchJson = createFetchJson({ fetchImpl, minHostIntervalMs: 0 });

    const [first, second] = await Promise.allSettled([fetchJson("https://api.lever.co/a"), fetchJson("https://api.lever.co/b")]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: { ok: true } });
  });

  test("throws on a non-2xx status", async () => {
    const { fetchImpl } = recordingFetch(() => new Response('{"ok":false,\n "error":"Document not found"}', { status: 404 }));
    const fetchJson = createFetchJson({ fetchImpl });
    const url = "https://api.lever.co/v0/postings/plaid?mode=json";

    const failure = await fetchJson(url).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FetchError);
    expect(failure).toMatchObject({
      status: 404,
      url,
      message: `HTTP 404 from ${url}: {"ok":false, "error":"Document not found"}`,
    });
  });

  test("spaces out requests to one host but not to different hosts", async () => {
    const { fetchImpl, seen } = recordingFetch(() => Response.json([]));
    const fetchJson = createFetchJson({ fetchImpl, minHostIntervalMs: 60 });

    await Promise.all([
      fetchJson("https://api.lever.co/v0/postings/metabase?mode=json"),
      fetchJson("https://api.lever.co/v0/postings/zoox?mode=json"),
      fetchJson("https://api.ashbyhq.com/posting-api/job-board/posthog?includeCompensation=true"),
    ]);

    const startOf = (fragment: string) => seen.find((call) => call.url.includes(fragment))!.at;
    // Timers may fire a millisecond or two early.
    expect(startOf("zoox") - startOf("metabase")).toBeGreaterThanOrEqual(55);
    expect(startOf("posthog") - startOf("metabase")).toBeLessThan(40);
  });
});
