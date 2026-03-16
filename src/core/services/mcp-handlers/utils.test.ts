/**
 * Tests for MCP handler shared utilities:
 *   - validateDirectory
 *   - sanitizeMcpError
 *   - readCachedContext
 *   - isCacheFresh
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateDirectory,
  sanitizeMcpError,
  readCachedContext,
  isCacheFresh,
  loadMappingIndex,
  specsForFile,
  functionsForDomain,
} from './utils.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ANALYSIS_STALE_THRESHOLD_MS,
} from '../../../constants.js';

// ============================================================================
// validateDirectory
// ============================================================================

describe('validateDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-utils-test-'));
  });

  it('resolves and returns the absolute path for an existing directory', async () => {
    const result = await validateDirectory(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('throws when the path does not exist', async () => {
    await expect(validateDirectory(join(tmpDir, 'nonexistent'))).rejects.toThrow('Directory not found');
  });

  it('throws when the path is a file, not a directory', async () => {
    const filePath = join(tmpDir, 'file.txt');
    await writeFile(filePath, 'hello', 'utf-8');
    await expect(validateDirectory(filePath)).rejects.toThrow('Not a directory');
  });

  it('throws when directory parameter is empty string', async () => {
    await expect(validateDirectory('')).rejects.toThrow('directory parameter is required');
  });

  it('resolves a relative path to absolute', async () => {
    // Use process.cwd() which is definitely a valid directory
    const result = await validateDirectory('.');
    expect(result).toBe(process.cwd());
  });
});

// ============================================================================
// sanitizeMcpError
// ============================================================================

describe('sanitizeMcpError', () => {
  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const msg = 'Failed: sk-ant-api03-AbCdEfGhIjKlMnOpQrSt-extra12345';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
    expect(sanitizeMcpError(new Error(msg))).not.toContain('sk-ant-api03-AbCdEfGhIjKlMnOpQrSt');
  });

  it('redacts OpenAI API keys (sk-...)', () => {
    const msg = 'Request failed: sk-ABCDE12345FGHIJ67890klmno';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
    expect(sanitizeMcpError(new Error(msg))).not.toContain('sk-ABCDE12345FGHIJ67890klmno');
  });

  it('redacts Bearer tokens', () => {
    const msg = 'Unauthorized: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc';
    expect(sanitizeMcpError(new Error(msg))).toContain('Bearer [REDACTED]');
  });

  it('redacts api_key values', () => {
    const msg = 'Error: api_key=supersecretkey123';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
  });

  it('does NOT redact short strings that look like keys but are too short', () => {
    // sk-ant- keys need 10+ chars after the prefix
    const msg = 'sk-ant-abc';
    const result = sanitizeMcpError(new Error(msg));
    // Short key should not trigger redaction (length < 10 after prefix)
    expect(result).not.toContain('[REDACTED]');
  });

  it('accepts plain string errors', () => {
    const result = sanitizeMcpError('plain error message');
    expect(result).toBe('plain error message');
  });

  it('accepts non-Error objects', () => {
    const result = sanitizeMcpError({ toString: () => 'object error' });
    expect(result).toContain('object error');
  });

  it('leaves messages without secrets unchanged', () => {
    const msg = 'Something went wrong with the pipeline';
    expect(sanitizeMcpError(new Error(msg))).toBe(msg);
  });
});

// ============================================================================
// readCachedContext
// ============================================================================

describe('readCachedContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-cache-test-'));
  });

  it('returns null when llm-context.json does not exist', async () => {
    const result = await readCachedContext(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when llm-context.json is malformed', async () => {
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), 'not-json', 'utf-8');
    const result = await readCachedContext(tmpDir);
    expect(result).toBeNull();
  });

  it('returns parsed LLMContext when file is valid', async () => {
    const ctx = {
      phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
    };
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
    const result = await readCachedContext(tmpDir);
    expect(result).toMatchObject({ phase1_survey: { purpose: 'survey' } });
  });
});

// ============================================================================
// isCacheFresh
// ============================================================================

describe('isCacheFresh', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-freshness-test-'));
  });

  it('returns false when llm-context.json does not exist', async () => {
    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(false);
  });

  it('returns true when llm-context.json was just written', async () => {
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), '{}', 'utf-8');
    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(true);
  });

  it('returns false when cache is older than ANALYSIS_STALE_THRESHOLD_MS', async () => {
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, ARTIFACT_LLM_CONTEXT);
    await writeFile(filePath, '{}', 'utf-8');

    // Backdate the file's mtime well beyond the threshold
    const { utimes } = await import('node:fs/promises');
    const pastTime = new Date(Date.now() - ANALYSIS_STALE_THRESHOLD_MS - 10_000);
    await utimes(filePath, pastTime, pastTime);

    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(false);
  });
});

// ============================================================================
// loadMappingIndex
// ============================================================================

describe('loadMappingIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-mapping-test-'));
  });

  it('returns null when mapping.json does not exist', async () => {
    const result = await loadMappingIndex(tmpDir);
    expect(result).toBeNull();
  });

  it('returns indexed MappingIndex when mapping.json is valid', async () => {
    const dir = join(tmpDir, '.spec-gen', 'analysis');
    await mkdir(dir, { recursive: true });
    const mappingData = {
      mappings: [
        {
          requirement: 'User auth',
          domain: 'auth',
          specFile: 'openspec/specs/auth/spec.md',
          functions: [
            { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
            { name: '*', file: 'src/auth.ts', line: 0, kind: 'wildcard', confidence: 'low' },
          ],
        },
      ],
    };
    await writeFile(join(dir, 'mapping.json'), JSON.stringify(mappingData), 'utf-8');

    const result = await loadMappingIndex(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.byDomain.has('auth')).toBe(true);
    expect(result!.byFile.has('src/auth.ts')).toBe(true);
  });

  it('returns null when mapping.json is malformed JSON', async () => {
    const dir = join(tmpDir, '.spec-gen', 'analysis');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'mapping.json'), 'not valid json', 'utf-8');
    const result = await loadMappingIndex(tmpDir);
    expect(result).toBeNull();
  });
});

// ============================================================================
// specsForFile / functionsForDomain
// ============================================================================

describe('specsForFile', () => {
  it('returns empty array when file has no mapping entries', () => {
    const index = { byFile: new Map(), byDomain: new Map(), entries: [] };
    expect(specsForFile(index, 'src/foo.ts')).toEqual([]);
  });

  it('returns spec entries for a file', () => {
    const entry = {
      requirement: 'Login',
      service: '',
      domain: 'auth',
      specFile: 'openspec/specs/auth/spec.md',
      functions: [],
    };
    const byFile = new Map([['src/auth.ts', [entry]]]);
    const index = { byFile, byDomain: new Map(), entries: [entry] };
    const specs = specsForFile(index, 'src/auth.ts');
    expect(specs).toHaveLength(1);
    expect(specs[0].domain).toBe('auth');
    expect(specs[0].requirement).toBe('Login');
  });

  it('deduplicates entries with same domain+requirement', () => {
    const entry = { requirement: 'Login', service: '', domain: 'auth', specFile: 'auth.md', functions: [] };
    const byFile = new Map([['src/auth.ts', [entry, entry]]]);
    const index = { byFile, byDomain: new Map(), entries: [entry] };
    const specs = specsForFile(index, 'src/auth.ts');
    expect(specs).toHaveLength(1);
  });
});

describe('functionsForDomain', () => {
  it('returns empty array when domain has no entries', () => {
    const index = { byFile: new Map(), byDomain: new Map(), entries: [] };
    expect(functionsForDomain(index, 'unknown')).toEqual([]);
  });

  it('returns functions for a domain, skipping wildcard entries', () => {
    const entry = {
      requirement: 'Auth flow',
      service: '',
      domain: 'auth',
      specFile: 'auth.md',
      functions: [
        { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
        { name: '*', file: 'src/auth.ts', line: 0, kind: 'wildcard', confidence: 'low' },
      ],
    };
    const byDomain = new Map([['auth', [entry]]]);
    const index = { byFile: new Map(), byDomain, entries: [entry] };
    const fns = functionsForDomain(index, 'auth');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('login');
    expect(fns[0].requirement).toBe('Auth flow');
  });
});
