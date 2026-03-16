import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyRole, deriveStrategy, buildReason, compositeScore } from './semantic.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// MOCK validateDirectory
// ============================================================================

// We mock validateDirectory so tests don't need a real .spec-gen/config.json.
// loadMappingIndex is kept as the real implementation (it gracefully returns null if file absent).
vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
  };
});

// ============================================================================
// TESTS — Pure helper functions
// ============================================================================

describe('classifyRole', () => {
  it('returns entry_point when isEntryPoint=true', () => {
    expect(classifyRole(0, 0, false, true)).toBe('entry_point');
  });
  it('returns hub when isHub=true (and not entry_point)', () => {
    expect(classifyRole(5, 5, true, false)).toBe('hub');
  });
  it('returns orchestrator when fanOut is high', () => {
    // INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD = 5 (from constants)
    expect(classifyRole(0, 10, false, false)).toBe('orchestrator');
  });
  it('returns utility when fanIn <= 1', () => {
    expect(classifyRole(1, 2, false, false)).toBe('utility');
  });
  it('returns internal otherwise', () => {
    expect(classifyRole(3, 2, false, false)).toBe('internal');
  });
});

describe('deriveStrategy', () => {
  it('maps entry_point → extend_entry_point', () => {
    expect(deriveStrategy('entry_point')).toBe('extend_entry_point');
  });
  it('maps orchestrator → add_orchestration_step', () => {
    expect(deriveStrategy('orchestrator')).toBe('add_orchestration_step');
  });
  it('maps hub → cross_cutting_hook', () => {
    expect(deriveStrategy('hub')).toBe('cross_cutting_hook');
  });
  it('maps utility → extract_shared_logic', () => {
    expect(deriveStrategy('utility')).toBe('extract_shared_logic');
  });
  it('maps internal → call_alongside', () => {
    expect(deriveStrategy('internal')).toBe('call_alongside');
  });
});

describe('buildReason', () => {
  it('mentions entry point for extend_entry_point strategy', () => {
    const r = buildReason('myFn', 'entry_point', 'extend_entry_point', 0, 0);
    expect(r).toContain('myFn');
    expect(r).toContain('entry point');
  });
  it('mentions fanOut for add_orchestration_step strategy', () => {
    const r = buildReason('orchestrate', 'orchestrator', 'add_orchestration_step', 0, 8);
    expect(r).toContain('8');
  });
  it('mentions fanIn for cross_cutting_hook strategy', () => {
    const r = buildReason('hubFn', 'hub', 'cross_cutting_hook', 12, 0);
    expect(r).toContain('12');
  });
  it('mentions shared logic for extract_shared_logic strategy', () => {
    const r = buildReason('utilFn', 'utility', 'extract_shared_logic', 0, 0);
    expect(r).toContain('utilFn');
  });
  it('falls back to default reason for call_alongside strategy', () => {
    const r = buildReason('internalFn', 'internal', 'call_alongside', 2, 2);
    expect(r).toContain('internalFn');
  });
});

describe('compositeScore', () => {
  it('returns a number between 0 and 1 for typical inputs', () => {
    const s = compositeScore(0.3, 'hub');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
  it('gives higher score to entry_point than internal at same distance', () => {
    const ep = compositeScore(0.3, 'entry_point');
    const internal = compositeScore(0.3, 'internal');
    expect(ep).toBeGreaterThan(internal);
  });
  it('clamps semantic component to 0 when distance > 1', () => {
    // distance > 1 → semantic = max(0, 1-distance) = 0, score is purely structural
    const s = compositeScore(1.5, 'utility');
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// TESTS — handleListSpecDomains
// ============================================================================

describe('handleListSpecDomains', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-semantic-test-'));
  });

  it('returns empty domains when openspec/specs/ does not exist', async () => {
    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; note?: string };
    expect(result.domains).toEqual([]);
    expect(result.note).toContain('No openspec/specs/');
  });

  it('returns the list of domains that have a spec.md', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'auth'), { recursive: true });
    await mkdir(join(specsDir, 'crawler'), { recursive: true });
    await mkdir(join(specsDir, 'empty-domain'), { recursive: true }); // no spec.md
    await writeFile(join(specsDir, 'auth', 'spec.md'), '# Auth', 'utf-8');
    await writeFile(join(specsDir, 'crawler', 'spec.md'), '# Crawler', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.domains).toContain('auth');
    expect(result.domains).toContain('crawler');
    expect(result.domains).not.toContain('empty-domain');
    expect(result.count).toBe(2);
  });

  it('returns count matching number of domains', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'billing'), { recursive: true });
    await writeFile(join(specsDir, 'billing', 'spec.md'), '# Billing', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.count).toBe(result.domains.length);
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (error paths — no LanceDB needed)
// ============================================================================

