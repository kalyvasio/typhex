/**
 * Load .env file from cwd. Minimal implementation to avoid dotenv dependency.
 * Supports TYPHEX_* variables.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENV_PREFIX = "TYPHEX_";

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!key.startsWith(ENV_PREFIX)) continue;
    let value = raw;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      value = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    out[key] = value;
  }
  return out;
}

export function loadTyphexEnv(cwd = process.cwd()): Record<string, string> {
  const paths = [".env", ".env.local"];
  const out: Record<string, string> = {};
  for (const name of paths) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8");
      Object.assign(out, parseEnv(content));
    } catch {
      // ignore read errors
    }
  }
  return out;
}

const ENV_MAP: Record<string, keyof import("./types.js").TyphexConfig> = {
  TYPHEX_DIALECT: "dialect",
  TYPHEX_DATABASE: "database",
  TYPHEX_URL: "url",
  TYPHEX_MIGRATIONS_FOLDER: "migrationsFolder",
  TYPHEX_ENTITIES: "entities",
};

export function envToConfig(env: Record<string, string>): Partial<import("./types.js").TyphexConfig> {
  const config: Record<string, string> = {};
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const v = env[envKey] ?? process.env[envKey];
    if (v) config[configKey] = v;
  }
  return config as Partial<import("./types.js").TyphexConfig>;
}
