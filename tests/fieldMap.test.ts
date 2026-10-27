import { describe, expect, test } from "vitest";

import {
  CUSTOM_REASON,
  SCREENING_SOURCE,
  SENSITIVE_REASON,
  TYPE_AHEAD_REASON,
  normalizeLabel,
  pickSuggestion,
  planFields,
  questionKey,
  requiredLeft,
  searchTerms,
} from "@/core/browser/fieldMap";
import type { FieldPlan, FieldType, FormField } from "@/core/browser/types";
import { type ApplicationDraft, type CandidateProfile, PLACEHOLDER, createDraft } from "@/core/models";

const profile = (overrides: Partial<CandidateProfile> = {}): CandidateProfile => ({
  id: "default",
  name: "Amina Ngono Tabi",
  email: "amina@example.com",
  phone: "+237 650 000 000",
  location: "Douala, Cameroon",
  timezone: "Africa/Douala (WAT, UTC+1)",
  workAuthorization: "Eligible for Global Independent B2B Contractor & 1099 Engagements.",
  noticePeriod: "2 weeks",
  githubUrl: "https://github.com/amina-tabi",
  linkedinUrl: "https://www.linkedin.com/in/amina-tabi",
  portfolioUrl: "https://amina.example.com",
  yearsExperience: 9,
  employers: ["Initech"],
  skills: ["TypeScript"],
  achievements: [],
  positioning: {},
  ...overrides,
});

const draft = (overrides: Partial<ApplicationDraft> = {}): ApplicationDraft =>
  createDraft({ jobId: "job-1", pitch: "I build agent runtimes that recover from failure.", resumePdfPath: "/tmp/resume.pdf", ...overrides });

let nextId = 0;
const field = (label: string, type: FieldType = "text", extra: Partial<FormField> = {}): FormField => ({
  id: `f${++nextId}`, label, type, required: false, options: [], ...extra,
});

const answer = (question: string, text: string) => ({ question, answer: text, options: [], factKey: "" });

/** Plan a single field. */
const planOne = (target: FormField, who = profile(), what = draft()): FieldPlan => planFields([target], who, what)[0];

/** The value a plan would put on the page, whatever kind of plan it is. */
function valueOf(plan: FieldPlan): string | null {
  if (plan.action === "fill" || plan.action === "pitch") return plan.value;
  if (plan.action === "upload") return plan.path;
  if (plan.action === "select") return plan.option;
  if (plan.action === "pick") return plan.query;
  return null;
}

