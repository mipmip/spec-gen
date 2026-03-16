/**
 * MCP handler tests — analysis.ts
 *
 * Tests the read-from-cache / static-transform handlers without running the
 * heavy analysis pipeline or making real LLM calls.
 *
 * Strategy:
 *  - Mock validateDirectory to return the temp dir directly.
 *  - Write real JSON fixture files to a temp dir so readFile / stat work
 *    against the same code path used in production.
 *  - Mock runAnalysis (used by handleAnalyzeCodebase) to avoid executing the
 *    full analysis pipeline in unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_MAPPING,
} from '../../../constants.js';

// ============================================================================
// MODULE MOCKS
// ============================================================================

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
  isCacheFresh: vi.fn(async () => false),
}));

vi.mock('../../../cli/commands/analyze.js', () => ({
  runAnalysis: vi.fn(),
}));

// ============================================================================
// HELPERS
// ============================================================================

async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spec-gen-analysis-test-'));
}

async function writeAnalysisFile(rootPath: string, filename: string, content: unknown): Promise<void> {
  const dir = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), JSON.stringify(content), 'utf-8');
}

function makeMinimalDepGraph() {
  return {
    nodes: [], edges: [], clusters: [], structuralClusters: [], cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: { nodeCount: 5, edgeCount: 3, importEdgeCount: 2, httpEdgeCount: 1, avgDegree: 1, density: 0.1, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
  };
}

function makeMinimalLLMContext() {
  return {
    phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
  };
}

// ============================================================================
// handleGetArchitectureOverview
// ============================================================================

describe('handleGetArchitectureOverview', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    readCachedContext.mockResolvedValue(null);
  });

  it('returns error when no dep graph and no cached context', async () => {
    // no files written → readFile will throw ENOENT, readCachedContext returns null
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns overview when dep graph exists (no ctx)', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, makeMinimalDepGraph());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('clusters');
    expect(result).toHaveProperty('globalEntryPoints');
    expect(result).toHaveProperty('criticalHubs');
  });

  it('returns overview when only cached context exists (no dep graph)', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
  });

  it('summary totalFiles matches dep graph nodeCount', async () => {
    const graph = makeMinimalDepGraph();
    graph.statistics.nodeCount = 42;
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, graph);
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { summary: { totalFiles: number } };
    expect(result.summary.totalFiles).toBe(42);
  });
});

// ============================================================================
// handleGetRefactorReport
// ============================================================================

describe('handleGetRefactorReport', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns error when cached context has no callGraph', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('Call graph not available');
  });

  it('returns refactor report when callGraph is present', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
      },
    });
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as Record<string, unknown>;
    // analyzeForRefactoring returns an object with a priorities array
    expect(result).toHaveProperty('priorities');
    expect(Array.isArray(result.priorities)).toBe(true);
  });
});

// ============================================================================
// handleGetDuplicateReport
// ============================================================================

describe('handleGetDuplicateReport', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when duplicates.json does not exist', async () => {
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('No duplicate report found');
  });

  it('returns error when duplicates.json is malformed JSON', async () => {
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), 'not-json', 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('corrupted');
  });

  it('returns parsed duplicates report', async () => {
    const payload = { groups: [{ files: ['a.ts', 'b.ts'], similarity: 0.9 }] };
    const dir = join(tmpDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), JSON.stringify(payload), 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as typeof payload;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].similarity).toBe(0.9);
  });
});

// ============================================================================
// handleGetSignatures
// ============================================================================

describe('handleGetSignatures', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error message when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No analysis found');
  });

  it('returns error message when context has no signatures', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No signatures available');
  });

  it('returns formatted signatures when available', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(username: string): Promise<User>' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('filters signatures by filePattern', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(): void' }] },
        { path: 'src/user.ts', entries: [{ kind: 'function', name: 'getUser', signature: 'getUser(): void' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'auth');
    // Should only include auth.ts content, not user.ts
    expect(result).toContain('auth');
    // login function appears in auth.ts
    expect(result).toContain('login');
  });

  it('returns no-match message when filePattern matches nothing', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'nonexistent');
    expect(result).toContain('No files matching');
  });
});

// ============================================================================
// handleGetMapping
// ============================================================================

describe('handleGetMapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  const sampleMapping = {
    generatedAt: '2026-03-12T00:00:00.000Z',
    stats: { totalFunctions: 10, mappedFunctions: 8, orphanFunctions: 2, totalRequirements: 5, coveredRequirements: 5 },
    mappings: [
      { domain: 'auth', requirementId: 'REQ-1', functions: ['login'], coverage: 'full' },
      { domain: 'user', requirementId: 'REQ-2', functions: ['getUser'], coverage: 'partial' },
    ],
    orphanFunctions: [
      { file: 'src/util.ts', name: 'internalHelper' },
      { file: 'src/auth.ts', name: 'hashPassword' },
    ],
  };

  it('returns error when mapping.json does not exist', async () => {
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as { error: string };
    expect(result.error).toContain('No mapping found');
  });

  it('returns full mapping when no filters', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as typeof sampleMapping;
    expect(result.mappings).toHaveLength(2);
    expect(result.orphanFunctions).toHaveLength(2);
  });

  it('filters mappings by domain', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth') as { mappings: unknown[]; orphanFunctions: unknown[] };
    expect(result.mappings).toHaveLength(1);
    // When domain is filtered, orphanFunctions is empty
    expect(result.orphanFunctions).toHaveLength(0);
  });

  it('returns only orphans when orphansOnly is true', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, undefined, true) as { orphanFunctions: unknown[] };
    expect(result.orphanFunctions).toHaveLength(2);
    expect(result).not.toHaveProperty('mappings');
  });

  it('filters orphans by domain when orphansOnly and domain are set', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth', true) as { orphanFunctions: Array<{ file: string }> };
    // Only the auth.ts orphan should be included
    expect(result.orphanFunctions.every((f) => f.file.includes('auth'))).toBe(true);
  });
});

// ============================================================================
// handleGetFunctionSkeleton
// ============================================================================

describe('handleGetFunctionSkeleton', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'nonexistent.ts') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns skeleton metadata for an existing TypeScript file', async () => {
    const src = `
// This is a comment
export function add(a: number, b: number): number {
  // implementation
  const x = a + b;
  return x;
}
`.trim();
    await writeFile(join(tmpDir, 'add.ts'), src, 'utf-8');

    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'add.ts') as {
      filePath: string;
      language: string;
      originalLines: number;
      skeletonLines: number;
      reductionPct: number;
      worthIncluding: boolean;
      skeleton: string;
    };

    expect(result.filePath).toBe('add.ts');
    expect(result.language).toBe('TypeScript');
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeleton).toBeDefined();
    expect(typeof result.reductionPct).toBe('number');
    expect(typeof result.worthIncluding).toBe('boolean');
  });

  it('returns originalLines and skeletonLines as positive integers', async () => {
    await writeFile(join(tmpDir, 'sample.ts'), 'export const x = 1;\n', 'utf-8');
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'sample.ts') as { originalLines: number; skeletonLines: number };
    expect(Number.isInteger(result.originalLines)).toBe(true);
    expect(Number.isInteger(result.skeletonLines)).toBe(true);
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeletonLines).toBeGreaterThan(0);
  });
});

// ============================================================================
// handleAnalyzeCodebase — cached path only
// ============================================================================

describe('handleAnalyzeCodebase (cached path)', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;
  let isCacheFresh: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    isCacheFresh = vi.mocked(utils.isCacheFresh);
  });

  it('returns cached result when cache is fresh and has context', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 3, totalEdges: 2, avgFanIn: 0.5, avgFanOut: 0.7 },
      },
    });
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: Record<string, unknown> };
    expect(result.cached).toBe(true);
    expect(result.callGraph?.totalNodes).toBe(3);
  });

  it('returns cached: true with null callGraph when cached context has no callGraph', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: null };
    expect(result.cached).toBe(true);
    expect(result.callGraph).toBeNull();
  });

  it('bypasses cache when force=true', async () => {
    isCacheFresh.mockResolvedValue(true);
    const { runAnalysis } = await import('../../../cli/commands/analyze.js');
    const mockRunAnalysis = vi.mocked(runAnalysis);
    mockRunAnalysis.mockResolvedValue({
      repoMap: {
        summary: { totalFiles: 10, analyzedFiles: 10 },
        allFiles: [], highValueFiles: [], lowPriorityFiles: [],
      },
      depGraph: makeMinimalDepGraph(),
      artifacts: {
        repoStructure: {
          projectName: 'test', projectType: 'node', frameworks: [], architecture: { pattern: 'layered' },
          domains: [], apiEndpoints: [], dataModels: [], summary: '',
        },
        llmContext: { ...makeMinimalLLMContext(), callGraph: undefined },
      },
      duration: 0,
    } as never);

    const { handleAnalyzeCodebase } = await import('./analysis.js');
    await handleAnalyzeCodebase(tmpDir, true);
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// handleGetFunctionBody
// ============================================================================

describe('handleGetFunctionBody', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'nonexistent.ts', 'myFn') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns function body via line scan fallback when no call graph', async () => {
    const src = `export function doSomething(x: number): number {\n  return x + 1;\n}\n`;
    const srcPath = join(tmpDir, 'util.ts');
    await writeFile(srcPath, src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'util.ts', 'doSomething') as Record<string, unknown>;

    expect(result.functionName).toBe('doSomething');
    expect(result.filePath).toBe('util.ts');
    expect(typeof result.body).toBe('string');
    expect((result.body as string)).toContain('doSomething');
    expect(result.note).toContain('line scan');
  });

  it('returns error when function not found in file', async () => {
    const src = `export function otherFn() {}\n`;
    await writeFile(join(tmpDir, 'a.ts'), src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'a.ts', 'missingFn') as { error: string };
    expect(result.error).toContain('"missingFn"');
  });
});

// ============================================================================
// handleGetDecisions
// ============================================================================

describe('handleGetDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  it('returns empty decisions when decisions directory does not exist', async () => {
    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir) as { decisions: unknown[]; note: string };
    expect(result.decisions).toEqual([]);
    expect(result.note).toContain('decisions');
  });

  it('returns list of ADR files from decisions directory', async () => {
    const decisionsDir = join(tmpDir, 'openspec', 'decisions');
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(
      join(decisionsDir, 'adr-001-use-lancedb.md'),
      '# Use LanceDB\n\n**Status**: Accepted\n\nWe chose LanceDB for vector storage.',
      'utf-8'
    );

    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir) as { count: number; decisions: Array<{ filename: string; title: string; status: string }> };

    expect(result.count).toBe(1);
    expect(result.decisions[0].filename).toBe('adr-001-use-lancedb.md');
    expect(result.decisions[0].title).toBe('Use LanceDB');
    expect(result.decisions[0].status).toBe('Accepted');
  });

  it('filters decisions by query text', async () => {
    const decisionsDir = join(tmpDir, 'openspec', 'decisions');
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(join(decisionsDir, 'adr-001.md'), '# Use LanceDB\n\n**Status**: Accepted\n\nVector storage.', 'utf-8');
    await writeFile(join(decisionsDir, 'adr-002.md'), '# Use Vitest\n\n**Status**: Accepted\n\nTesting framework.', 'utf-8');

    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir, 'lancedb') as { count: number; decisions: unknown[] };

    expect(result.count).toBe(1);
    expect(result.decisions).toHaveLength(1);
  });
});
