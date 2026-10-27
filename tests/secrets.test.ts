/**
 * API key storage: behaviour of reygent/secrets.py (see tests/test_web.py::ApiKeyTests).
 * Every test points REYGENT_SECRETS_FILE at a temporary directory; ~/.reygent is never touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SECRETS_ENV_VAR, deleteApiKey, keySource, resolveApiKey, secretsPath, storeApiKey } from "@/core/secrets";

// Names no real environment defines, so a developer's own keys can never leak into a test.
const FIREWORKS = "REYGENT_TEST_FIREWORKS_API_KEY";
const JEV = "REYGENT_TEST_TYPESAFE_API_KEY";
const SECRET = "fw-secret-0123456789";
const MANAGED = [SECRETS_ENV_VAR, FIREWORKS, JEV];

let dir: string;
let file: string;
let savedEnv: Record<string, string | undefined>;

const mode = (target: string): number => fs.statSync(target).mode & 0o777;
const onDisk = (): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-secrets-"));
  file = path.join(dir, "secrets.json");
  process.env[SECRETS_ENV_VAR] = file;
});

afterEach(() => {
  for (const name of MANAGED) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("where secrets live", () => {
  test("REYGENT_SECRETS_FILE selects the file", () => {
    expect(secretsPath()).toBe(file);
  });

  test("the default is ~/.reygent/secrets.json", () => {
    delete process.env[SECRETS_ENV_VAR];
    expect(secretsPath()).toBe(path.join(os.homedir(), ".reygent", "secrets.json"));
  });

  test("a leading ~ in REYGENT_SECRETS_FILE is the home directory", () => {
    process.env[SECRETS_ENV_VAR] = "~/somewhere/keys.json";
    expect(secretsPath()).toBe(path.join(os.homedir(), "somewhere", "keys.json"));
  });
});

describe("storing a key", () => {
  test("a stored key is found again and reported as stored", () => {
    expect(resolveApiKey(FIREWORKS)).toBeNull();
    expect(keySource(FIREWORKS)).toBeNull();

    storeApiKey(FIREWORKS, SECRET);

    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
    expect(keySource(FIREWORKS)).toBe("stored");
    expect(keySource(JEV)).toBeNull();
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
  });

  test("the file is readable by its owner only", () => {
    storeApiKey(FIREWORKS, SECRET);
    expect(mode(file)).toBe(0o600);
  });

  test("a file that was world-readable is tightened on the next write", () => {
    fs.writeFileSync(file, JSON.stringify({ [JEV]: "ts-old" }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    storeApiKey(FIREWORKS, SECRET);
    expect(mode(file)).toBe(0o600);
    expect(onDisk()).toEqual({ [JEV]: "ts-old", [FIREWORKS]: SECRET });
  });

  test("a missing data directory is created owner-only", () => {
    const nested = path.join(dir, "data", "reygent");
    process.env[SECRETS_ENV_VAR] = path.join(nested, "secrets.json");
    storeApiKey(FIREWORKS, SECRET);
    expect(mode(nested)).toBe(0o700);
    expect(mode(path.join(nested, "secrets.json"))).toBe(0o600);
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
  });

  test("surrounding whitespace is trimmed, as when a key is pasted", () => {
    storeApiKey(FIREWORKS, `  ${SECRET}\n`);
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
  });

  test("the write is atomic: no temporary file is left behind", () => {
    storeApiKey(FIREWORKS, SECRET);
    storeApiKey(JEV, "ts-secret");
    expect(fs.readdirSync(dir)).toEqual(["secrets.json"]);
  });

  test("keys for different providers are kept side by side", () => {
    storeApiKey(FIREWORKS, SECRET);
    storeApiKey(JEV, "ts-secret");
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
    expect(resolveApiKey(JEV)).toBe("ts-secret");
  });

  test("storing again replaces the previous key", () => {
    storeApiKey(FIREWORKS, "first");
    storeApiKey(FIREWORKS, "second");
    expect(resolveApiKey(FIREWORKS)).toBe("second");
    expect(onDisk()).toEqual({ [FIREWORKS]: "second" });
  });

  test("a key of the maximum length is accepted", () => {
    const longest = "k".repeat(512);
    storeApiKey(FIREWORKS, longest);
    expect(resolveApiKey(FIREWORKS)).toBe(longest);
  });
});

describe("rejected keys", () => {
  test.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["only a newline", "\n"],
    ["two words", "two words"],
    ["a tab inside", "fw-abc\tdef"],
    ["a line break inside", "fw-abc\ndef"],
    ["a non-breaking space inside", "fw-abc\u00a0def"],
    ["more than 512 characters", "k".repeat(513)],
  ])("%s is not a key", (_label, value) => {
    expect(() => storeApiKey(FIREWORKS, value)).toThrow("API key must be a single non-empty token");
    expect(fs.existsSync(file)).toBe(false);
    expect(resolveApiKey(FIREWORKS)).toBeNull();
  });

  test("a rejected key leaves the stored one in place", () => {
    storeApiKey(FIREWORKS, SECRET);
    const before = fs.readFileSync(file);
    expect(() => storeApiKey(FIREWORKS, "two words")).toThrow();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
  });
});

describe("the environment", () => {
  test("an environment variable takes precedence over a stored key", () => {
    storeApiKey(JEV, "stored-key");
    process.env[JEV] = "env-key";
    expect(resolveApiKey(JEV)).toBe("env-key");
    expect(keySource(JEV)).toBe("environment");

    delete process.env[JEV];
    expect(resolveApiKey(JEV)).toBe("stored-key");
    expect(keySource(JEV)).toBe("stored");
  });

  test("an environment key needs no secrets file", () => {
    process.env[JEV] = "env-key";
    expect(resolveApiKey(JEV)).toBe("env-key");
    expect(keySource(JEV)).toBe("environment");
    expect(fs.existsSync(file)).toBe(false);
  });

  test("an empty environment variable does not hide a stored key", () => {
    storeApiKey(JEV, "stored-key");
    process.env[JEV] = "";
    expect(resolveApiKey(JEV)).toBe("stored-key");
    expect(keySource(JEV)).toBe("stored");
  });

  test("storing a key never changes the environment", () => {
    storeApiKey(JEV, "stored-key");
    expect(process.env[JEV]).toBeUndefined();
  });
});

describe("removing a key", () => {
  test("a removed key is gone and the others stay", () => {
    storeApiKey(FIREWORKS, SECRET);
    storeApiKey(JEV, "ts-secret");

    deleteApiKey(JEV);

    expect(resolveApiKey(JEV)).toBeNull();
    expect(keySource(JEV)).toBeNull();
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
    expect(mode(file)).toBe(0o600);
  });

  test("removing a key that was never stored does nothing", () => {
    deleteApiKey(JEV);
    expect(fs.existsSync(file)).toBe(false);

    storeApiKey(FIREWORKS, SECRET);
    const before = fs.statSync(file);
    deleteApiKey(JEV);
    const after = fs.statSync(file);
    expect(after.ino).toBe(before.ino); // not rewritten
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
  });

  test("removing a stored key does not remove the one in the environment", () => {
    storeApiKey(JEV, "stored-key");
    process.env[JEV] = "env-key";
    deleteApiKey(JEV);
    expect(resolveApiKey(JEV)).toBe("env-key");
    delete process.env[JEV];
    expect(resolveApiKey(JEV)).toBeNull();
  });
});

describe("a damaged secrets file", () => {
  test.each([
    ["truncated JSON", '{"REYGENT_TEST_FIREWORKS_API_KEY": "fw-'],
    ["not JSON at all", "these are not the keys you are looking for"],
    ["an empty file", ""],
    ["a JSON array", '["fw-secret"]'],
    ["a JSON string", '"fw-secret"'],
    ["a JSON number", "42"],
    ["JSON null", "null"],
  ])("%s is treated as no keys, and can be written over", (_label, content) => {
    fs.writeFileSync(file, content);

    expect(resolveApiKey(FIREWORKS)).toBeNull();
    expect(keySource(FIREWORKS)).toBeNull();
    expect(() => deleteApiKey(FIREWORKS)).not.toThrow();

    storeApiKey(FIREWORKS, SECRET);
    expect(resolveApiKey(FIREWORKS)).toBe(SECRET);
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
    expect(mode(file)).toBe(0o600);
  });

  test("values that are not strings are ignored and dropped on the next write", () => {
    fs.writeFileSync(file, JSON.stringify({ [FIREWORKS]: 12345, [JEV]: "ts-secret", other: { nested: true }, empty: "" }));

    expect(resolveApiKey(FIREWORKS)).toBeNull();
    expect(keySource(FIREWORKS)).toBeNull();
    expect(resolveApiKey(JEV)).toBe("ts-secret");
    expect(resolveApiKey("empty")).toBeNull();
    expect(keySource("empty")).toBeNull();

    storeApiKey(FIREWORKS, SECRET);
    expect(onDisk()).toEqual({ [FIREWORKS]: SECRET, [JEV]: "ts-secret", empty: "" });
  });

  test("a directory where the file should be is tolerated when reading", () => {
    fs.mkdirSync(file);
    expect(resolveApiKey(FIREWORKS)).toBeNull();
    expect(keySource(FIREWORKS)).toBeNull();
  });
});

describe("key names", () => {
  test.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
    "%s is just a name with no key behind it",
    (name) => {
      // Neither process.env nor the parsed file may answer with something inherited
      // from Object.prototype (process.env.constructor is a function, not a key).
      expect(resolveApiKey(name)).toBeNull();
      expect(keySource(name)).toBeNull();

      storeApiKey(FIREWORKS, SECRET);
      expect(resolveApiKey(name)).toBeNull();
      expect(keySource(name)).toBeNull();
      const before = fs.statSync(file).ino;
      deleteApiKey(name);
      expect(fs.statSync(file).ino).toBe(before);
      expect(onDisk()).toEqual({ [FIREWORKS]: SECRET });
    },
  );
});