describe("standard fields", () => {
  test.each<[string, FieldType, string, string]>([
    ["First Name", "text", "Amina", "name"],
    ["Given name", "text", "Amina", "name"],
    ["Last Name", "text", "Ngono Tabi", "name"],
    ["Family name", "text", "Ngono Tabi", "name"],
    ["Surname", "text", "Ngono Tabi", "name"],
    ["Full name", "text", "Amina Ngono Tabi", "name"],
    ["Name", "text", "Amina Ngono Tabi", "name"],
    ["Your full name *", "text", "Amina Ngono Tabi", "name"],
    ["What's your name?", "text", "Amina Ngono Tabi", "name"],
    // Ashby's name field is titled "Legal Name" on many boards.
    ["Legal Name", "text", "Amina Ngono Tabi", "name"],
    ["Full legal name", "text", "Amina Ngono Tabi", "name"],
    ["Legal first name", "text", "Amina", "name"],
    ["Legal last name", "text", "Ngono Tabi", "name"],
    // A country asked for as free text (Ashby's "Country of Residence") gets the country the location names.
    ["Country", "text", "Cameroon", "location"],
    ["Country of Residence", "text", "Cameroon", "location"],
    ["Email", "email", "amina@example.com", "email"],
    ["What is your email address?", "text", "amina@example.com", "email"],
    ["E-mail address", "text", "amina@example.com", "email"],
    ["Email Address (required)", "email", "amina@example.com", "email"],
    ["Phone", "tel", "+237 650 000 000", "phone"],
    ["Phone number", "text", "+237 650 000 000", "phone"],
    ["Mobile phone number", "tel", "+237 650 000 000", "phone"],
    ["Location", "text", "Douala, Cameroon", "location"],
    ["Current location", "text", "Douala, Cameroon", "location"],
    ["City", "text", "Douala, Cameroon", "location"],
    ["Location (City)", "text", "Douala, Cameroon", "location"],
    ["City and country", "text", "Douala, Cameroon", "location"],
    ["Where are you based?", "text", "Douala, Cameroon", "location"],
    ["Where are you currently located?", "text", "Douala, Cameroon", "location"],
    ["LinkedIn", "url", "https://www.linkedin.com/in/amina-tabi", "linkedin_url"],
    ["LinkedIn Profile", "text", "https://www.linkedin.com/in/amina-tabi", "linkedin_url"],
    ["LinkedIn URL", "text", "https://www.linkedin.com/in/amina-tabi", "linkedin_url"],
    ["Link to your LinkedIn profile", "text", "https://www.linkedin.com/in/amina-tabi", "linkedin_url"],
    ["GitHub", "url", "https://github.com/amina-tabi", "github_url"],
    ["GitHub URL", "text", "https://github.com/amina-tabi", "github_url"],
    ["Github profile link", "text", "https://github.com/amina-tabi", "github_url"],
    ["Portfolio", "url", "https://amina.example.com", "portfolio_url"],
    ["Portfolio URL", "text", "https://amina.example.com", "portfolio_url"],
    ["Website", "text", "https://amina.example.com", "portfolio_url"],
    ["Personal website", "text", "https://amina.example.com", "portfolio_url"],
    ["Personal site", "text", "https://amina.example.com", "portfolio_url"],
    ["Website / Portfolio", "text", "https://amina.example.com", "portfolio_url"],
    ["Other website", "text", "https://amina.example.com", "portfolio_url"],
    // A box that takes any of several links gets the first one it names.
    ["Github, Personal Website or Blog", "text", "https://github.com/amina-tabi", "github_url"],
    ["LinkedIn or GitHub URL", "url", "https://www.linkedin.com/in/amina-tabi", "linkedin_url"],
    ["Portfolio / GitHub link", "text", "https://amina.example.com", "portfolio_url"],
    ["Blog, Twitter or GitHub", "text", "https://github.com/amina-tabi", "github_url"],
  ])("%s (%s) is filled with %s", (label, type, value, source) => {
    expect(planOne(field(label, type))).toMatchObject({ action: "fill", value, source });
  });

  test.each<[string, FieldType]>([
    ["What's the name you'd prefer us to use throughout the interview process?", "text"],
    ["Preferred Name | What would you like us to call you?", "text"],
    ["Preferred First Name", "text"],
    ["Preferred Name (if applicable)", "text"],
    ["Name of your current employer", "text"],
    ["What is the name of your current employer?", "text"],
    ["Name Pronunciation | How do you pronounce your name?", "text"],
    ["Current company", "text"],
    ["Do you consent to receiving email updates about this role?", "text"],
    ["How did you hear about us? (LinkedIn, GitHub, a friend…)", "text"],
    ["GitHub username", "text"],
    ["Twitter URL", "text"],
    ["Country of birth", "text"],
    ["Years of experience", "number"],
    ["Earliest start date", "date"],
    ["Email", "select"],
    ["Phone", "textarea"],
    ["Why are you interested in this role?", "textarea"],
    ["How did you hear about this job?", "select"],
    ["I agree to the privacy policy", "checkbox"],
  ])("%s (%s) is left as a custom question", (label, type) => {
    expect(planOne(field(label, type, { options: type === "select" ? ["LinkedIn", "Other"] : [] }))).toMatchObject({
      action: "leave", reason: CUSTOM_REASON,
    });
  });

  test("a single-word name fills first and full name and leaves the last name", () => {
    const solo = profile({ name: "Amina" });
    expect(planOne(field("First name"), solo)).toMatchObject({ action: "fill", value: "Amina" });
    expect(planOne(field("Full name"), solo)).toMatchObject({ action: "fill", value: "Amina" });
    expect(planOne(field("Last name"), solo)).toMatchObject({ action: "leave", reason: "the name on file has no last name" });
  });

  test("labels are compared as words, whatever their punctuation and accents", () => {
    expect(normalizeLabel("  E-mail   Address (Optional) *")).toBe("e mail address");
    expect(normalizeLabel("Résumé/CV")).toBe("resume cv");
    expect(normalizeLabel("Website & Portfolio")).toBe("website and portfolio");
  });
});

