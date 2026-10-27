/**
 * Just enough XML to read job feeds: RSS 2.0 and the flat, attribute-free documents the
 * ATS vendors publish.
 *
 * This is not an XML parser. It finds elements by name and returns what is between their
 * tags, which is all a feed of `<item>`s with text children needs, and it avoids taking
 * on a dependency for it. Namespaced names ("tt:location", "dc:creator") are matched as
 * written. An element nested inside another of the same name would be cut short; no feed
 * read here does that.
 */

import { unescapeHtml } from "@/core/text";

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What lies between the tags of every `<name>` element in `xml`, in document order. */
export function xmlElements(xml: string, name: string): string[] {
  const pattern = new RegExp(`<${escaped(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped(name)}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

/**
 * The text of the first `<name>` element in `xml`, or "" when there is none.
 *
 * A CDATA section is taken as it stands; anything else has its character references
 * decoded once, which is what a feed reader does. Feeds carry HTML either way (CDATA, or
 * escaped as "&lt;p&gt;"), so the result of a description is HTML again.
 */
export function xmlText(xml: string, name: string): string {
  const [inner] = xmlElements(xml, name);
  if (inner === undefined) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return (cdata ? cdata[1] : unescapeHtml(inner)).trim();
}

/**
 * The `<item>`s of an RSS feed, each as its inner XML.
 *
 * A document with no `<rss>` root is thrown out: a feed that has moved answers with an
 * HTML page and status 200, and that must show up as a source error, not an empty feed.
 */
export function rssItems(xml: string): string[] {
  if (!/<rss[\s>]/i.test(xml)) throw new Error("unexpected response shape (not an RSS feed)");
  return xmlElements(xml, "item");
}
