import { describe, expect, test } from "vitest";

import {
  asksAboutExperience,
  asksForConsent,
  decliningOption,
  leastClaimingOption,
  modestOption,
  soleConfirmation,
  totalYearsOption,
} from "@/core/qualification/claims";
import { forbidsAi, provesHuman } from "@/core/orchestrator/questions";

describe("answers that claim the least", () => {
  test.each([
    [["Yes", "No"], "No"],
    [["7+", "5-7", "<5"], "<5"],
    [["3+ years", "1-2 years", "< 1 year"], "< 1 year"],
    [["Less than 1 year", "1 to less than 2 years", "4 or more years"], "Less than 1 year"],
    [["Beginner", "Intermediate", "Advanced"], "Beginner"],
    [["Yes, in a professional setting", "Yes, in both", "No, I have not written Rust code for a project"], "No, I have not written Rust code for a project"],
    [["I've built production systems", "I have no direct experience with these"], "I have no direct experience with these"],
    [["Built production integrations", "No CRM integration experience"], "No CRM integration experience"],
  ])("%j: %s", (options, least) => {
    expect(leastClaimingOption(options)).toBe(least);
  });

  test("options with no single bottom have none", () => {
    expect(leastClaimingOption(["More frontend leaning", "More backend leaning"])).toBeNull();
    expect(leastClaimingOption(["No", "None"])).toBeNull();
    expect(leastClaimingOption(["1-2 years", "1-3 years"])).toBeNull();
    expect(leastClaimingOption(["Yes"])).toBeNull();
  });

  test("questions about experience, but not about a spoken language", () => {
    expect(asksAboutExperience("What is your level of knowledge of the Java programming language?")).toBe(true);
    expect(asksAboutExperience("How many years have you spent with CI/CD?")).toBe(true);
    expect(asksAboutExperience("Have you written Rust code for a project?")).toBe(true);
    expect(asksAboutExperience("Do you have English proficiency?")).toBe(false);
    expect(asksAboutExperience("How would you rate your experience communicating in French?")).toBe(false);
    expect(asksAboutExperience("Are you willing to relocate?")).toBe(false);
  });

  test("a consent is declined with its one declining option", () => {
    expect(asksForConsent("By selecting YES, I consent to receive recruiting SMS messages")).toBe(true);
    expect(asksForConsent("Would you like to receive job alerts by email?")).toBe(false);
    expect(decliningOption(["Yes", "No"])).toBe("No");
    expect(decliningOption(["I consent", "I do not consent"])).toBe("I do not consent");
    expect(decliningOption(["Yes", "Maybe"])).toBeNull();
  });

  test("a notice's only option is confirmed, unless the notice mentions AI", () => {
    const edb = "When you apply to this site, the personal information made available to EnterpriseDB will be handled …";
    expect(soleConfirmation(edb, ["Acknowledge"])).toBe("Acknowledge");
    expect(soleConfirmation("Confirm", ["Confirm"])).toBe("Confirm");
    expect(soleConfirmation("AI Policy for Application: we value authenticity", ["I understand"])).toBeNull();
    // One option is not a notice by itself: "Yes" to a question that confirms nothing.
    expect(soleConfirmation("Are you willing to relocate?", ["Yes"])).toBeNull();
    expect(soleConfirmation(edb, ["Acknowledge", "Decline"])).toBeNull();
  });

  test("modestOption reads the question to know which applies", () => {
    expect(modestOption("Do you have experience working at an early stage startup?", ["Yes", "No"])).toBe("No");
    expect(modestOption("Do you consent to BrightHire analyzing your interview?", ["Yes", "No"])).toBe("No");
    expect(modestOption("Is your experience more backend or frontend leaning?", ["More frontend leaning", "More backend leaning"])).toBeNull();
    expect(modestOption("Are you related to any current employees?", ["Yes", "No"])).toBeNull();
  });
});

describe("years of experience in all", () => {
  const question = "How many years of professional software engineering experience do you have?";
  test("the option holding the profile's years", () => {
    expect(totalYearsOption(question, ["Less than 3 years", "3–4 years", "5–7 years", "8+ years"], 4)).toBe("3–4 years");
    expect(totalYearsOption(question, ["Less than 3 years", "3–4 years", "5–7 years", "8+ years"], 2)).toBe("Less than 3 years");
    expect(totalYearsOption(question, ["1-3", "4+"], 9)).toBe("4+");
  });
  test("not for experience with one thing, with no years on file, or when no single option holds them", () => {
    expect(totalYearsOption("How many years of experience do you have working on systems that handle data at scale?", ["<5", "5-7", "7+"], 4)).toBeNull();
    expect(totalYearsOption(question, ["Less than 3 years", "3–4 years"], null)).toBeNull();
    expect(totalYearsOption(question, ["1-5 years", "4-8 years"], 4)).toBeNull();
  });
});

describe("questions Reygent never answers for the candidate", () => {
  test.each([
    "What is the application code found in the browser console at https://metabase.com/jobs (to help us filter out robots)",
    "Please, follow the instructions at https://public-api.wordpress.com/wpcom/v2/work-with-us and paste the value of the secret here.",
    "Prove you are human: what is 3 + 4?",
  ])("a check that the applicant is a person: %s", (question) => {
    expect(provesHuman(question)).toBe(true);
  });

  test.each([
    "During this application process I agree to use only my own words.",
    "AI Policy for Application: At GiveDirectly, we value authenticity and individuality in the hiring process. While we support using AI tools …",
  ])("a pledge not to use AI: %s", (question) => {
    expect(forbidsAi(question)).toBe(true);
  });

  test("ordinary questions are neither", () => {
    for (const question of [
      "By selecting Yes, I am consenting to the use of AI for evaluating my candidacy.",
      "How do you currently use AI in your engineering work?",
      "Have you used a console-based debugger?",
      "What is your application's tech stack?",
    ]) {
      expect(provesHuman(question)).toBe(false);
      expect(forbidsAi(question)).toBe(false);
    }
  });
});