describe('handleSearchSpecs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-search-specs-test-'));
  });

  it('returns an error object when no spec index exists', async () => {
    // Mock SpecVectorIndex.exists to return false
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(false),
        build: vi.fn(),
        search: vi.fn(),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'email validation') as { error: string };
    expect(result.error).toContain('No spec index found');
    expect(result.error).toContain('--reindex-specs');
  });
});

// ============================================================================
// TESTS — handleGetSpec
// ============================================================================

describe('handleGetSpec', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-get-spec-test-'));
  });

  it('returns error when domain spec file does not exist', async () => {
    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'nonexistent') as { error: string };
    expect(result.error).toContain('"nonexistent"');
    expect(result.error).toContain('list_spec_domains');
  });

  it('returns spec content when spec.md exists', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Auth Spec\n\nThis is the auth domain.', 'utf-8');

    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'auth') as { domain: string; content: string; specFile: string };
    expect(result.domain).toBe('auth');
    expect(result.content).toContain('Auth Spec');
    expect(result.specFile).toBe('openspec/specs/auth/spec.md');
  });
});

// ============================================================================
// TESTS — handleSearchCode
// ============================================================================

describe('handleSearchCode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-search-code-'));
  });

  it('returns error when no vector index exists', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(false), search: vi.fn() },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn(), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'auth handler') as { error: string };
    expect(result.error).toContain('No vector index found');
  });

  it('returns results with bm25_fallback when embedding service unavailable', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{
          score: 0.1,
          record: { id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts', signature: 'fn doA()', docstring: '', language: 'TypeScript', fanIn: 1, fanOut: 1, isHub: false, isEntryPoint: false },
        }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'do something') as Record<string, unknown>;
    expect(result.searchMode).toBe('bm25_fallback');
    expect(result.count).toBe(1);
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// ============================================================================
// TESTS — handleSuggestInsertionPoints
// ============================================================================

describe('handleSuggestInsertionPoints', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-insertion-'));
  });

  it('returns error when no vector index exists', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(false), search: vi.fn() },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn(), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add logging') as { error: string };
    expect(result.error).toContain('No vector index found');
  });

  it('returns error when embedding service is unavailable and no config', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: vi.fn() },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add feature') as { error: string };
    expect(result.error).toContain('No embedding configuration');
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (success path with mocked embedding)
// ============================================================================

describe('handleSearchSpecs — success path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-search-specs-success-'));
  });

  it('returns error when no embedding config exists (spec index found but no embedSvc)', async () => {
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'auth') as { error: string };
    expect(result.error).toContain('No embedding configuration');
  });

  it('returns error when cfg exists but fromConfig returns null', async () => {
    // Create minimal .spec-gen/config.json so readSpecGenConfig returns a config
    await mkdir(join(tmpDir, '.spec-gen'), { recursive: true });
    await writeFile(join(tmpDir, '.spec-gen', 'config.json'), JSON.stringify({ version: '1' }), 'utf-8');

    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'auth') as { error: string };
    expect(result.error).toContain('No embedding configuration');
  });
});