describe("sensitive questions", () => {
  const yesNo = { options: ["Yes", "No"] };
  const countries = { options: ["Benin", "Cameroon", "France"] };

  test.each<[string, FieldType, Partial<FormField>]>([
    ["Work authorization", "text", {}],
    ["Work Authorisation Status", "text", {}],
    ["Are you legally authorized to work in the United States?", "select", yesNo],
    ["Are you eligible to work in the UK?", "radio", yesNo],
    ["Do you have the right to work in Germany?", "radio", yesNo],
    ["Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?", "radio", yesNo],
    ["Visa status", "text", {}],
    ["Country of citizenship", "select", countries],
    ["Are you a Singapore citizen?", "radio", yesNo],
    ["Nationality", "select", countries],
    ["Country of tax residence", "select", countries],
    ["Tax ID", "text", {}],
    ["Have you ever been convicted of a criminal offence?", "radio", yesNo],
    ["Disability Status", "select", { options: ["Yes", "No", "I don't wish to answer"] }],
    ["Veteran Status", "select", { options: ["I am not a protected veteran", "I don't wish to answer"] }],
    ["Gender", "select", { options: ["Male", "Female", "Decline to self-identify"] }],
    ["Race/Ethnicity", "select", { options: ["Black or African American", "Decline to self-identify"] }],
    ["Are you Hispanic/Latino?", "select", yesNo],
    ["Pronouns", "text", {}],
    ["Date of birth", "date", {}],
    ["Upload a copy of your visa", "file", {}],
    ["Tell us about your work authorization", "textarea", {}],
  ])("%s (%s) is never touched", (label, type, extra) => {
    expect(planOne(field(label, type, extra))).toEqual({ field: expect.anything(), action: "leave", reason: SENSITIVE_REASON });
  });

  test("a box for any of several links, none of them on file, is a custom question like any other", () => {
    const noSite = profile({ portfolioUrl: PLACEHOLDER });
    const [plan] = planFields([field("Personal website or blog")], noSite, draft());
    expect(plan).toMatchObject({ action: "leave", reason: CUSTOM_REASON });
  });

  test("a fact that seems to fit is still not used", () => {
    // The profile does hold a work-authorization sentence; it is never typed into a form.
    const plan = planOne(field("Work authorization"));
    expect(plan.action).toBe("leave");
    expect(JSON.stringify(plan)).not.toContain("B2B Contractor");
  });
});

describe("unfilled placeholders", () => {
  const blank = profile({
    name: PLACEHOLDER, email: PLACEHOLDER, phone: PLACEHOLDER, location: PLACEHOLDER,
    githubUrl: PLACEHOLDER, linkedinUrl: `https://www.linkedin.com/in/${PLACEHOLDER}`, portfolioUrl: PLACEHOLDER,
  });
  const fields = () => [
    field("First name"), field("Last name"), field("Full name"), field("Email", "email"), field("Phone", "tel"),
    field("Location"), field("LinkedIn"), field("GitHub"), field("Portfolio"),
    field("Country", "select", { options: ["Cameroon"] }),
    field("Resume/CV", "file"), field("Cover letter", "textarea"), field("Favourite editor?"),
  ];

  test("every field whose fact is a placeholder is left for the user", () => {
    const plans = planFields(fields(), blank, draft({ pitch: "", resumePdfPath: "" }));
    expect(plans.map((plan) => plan.action)).toEqual(Array(13).fill("leave"));
    expect(plans[3]).toMatchObject({ reason: "no verified email on file" });
  });

  test("CHANGE_ME is never part of anything that would be typed, pasted, attached or chosen", () => {
    const tainted = draft({
      pitch: `Dear ${PLACEHOLDER}, I am interested.`,
      resumePdfPath: `/tmp/${PLACEHOLDER}.pdf`,
      screeningAnswers: [answer("Favourite editor?", PLACEHOLDER), answer("Phone", `call ${PLACEHOLDER}`)],
    });
    const plans = planFields(fields(), blank, tainted);
    expect(plans.every((plan) => plan.action === "leave")).toBe(true);
    for (const plan of planFields(fields(), profile({ phone: PLACEHOLDER }), tainted)) {
      expect(valueOf(plan) ?? "").not.toContain(PLACEHOLDER);
    }
  });
});

