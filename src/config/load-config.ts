/**
 * Load typhex config from file or discover in cwd.
 * Resolution: explicit path > typhex.config.js > typhex.config.mjs > typhex.config.json
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import type { TyphexConfig } from "./types.js";
import { loadTyphexEnv, envToConfig } from "./load-env.js";
import { DEFAULT_CONFIG } from "./types.js";

const CONFIG_NAMES = ["typhex.config.js", "typhex.config.mjs", "typhex.config.json"];

function findConfigDir(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 20; i++) {
    for (const name of CONFIG_NAMES) {
      if (existsSync(join(dir, name))) return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadConfigFile(filePath: string): Promise<Partial<TyphexConfig>> {
  const url = pathToFileURL(filePath).href;
  let mod;
  if (filePath.endsWith(".json")) {
    const content = readFileSync(filePath, "utf-8");
    mod =  JSON.parse(content) ;
  } else {
    mod = await import(url);
  }
  return {
    dialect: mod.dialect,
    database: mod.database,
    url: mod.url,
    migrationsFolder: mod.migrationsFolder,
    entities: mod.entities,
  };
}

export interface LoadConfigOptions {
  /** Explicit config file path */
  configPath?: string;
  /** Working directory for discovery */
  cwd?: string;
  /** Overrides (e.g. from CLI args) */
  overrides?: Partial<TyphexConfig>;
}

/**
 * Load and merge config. Order: overrides > config file > .env > defaults.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<TyphexConfig> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Load .env into process.env-style and get env-based config
  const envVars = loadTyphexEnv(cwd);
  const envConfig = envToConfig(envVars);

  // 2. Load config file
  let fileConfig: Partial<TyphexConfig> = {};
  if (options.configPath) {
    const resolved = resolve(cwd, options.configPath);
    if (existsSync(resolved)) {
      fileConfig = await loadConfigFile(resolved);
    }
  } else {
    const configDir = findConfigDir(cwd);
    if (configDir) {
      for (const name of CONFIG_NAMES) {
        const p = join(configDir, name);
        if (existsSync(p)) {
          fileConfig = await loadConfigFile(p);
          break;
        }
      }
    }
  }

  // 3. Merge: defaults < env < file < overrides
  const merged: TyphexConfig = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...fileConfig,
    ...options.overrides,
  } as TyphexConfig;

  if (!merged.dialect) merged.dialect = "sqlite";
  if (!merged.migrationsFolder) merged.migrationsFolder = "./migrations";

  return merged;
}
