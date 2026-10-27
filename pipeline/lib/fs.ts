import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown, pretty = false): number {
  mkdirSync(dirname(path), { recursive: true });
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  writeFileSync(path, text);
  return Buffer.byteLength(text);
}

export function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** `pnpm roads sandnes --refresh` -> { slugs: ["sandnes"], flags: Set{"refresh"} } */
export function parseArgs(argv: string[]): { slugs: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const slugs: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a.slice(2));
    else slugs.push(a.toLowerCase());
  }
  return { slugs, flags };
}