describe("country lists", () => {
  test("the option that equals Cameroon is chosen, in the list's own spelling", () => {
    expect(planOne(field("Country", "select", { options: ["Benin", "CAMEROON", "Canada"] }))).toMatchObject({
      action: "select", option: "CAMEROON", source: "location",
    });
    expect(planOne(field("Please choose the country in which you are located.", "select", { options: ["Cameroon", "Chad"] })))
      .toMatchObject({ action: "select", option: "Cameroon" });
    expect(planOne(field("Country of residence", "radio", { options: ["Nigeria", "Cameroon"] })))
      .toMatchObject({ action: "select", option: "Cameroon" });
    expect(planOne(field("Location", "select", { options: ["Cameroon", "Kenya"] }))).toMatchObject({ action: "select", option: "Cameroon" });
    expect(planOne(field("What is your current country of residence?", "select", { options: ["Cameroon", "Kenya"] })))
      .toMatchObject({ action: "select", option: "Cameroon" });
  });

  test("a list without Cameroon is left alone — nothing close is picked instead", () => {
    const near = [
      ["Benin", "Canada"], ["Central Africa"], ["Cameroon, Republic of"], ["Cameroon (Francophone)"], ["South Cameroon"],
      ["Cameroons"], [],
    ];
    for (const options of near) {
      expect(planOne(field("Country", "select", { options }))).toMatchObject({ action: "leave", reason: "no option equals Cameroon" });
    }
  });

  test("an option that is the country followed only by its dial code counts — it is the phone's country", () => {
    // Greenhouse's phone-country dropdown lists "Cameroon +237"; other boards "Cameroon (+237)".
    for (const option of ["Cameroon +237", "Cameroon (+237)", "Cameroon: +237", "cameroon (237)"]) {
      expect(planOne(field("Country", "select", { options: ["Canada +1", option, "France +33"] }))).toMatchObject({
        action: "select", option, source: "location",
      });
    }
    // The plain name wins when both are listed.
    expect(planOne(field("Country", "select", { options: ["Cameroon +237", "Cameroon"] }))).toMatchObject({ option: "Cameroon" });
  });

  test("the phone's country is only chosen when the number on file carries that dial code", () => {
    const phoneCountry = () => field("Country", "select", { options: ["Cameroon +237", "France +33"] });
    expect(planOne(phoneCountry(), profile({ phone: "00237 650 000 000" }))).toMatchObject({ action: "select", option: "Cameroon +237" });
    expect(planOne(phoneCountry(), profile({ phone: "+33 6 12 34 56 78" }))).toMatchObject({
      action: "leave", reason: "the phone number on file is not a +237 number",
    });
    expect(planOne(phoneCountry(), profile({ phone: PLACEHOLDER }))).toMatchObject({
      action: "leave", reason: "no verified phone number on file",
    });
    // A plain country list asks where the candidate lives, whatever their phone number is.
    expect(planOne(field("Country", "select", { options: ["Cameroon", "France"] }), profile({ phone: "+33 6 12 34 56 78" })))
      .toMatchObject({ action: "select", option: "Cameroon" });
  });

  test("Cameroon is only chosen or typed when the verified location says so", () => {
    const elsewhere = profile({ location: "Lagos, Nigeria" });
    expect(planOne(field("Country", "select", { options: ["Cameroon", "Nigeria"] }), elsewhere)).toMatchObject({
      action: "leave", reason: "no verified country on file",
    });
    expect(planOne(field("Country of Residence", "text"), elsewhere)).toMatchObject({
      action: "leave", reason: "no verified country on file",
    });
  });

  test("a custom dropdown with no readable options is left alone", () => {
    expect(planOne(field("Team", "select"))).toMatchObject({ action: "leave" });
  });
});

