import { describe, expect, test } from "vitest";

import { codeFromEmployerEmail, findEmployerCode, fromEmployer } from "@/core/mail/codeRequest";
import type { InboxMessage, InboxReader } from "@/core/mail/inbox";

const GREENHOUSE = [
  "Hi Arrey,",
  "",
  "Copy and paste this code into the security code field on your application:",
  "",
  "cIiEduTB",
  "",
  "After you enter the code, resubmit your application.",
  "Powered by Greenhouse",
].join("\n");

const SINCE = Date.parse("2026-10-15T12:00:00Z");

const message = (fields: Partial<InboxMessage>): InboxMessage => ({
  uid: 1, messageId: "m", from: "no-reply@us.greenhouse-mail.io", fromName: "Acme",
  subject: "Security code for your application to Acme", date: "2026-10-15T12:01:00.000Z", text: GREENHOUSE, ...fields,
});

const inbox = (messages: InboxMessage[]): InboxReader => ({
  account: "candidate@example.com",
  verify: async () => {},
  async read(_cursor, wanted) {
    return { cursor: { uidValidity: "1", lastUid: 99 }, messages: messages.filter((one) => wanted(one)) };
  },
});

describe("reading a code from an employer's email", () => {
  test("Greenhouse's mixed-case code on a line of its own", () => {
    expect(codeFromEmployerEmail(GREENHOUSE)).toBe("cIiEduTB");
  });

  test("a 6-digit code in a sentence", () => {
    expect(codeFromEmployerEmail("Your verification code is 482915. It expires in 10 minutes.")).toBe("482915");
    expect(codeFromEmployerEmail("Your code is ABCD1234.")).toBe("ABCD1234");
  });

  test("no code: no match, and ordinary words are never taken for one", () => {
    expect(codeFromEmployerEmail("Thanks for applying to Acme. We will be in touch.")).toBeNull();
    expect(codeFromEmployerEmail("Your security code is below\nPlease\nThanks")).toBeNull();
  });

  test("only the hiring platform's own addresses count", () => {
    expect(fromEmployer("no-reply@us.greenhouse-mail.io")).toBe(true);
    expect(fromEmployer("no-reply@greenhouse.io")).toBe(true);
    expect(fromEmployer("no-reply@greenhouse.io.evil.example")).toBe(false);
    expect(fromEmployer("someone@gmail.com")).toBe(false);
  });
});

describe("finding the code in the inbox", () => {
  test("takes the code from Greenhouse's email that arrived after the run started", async () => {
    const found = await findEmployerCode([inbox([message({})])], {}, { since: SINCE, company: "Acme" });
    expect(found).toEqual({ code: "cIiEduTB", subject: "Security code for your application to Acme", receivedAt: "2026-10-15T12:01:00.000Z" });
  });

  test("an email that is too old is passed over", async () => {
    const old = message({ date: "2026-10-15T11:59:59.000Z" });
    expect(await findEmployerCode([inbox([old])], {}, { since: SINCE, company: "Acme" })).toBeNull();
  });

  test("an email from the wrong sender is passed over", async () => {
    const spoof = message({ from: "codes@greenhouse-mail.io.example.com" });
    expect(await findEmployerCode([inbox([spoof])], {}, { since: SINCE, company: "Acme" })).toBeNull();
  });

  test("prefers the email for this company over a newer one for another, and skips codes the site turned down", async () => {
    const other = message({ uid: 2, subject: "Security code for your application to Globex", fromName: "Globex", date: "2026-10-15T12:03:00.000Z", text: "Your code is GLOB1234" });
    const mine = message({ uid: 3, date: "2026-10-15T12:02:00.000Z", text: "Your code is ACME5678" });
    const reader = inbox([message({}), other, mine]);
    expect((await findEmployerCode([reader], {}, { since: SINCE, company: "Acme" }))?.code).toBe("ACME5678");
    expect((await findEmployerCode([reader], {}, { since: SINCE, company: "Acme", skip: ["ACME5678"] }))?.code).toBe("cIiEduTB");
  });

  test("a mailbox that cannot be reached gives no code rather than an error", async () => {
    const down: InboxReader = { account: "x", verify: async () => {}, read: async () => { throw new Error("offline"); } };
    expect(await findEmployerCode([down], {}, { since: SINCE, company: "Acme" })).toBeNull();
  });
});
