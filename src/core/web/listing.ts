/** A listing typed into the console's "Add a listing" dialog. */

import { createHash } from "node:crypto";

import { CHANNELS, Channel, type JobOpportunity, createJob } from "@/core/models";
import { ApiError, type JsonObject, amountField, textField } from "@/core/web/contract";

/** Validate a listing typed into the UI and turn it into a JobOpportunity. */
export function jobFromForm(data: JsonObject): JobOpportunity {
  const company = textField(data, "company", 300, true);
  const title = textField(data, "title", 300, true);
  const location = textField(data, "location", 300);
  const applyUrl = textField(data, "applyUrl", 2000);
  // Only schemes that are safe to show as a link: never javascript: or data:.
  if (applyUrl && !/^(?:https?:\/\/|mailto:)\S+$/.test(applyUrl)) {
    throw new ApiError(400, "'applyUrl' must be an http(s) or mailto link");
  }
  const compPeriod = textField(data, "compPeriod", 10);
  if (!["", "hour", "month", "year"].includes(compPeriod)) {
    throw new ApiError(400, "'compPeriod' must be hour, month or year");
  }
  const employmentType = textField(data, "employmentType", 20);
  if (!["", "full_time", "contract", "fractional"].includes(employmentType)) {
    throw new ApiError(400, "'employmentType' must be full_time, contract or fractional");
  }
  const channel = data.channel || Channel.ATS_INBOUND;
  if (!CHANNELS.includes(channel as Channel)) throw new ApiError(400, "'channel' is not a known channel");
  const isRemote = data.isRemote ?? null;
  if (isRemote !== null && typeof isRemote !== "boolean") {
    throw new ApiError(400, "'isRemote' must be true, false or null");
  }
  const skills = data.skills || [];
  if (
    !Array.isArray(skills) ||
    skills.length > 50 ||
    !skills.every((skill): skill is string => typeof skill === "string" && skill.length <= 80)
  ) {
    throw new ApiError(400, "'skills' must be a list of up to 50 short names");
  }
  // The same listing typed twice gets the same id, whatever the capitalisation.
  const identity = [company.toLowerCase(), title.toLowerCase(), location.toLowerCase(), applyUrl].join("|");
  return createJob({
    source: "manual",
    sourceId: createHash("sha1").update(identity, "utf8").digest("hex").slice(0, 12),
    company, title, location,
    description: textField(data, "description", 100_000),
    applyUrl,
    companyDomain: textField(data, "companyDomain", 253).toLowerCase(),
    channel: channel as Channel,
    isRemote, employmentType,
    compMin: amountField(data, "compMin"),
    compMax: amountField(data, "compMax"),
    compPeriod,
    compCurrency: textField(data, "compCurrency", 3).toUpperCase() || "USD",
    skills: skills.map((skill) => skill.trim()).filter(Boolean),
  });
}