describe("type-aheads", () => {
  test("a dropdown that searches for places as you type gets the verified place to search for", () => {
    // Greenhouse's "Location (City)", Ashby's "Location".
    for (const label of ["Location (City)", "Location", "Where are you currently located?", "Current location"]) {
      expect(planOne(field(label, "select", { typeAhead: true }))).toEqual({
        field: expect.anything(), action: "pick", query: "Douala, Cameroon", source: "location",
      });
    }
    // The timezone note of the default profile is not part of the place.
    expect(planOne(field("Location", "select", { typeAhead: true }), profile({ location: "Douala, Cameroon (UTC+1)" }))).toMatchObject({
      action: "pick", query: "Douala, Cameroon",
    });
    expect(planOne(field("Location", "select", { typeAhead: true }), profile({ location: PLACEHOLDER }))).toMatchObject({
      action: "leave", reason: TYPE_AHEAD_REASON,
    });
  });

  test("a type-ahead dropdown that asks anything else is left alone", () => {
    const others = [
      // n8n's: a preference, not where the candidate is.
      "What would be your preferred main location for your contract?",
      "Which office would you like to work from?",
      "University",
      "Where did you hear about us?",
    ];
    for (const label of others) {
      expect(planOne(field(label, "select", { typeAhead: true }))).toEqual({
        field: expect.anything(), action: "leave", reason: TYPE_AHEAD_REASON,
      });
    }
    // Where the candidate may work is a legal question, however it is asked.
    expect(planOne(field("Where are you authorized to work?", "select", { typeAhead: true }))).toMatchObject({
      action: "leave", reason: SENSITIVE_REASON,
    });
  });

  test("a country box that keeps only a picked suggestion gets the country the verified location names", () => {
    for (const label of ["Country of Residence", "Country"]) {
      expect(planOne(field(label, "select", { typeAhead: true }), profile({ location: "Douala, Cameroon (UTC+1)" }))).toMatchObject({
        action: "pick", query: "Cameroon", source: "location",
      });
    }
    expect(planOne(field("Country of Residence", "select", { typeAhead: true }), profile({ location: "Lagos, Nigeria" }))).toMatchObject({
      action: "leave", reason: TYPE_AHEAD_REASON,
    });
  });

  test("a location box that keeps only a picked suggestion gets the verified location to search for", () => {
    // Lever's "Current location".
    expect(planOne(field("Current location", "text", { typeAhead: true }))).toMatchObject({
      action: "pick", query: "Douala, Cameroon", source: "location",
    });
    expect(planOne(field("Current location", "text", { typeAhead: true }), profile({ location: PLACEHOLDER }))).toMatchObject({
      action: "leave", reason: TYPE_AHEAD_REASON,
    });
    // A note about the timezone is not part of the place a location search knows.
    expect(planOne(field("Current location", "text", { typeAhead: true }), profile({ location: "Douala, Cameroon (UTC+1)" }))).toMatchObject({
      action: "pick", query: "Douala, Cameroon",
    });
    expect(planOne(field("Current location", "text", { typeAhead: true }), profile({ location: "(UTC+1)" }))).toMatchObject({
      action: "leave", reason: TYPE_AHEAD_REASON,
    });
    // Any other type-ahead text box is not the operator's to search in.
    expect(planOne(field("University", "text", { typeAhead: true }))).toMatchObject({ action: "leave", reason: TYPE_AHEAD_REASON });
  });

  test("a screening answer is never typed into a type-ahead", () => {
    const what = draft({ screeningAnswers: [answer("University", "MIT"), answer("Preferred office", "Lagos"), answer("Location (City)", "Lagos")] });
    expect(planOne(field("University", "text", { typeAhead: true }), profile(), what)).toMatchObject({ action: "leave" });
    expect(planOne(field("Preferred office", "select", { typeAhead: true }), profile(), what)).toMatchObject({ action: "leave" });
    // A location search is answered from the verified location, not from an answer.
    expect(planOne(field("Location (City)", "select", { typeAhead: true }), profile(), what)).toMatchObject({
      action: "pick", query: "Douala, Cameroon",
    });
    expect(planOne(field("Location (City)", "select", { typeAhead: true }), profile({ location: PLACEHOLDER }), what)).toMatchObject({
      action: "leave",
    });
  });

  test("a suggestion is picked only when it is the place, or the one suggestion for that city and country", () => {
    const douala = ["Douala, Littoral, Cameroon", "Douala, Texas, United States"];
    expect(pickSuggestion("Douala, Cameroon", douala)).toBe(0);
    expect(pickSuggestion("douala,  cameroon", ["Yaoundé, Centre, Cameroon", "Douala, Cameroon"])).toBe(1);
    // Exact beats "same city and country".
    expect(pickSuggestion("Douala, Cameroon", ["Douala, Littoral, Cameroon", "Douala, Cameroon"])).toBe(1);
    // Two candidates for the same city and country: neither.
    expect(pickSuggestion("Springfield, United States", ["Springfield, Illinois, United States", "Springfield, Missouri, United States"])).toBe(-1);
    // Never the first, the closest or a partial match.
    expect(pickSuggestion("Douala, Cameroon", ["Douala, Texas, United States", "Yaoundé, Centre, Cameroon"])).toBe(-1);
    expect(pickSuggestion("Douala", douala)).toBe(-1);
    expect(pickSuggestion("Cameroon (UTC+1)", ["Cameroon", "Douala, Littoral, Cameroon"])).toBe(-1);
    expect(pickSuggestion("Douala, Cameroon", [])).toBe(-1);
    // A search that knows no city there offers the country: less precise, and still true.
    expect(pickSuggestion("Yaounde, Cameroon", ["Cameroon"])).toBe(0);
    expect(pickSuggestion("Yaounde, Cameroon", ["Nigeria", "Cameroon", "Cameroon"])).toBe(1);
    // But never another country, and never the country when the city is offered.
    expect(pickSuggestion("Yaounde, Cameroon", ["Nigeria"])).toBe(-1);
    expect(pickSuggestion("Yaounde, Cameroon", ["Cameroon", "Yaoundé, Centre, Cameroon"])).toBe(1);
    expect(pickSuggestion("", douala)).toBe(-1);
  });

  test("an accent does not make it a different place", () => {
    // The profile is typed without the accent; the geocoder answers with it.
    const listed = ["Yaoundé, Centre, Cameroon", "Yaoundé, Ngounié, Gabon"];
    expect(pickSuggestion("Yaounde, Cameroon", listed)).toBe(0);
    expect(pickSuggestion("Yaoundé, Cameroon", ["Yaounde, Centre Region, Cameroon"])).toBe(0);
    expect(pickSuggestion("Yaounde, Cameroon", ["Yaoundé, Cameroon", "Yaoundé, Centre, Cameroon"])).toBe(0);
    // Still the same rule otherwise: another country is another place.
    expect(pickSuggestion("Yaounde, Cameroon", ["Yaoundé, Ngounié, Gabon"])).toBe(-1);
  });

  test("the same place offered twice is one place; two places are still two", () => {
    // What Greenhouse's geocoder really lists for "Douala": the city twice, under two record ids.
    const listed = [
      "Douala, Littoral Province, Cameroon", "Beni Douala, Tizi Ouzou, Algeria", "Doualayel, Adamaoua Province, Cameroon",
      "Douala, Beyla, Guinea", "Douala, Logone Occidental, Chad", "La Ville Doualan, France", "Douala, Littoral Province, Cameroon",
    ];
    expect(pickSuggestion("Douala, Cameroon", listed)).toBe(0);
    // A second Douala in another region of Cameroon would be a different place.
    expect(pickSuggestion("Douala, Cameroon", [...listed, "Douala, Centre Province, Cameroon"])).toBe(-1);
    expect(pickSuggestion("Douala, Guinea", listed)).toBe(3);
    expect(pickSuggestion("Douala, Nigeria", listed)).toBe(-1);
  });

  test("a location search is tried with the city first, then with the whole place", () => {
    expect(searchTerms("Douala, Cameroon")).toEqual(["Douala", "Douala, Cameroon", "Cameroon"]);
    expect(searchTerms("  Douala ,  Littoral, Cameroon ")).toEqual(["Douala", "Douala , Littoral, Cameroon", "Cameroon"]);
    expect(searchTerms("Cameroon")).toEqual(["Cameroon"]);
    expect(searchTerms("")).toEqual([]);
  });
});

