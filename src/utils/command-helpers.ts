/**
 * Shared utilities for CLI commands
 *
 * Functions used across multiple commands (analyze, generate, verify, drift, run)
 * are collected here to avoid duplication.
 */

import { access, readFile } from 'node:fs/promises';

/**
 * Check whether a file or directory exists at the given path.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a duration in milliseconds into a human-readable string.
 * @example formatDuration(750)    // "750ms"
 * @example formatDuration(3500)   // "3.5s"
 * @example formatDuration(125000) // "2m 5s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format an elapsed time (ms) as a human-readable age string.
 * @example formatAge(30000)    // "just now"
 * @example formatAge(300000)   // "5 minutes ago"
 * @example formatAge(7200000)  // "2 hours ago"
 */
export function formatAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

/**
 * Parse a comma-separated string into a trimmed, non-empty array of values.
 * @example parseList("auth, billing, api") // ["auth", "billing", "api"]
 */
export function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export type ProviderName = 'anthropic' | 'openai' | 'openai-compat' | 'gemini' | 'claude-code' | 'mistral-vibe';

/**
 * Resolve the LLM provider and base URL from environment variables.
 * Returns null when no key is found, allowing callers to handle the error their own way.
 *
 * Priority: ANTHROPIC_API_KEY > GEMINI_API_KEY > OPENAI_COMPAT_API_KEY > OPENAI_API_KEY
 */
export function resolveLLMProvider(specGenConfig?: {
  generation?: { provider?: string; openaiCompatBaseUrl?: string };
}): { provider: ProviderName; openaiCompatBaseUrl?: string } | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const configProvider = specGenConfig?.generation?.provider as ProviderName | undefined;

  // claude-code and mistral-vibe don't need an API key
  if (configProvider === 'claude-code' || configProvider === 'mistral-vibe') {
    return { provider: configProvider };
  }

  if (!anthropicKey && !geminiKey && !openaiCompatKey && !openaiKey) return null;

  const envProvider: ProviderName = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';

  const provider = configProvider ?? envProvider;
  const openaiCompatBaseUrl = process.env.OPENAI_COMPAT_BASE_URL
    ?? specGenConfig?.generation?.openaiCompatBaseUrl;

  return { provider, openaiCompatBaseUrl };
}

/**
 * Read and JSON-parse a file, returning null when the file does not exist.
 * Throws a descriptive error when the file exists but contains invalid JSON.
 *
 * @param filePath  Absolute path to the JSON file.
 * @param label     Human-readable label used in the error message (e.g. "repo-structure.json").
 */
export async function readJsonFile<T>(filePath: string, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    // File not found — expected, return null
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse ${label} — the file may be corrupted. Re-run spec-gen analyze to regenerate.`);
  }
}
