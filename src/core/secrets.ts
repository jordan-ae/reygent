/**
 * API key lookup and storage.
 *
 * Keys come from the environment when set there; otherwise from an owner-only file in
 * the Reygent data directory, which is where the web console stores them. They are
 * never written to config.yaml and never sent back to the browser.
 */

import fs from "node:fs";
import path from "node:path";

import { expandHome } from "@/core/config";

export const SECRETS_ENV_VAR = "REYGENT_SECRETS_FILE";
const DEFAULT_SECRETS_FILE = "~/.reygent/secrets.json";
const MAX_KEY_LENGTH = 512;

export function secretsPath(): string {
  return path.resolve(expandHome(process.env[SECRETS_ENV_VAR] || DEFAULT_SECRETS_FILE));
}

function read(): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(secretsPath(), "utf8"));
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function write(data: Record<string, string>): void {
  const file = secretsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/**
 * `source[name]` only when it is the object's own entry: a name such as "constructor" or
 * "__proto__" must not resolve to something inherited from Object.prototype.
 */
function own(source: Record<string, string | undefined>, name: string): string {
  return (Object.hasOwn(source, name) && source[name]) || "";
}

/** Where the key named `envName` comes from. */
export function keySource(envName: string): "environment" | "stored" | null {
  if (own(process.env, envName)) return "environment";
  return own(read(), envName) ? "stored" : null;
}

/** The key named `envName`; the environment takes precedence over the stored key. */
export function resolveApiKey(envName: string): string | null {
  return own(process.env, envName) || own(read(), envName) || null;
}

export function storeApiKey(envName: string, value: string): void {
  const key = value.trim();
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new Error("API key must be a single non-empty token");
  }
  write({ ...read(), [envName]: key });
}

export function deleteApiKey(envName: string): void {
  const data = read();
  if (Object.hasOwn(data, envName)) {
    delete data[envName];
    write(data);
  }
}