describe("resume and cover letter", () => {
  test.each(["Resume/CV", "Resume", "CV", "Upload your résumé", "Curriculum Vitae", "Resume/CV ATTACH RESUME/CV"])(
    "a file input labelled %s gets the resume PDF",
    (label) => {
      expect(planOne(field(label, "file"))).toMatchObject({ action: "upload", path: "/tmp/resume.pdf" });
    },
  );

  test("an empty resume path leaves the file input for the user", () => {
    expect(planOne(field("Resume/CV", "file"), profile(), draft({ resumePdfPath: "" }))).toMatchObject({
      action: "leave", reason: "no resume PDF on this draft",
    });
  });

  test("the resume is attached once, and never to an autofill helper or another upload", () => {
    const plans = planFields(
      [
        field("Autofill from resume Upload your resume here to autofill key application fields.", "file"),
        field("Resume", "file"),
        field("CV (optional second copy)", "file"),
        field("Transcript", "file"),
      ],
      profile(),
      draft(),
    );
    expect(plans.map((plan) => plan.action)).toEqual(["leave", "upload", "leave", "leave"]);
  });

  test("a cover-letter textarea gets the pitch; a cover-letter file input does not", () => {
    expect(planOne(field("Cover Letter", "textarea"))).toMatchObject({
      action: "pitch", value: "I build agent runtimes that recover from failure.",
    });
    expect(planOne(field("Additional information", "textarea"))).toMatchObject({ action: "pitch" });
    expect(planOne(field("Cover Letter", "file"))).toMatchObject({ action: "leave", reason: "cover letter as a file — attach it yourself" });
    expect(planOne(field("Cover letter", "text"))).toMatchObject({ action: "leave" });
  });

  test("the pitch is pasted once, into the cover letter rather than the catch-all box", () => {
    const plans = planFields([field("Additional information", "textarea"), field("Cover letter", "textarea")], profile(), draft());
    expect(plans.map((plan) => plan.action)).toEqual(["leave", "pitch"]);
  });

  test("other free-text questions never receive the pitch", () => {
    for (const label of ["Why do you want to work at Fixture Labs?", "Anything else you would like us to know?", "Describe a hard bug"]) {
      expect(planOne(field(label, "textarea"))).toMatchObject({ action: "leave", reason: CUSTOM_REASON });
    }
  });

  test("an empty pitch leaves the cover letter for the user", () => {
    expect(planOne(field("Cover letter", "textarea"), profile(), draft({ pitch: "  " }))).toMatchObject({ action: "leave" });
  });
});

