/**
 * Cases taken from a live discovery run on 2026-10-12, where company boilerplate about a
 * "globally distributed team" was confirming roles whose location field said otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { defaultConfig } from "@/core/config";
import { discover } from "@/core/discovery";
import { EligibilityTier, createJob } from "@/core/models";
import { evaluateRemoteEligibility } from "@/core/qualification/eligibility";

const BOILERPLATE =
  "We are a globally distributed, all-remote company. Our team works from anywhere in the world" +
  " and we hire in any country where we have an entity.";

const evaluate = (location: string, description = BOILERPLATE, extra: Record<string, unknown> = {}) =>
  evaluateRemoteEligibility(
    createJob({ source: "greenhouse", sourceId: location + description, company: "Acme", title: "Senior Software Engineer", location, description, ...extra }),
  );

describe("the location field outranks the description", () => {
  test("a country-scoped remote role is not confirmed by worldwide-sounding boilerplate", () => {
    for (const location of [
      "Remote, Canada; Remote, United States",
      "United Kingdom (Remote)",
      "Sweden (Remote)",
      "Remote, AMER",
      "Canada (Remote)",
      "India",
      "Remote - Taiwan",
    ]) {
      const report = evaluate(location, BOILERPLATE, { isRemote: true });
      expect(report.tier, location).toBe(EligibilityTier.POTENTIALLY_ELIGIBLE);
      expect(report.reasonCodes, location).toContain("SINGLE_COUNTRY_LOCATION");
      expect(report.reasonCodes, location).not.toContain("WORLDWIDE");
      expect(report.summary, location).toContain(`Listed for ${location}`);
    }
  });

  test("a location that itself says worldwide, EMEA or Africa is confirmed", () => {
    for (const [location, code] of [
      ["Remote, Global", "WORLDWIDE"],
      ["Global Remote", "WORLDWIDE"],
      ["Home based - EMEA", "AFRICA_EMEA"],
      ["Home based - Worldwide", "WORLDWIDE"],
      ["Remote - Africa", "AFRICA_EMEA"],
    ] as const) {
      const report = evaluate(location);
      expect(report.tier, location).toBe(EligibilityTier.CONFIRMED_ELIGIBLE);
      expect(report.reasonCodes, location).toContain(code);
    }
  });

  test("with no place named in the location, the description still confirms", () => {
    for (const location of ["", "Remote", "Fully remote", "Home based", "Remote-first"]) {
      expect(evaluate(location).tier, location || "(empty)").toBe(EligibilityTier.CONFIRMED_ELIGIBLE);
    }
  });

  test("an office-based location is on-site, whatever the description says", () => {
    const report = evaluate("Office Based - Taipei, Taiwan");
    expect(report.tier).toBe(EligibilityTier.INELIGIBLE);
    expect(report.reasonCodes).toContain("ONSITE_REQUIRED");
  });

  test("contractor rails in a country-scoped listing are kept as a hint for the investigation", () => {
    const report = evaluate("Remote - US", "Contractors are paid through Deel.");
    expect(report.tier).toBe(EligibilityTier.POTENTIALLY_ELIGIBLE);
    expect(report.reasonCodes).toEqual(["GEO_UNSPECIFIED", "SINGLE_COUNTRY_LOCATION", "CONTRACTOR_FRIENDLY"]);
  });

  test("an explicit restriction in the description still disqualifies a scoped listing", () => {
    const report = evaluate("Remote, United States", "Candidates must be based in the United States.");
    expect(report.tier).toBe(EligibilityTier.INELIGIBLE);
    expect(report.reasonCodes).toContain("GEO_RESTRICTED");
  });
});

describe("a role that pays nothing is not for a contractor", () => {
  test("an unpaid or volunteer role is ineligible, whatever its location says", () => {
    // Seen on a job site on 2026-10-12, scored a 92% fit and drafted for.
    for (const title of [
      "AI Full Stack Engineer (Volunteer, unpaid)", "Volunteer Software Engineer", "Frontend Developer - Volunteer",
      "Unpaid Engineering Fellowship", "Pro Bono Full-Stack Developer", "Backend Engineer [volunteer]",
    ]) {
      const report = evaluate("Worldwide", BOILERPLATE, { title });
      expect(report.tier, title).toBe(EligibilityTier.INELIGIBLE);
      expect(report.reasonCodes, title).toContain("UNPAID");
    }
    expect(evaluate("Worldwide", BOILERPLATE, { employmentType: "Volunteer" }).reasonCodes).toContain("UNPAID");
  });

  test("a paid role that only mentions volunteering is left alone", () => {
    for (const [title, description] of [
      ["Senior Engineer, Volunteer Management Platform", BOILERPLATE],
      ["Senior Software Engineer", `${BOILERPLATE} Benefits include five paid volunteer days a year and unpaid leave on request.`],
    ]) {
      const report = evaluate("Worldwide", description, { title });
      expect(report.reasonCodes, title).not.toContain("UNPAID");
      expect(report.tier, title).toBe(EligibilityTier.CONFIRMED_ELIGIBLE);
    }
  });
});

describe("the title keyword filter matches whole terms", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/discovery/greenhouse_gitlab.json"), "utf8"),
  ) as { jobs: Array<Record<string, unknown>> };

  const titlesKept = async (titles: string[], keywords: string[]): Promise<string[]> => {
    const jobs = titles.map((title, i) => ({ ...fixture.jobs[0], id: 9000 + i, title }));
    const config = {
      ...defaultConfig().discovery, greenhouse_boards: ["gitlab"], ashby_orgs: [], lever_companies: [], workable_accounts: [],
      recruitee_companies: [], teamtailor_companies: [], breezy_companies: [], job_boards: [], hn_who_is_hiring: false,
      hn_freelancer: false, follow_board_links: false, title_keywords: keywords,
    };
    const result = await discover(config, { fetchJson: async () => ({ ...fixture, jobs, meta: { total: jobs.length } }) });
    expect(result.errors).toEqual([]);
    return result.jobs.map((job) => job.title).sort();
  };

  test('"ai" does not match inside another word, and "engineer" does not match "Engineering"', async () => {
    const kept = await titlesKept(
      ["Paid Media Manager", "AI Engineer", "Applied AI Researcher", "Engineering Director", "Senior Engineers, Platform", "Campaign Lead", "Full-Stack Developer"],
      ["engineer", "ai", "developer"],
    );
    expect(kept).toEqual(["AI Engineer", "Applied AI Researcher", "Full-Stack Developer", "Senior Engineers, Platform"]);
  });

  test("titles below a senior engineer's level are turned away by default, as whole terms", async () => {
    // "Junior Software Engineer" and a graduate role were scored and listed among the fits on 2026-10-12.
    const kept = await titlesKept(
      [
        "Junior Software Engineer", "Software Engineer Intern", "Graduate Software Engineer, Ubuntu", "Engineering Internship (Backend Developer)",
        "Entry-Level Developer", "Working Student - Frontend Developer", "Internal Tools Engineer", "Senior Software Engineer",
        "Staff Engineer, Graduation Platform",
      ],
      ["engineer", "developer"],
    );
    expect(kept).toEqual(["Internal Tools Engineer", "Senior Software Engineer", "Staff Engineer, Graduation Platform"]);
  });
});