describe("screening answers", () => {
  const years = "How many years of TypeScript experience do you have?";
  const sponsorship = "Will you require visa sponsorship?";

  test("a custom text question is answered when the draft has an answer for exactly that question", () => {
    const what = draft({ screeningAnswers: [answer(years, "Nine")] });
    for (const label of [years, `${years} *`, `  how many years of   TypeScript experience do you have?`, `${years}:`]) {
      expect(planOne(field(label), profile(), what)).toMatchObject({ action: "fill", value: "Nine", source: SCREENING_SOURCE });
    }
    expect(planOne(field(years, "textarea"), profile(), what)).toMatchObject({ action: "fill", value: "Nine" });
  });

  test("a differently worded question is not answered", () => {
    const what = draft({ screeningAnswers: [answer(years, "Nine")] });
    for (const label of ["How many years of TypeScript experience?", "Years of TypeScript experience", `${years} (roughly)`]) {
      expect(planOne(field(label), profile(), what)).toMatchObject({ action: "leave", reason: CUSTOM_REASON });
    }
  });

  test("a choice question is answered only with one of its own options", () => {
    const notice = field("What is your notice period?", "select", { options: ["Immediately", "2 Weeks", "1 month"] });
    expect(planOne(notice, profile(), draft({ screeningAnswers: [answer("What is your notice period?", "2 weeks")] })))
      .toMatchObject({ action: "select", option: "2 Weeks", source: SCREENING_SOURCE });
    expect(planOne(notice, profile(), draft({ screeningAnswers: [answer("What is your notice period?", "Three weeks")] })))
      .toMatchObject({ action: "leave", reason: "the prepared answer is not one of the options" });
    const languages = field("Languages", "checkbox", { options: ["English (ENG)", "French (FRA)"] });
    expect(planOne(languages, profile(), draft({ screeningAnswers: [answer("Languages", "french (fra)")] })))
      .toMatchObject({ action: "select", option: "French (FRA)" });
    // A react-select combobox exposes no options, so there is nothing to match against.
    expect(planOne(field("Team", "select"), profile(), draft({ screeningAnswers: [answer("Team", "Platform")] })))
      .toMatchObject({ action: "leave" });
  });

  test("a sensitive question is answered only on an exact question and option match", () => {
    const question = field(sponsorship, "select", { options: ["Yes", "No"] });
    expect(planOne(question)).toMatchObject({ action: "leave", reason: SENSITIVE_REASON });
    expect(planOne(question, profile(), draft({ screeningAnswers: [answer(sponsorship, "no")] })))
      .toMatchObject({ action: "select", option: "No", source: SCREENING_SOURCE });
    expect(planOne(question, profile(), draft({ screeningAnswers: [answer(sponsorship, "Not at this time")] })))
      .toMatchObject({ action: "leave" });
    expect(planOne(question, profile(), draft({ screeningAnswers: [answer("Do you require visa sponsorship?", "No")] })))
      .toMatchObject({ action: "leave", reason: SENSITIVE_REASON });
  });

  test("a sensitive free-text question takes the vetted answer, never the profile fact", () => {
    const vetted = "I invoice as an independent contractor.";
    expect(planOne(field("Work authorization"), profile(), draft({ screeningAnswers: [answer("Work authorization", vetted)] })))
      .toMatchObject({ action: "fill", value: vetted, source: SCREENING_SOURCE });
  });

  test("a verified fact wins over an answer; an answer fills in where the fact is missing", () => {
    const what = draft({ screeningAnswers: [answer("Phone", "+33 1 23 45 67 89"), answer("Resume", "see attached")] });
    expect(planOne(field("Phone", "tel"), profile(), what)).toMatchObject({ value: "+237 650 000 000", source: "phone" });
    expect(planOne(field("Phone", "tel"), profile({ phone: PLACEHOLDER }), what)).toMatchObject({
      action: "fill", value: "+33 1 23 45 67 89", source: SCREENING_SOURCE,
    });
    // Files are never produced from an answer.
    expect(planOne(field("Resume", "file"), profile(), draft({ resumePdfPath: "", screeningAnswers: what.screeningAnswers })))
      .toMatchObject({ action: "leave" });
  });

  test("questions are keyed without case, extra spaces or a trailing marker — and nothing else", () => {
    expect(questionKey("  Notice   period? * ")).toBe("notice period?");
    expect(questionKey("Notice period:")).toBe("notice period");
    expect(questionKey("Notice period?")).not.toBe(questionKey("Notice period"));
  });
});

test("requiredLeft lists the required fields a plan leaves", () => {
  const plans = planFields(
    [
      field("Email", "email", { required: true }),
      field("Favourite editor?", "text", { required: true }),
      field("Anything else?", "text"),
      field("Gender", "select", { required: true, options: ["Female", "Male"] }),
    ],
    profile(),
    draft(),
  );
  expect(requiredLeft(plans)).toEqual(["Favourite editor?", "Gender"]);
});
