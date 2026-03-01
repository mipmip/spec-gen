/**
 * Tests for MCP server security helpers: validateDirectory, sanitizeMcpError.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDirectory, sanitizeMcpError } from './mcp.js';

// ============================================================================
// validateDirectory
// ============================================================================

describe('validateDirectory', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns the resolved absolute path for a valid directory', async () => {
    const result = await validateDirectory(testDir);
    expect(result).toBe(testDir);
  });

  it('resolves relative paths to absolute', async () => {
    const result = await validateDirectory('.');
    expect(result).toMatch(/^\//); // absolute
  });

  it('throws when the path does not exist', async () => {
    await expect(validateDirectory('/nonexistent/path/that/does/not/exist'))
      .rejects.toThrow('Directory not found');
  });

  it('throws when the path points to a file, not a directory', async () => {
    const filePath = join(testDir, 'afile.txt');
    await writeFile(filePath, 'content');
    await expect(validateDirectory(filePath))
      .rejects.toThrow('Not a directory');
  });

  it('throws for empty string input', async () => {
    await expect(validateDirectory('')).rejects.toThrow();
  });

  it('blocks path traversal that resolves to a file (e.g. /etc/hosts)', async () => {
    // /etc/hosts exists but is a file, not a directory
    await expect(validateDirectory('/etc/hosts')).rejects.toThrow('Not a directory');
  });
});

// ============================================================================
// sanitizeMcpError
// ============================================================================

describe('sanitizeMcpError', () => {
  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const err = new Error('Request failed: sk-ant-api03-ABCDEF1234567890abcdef1234');
    expect(sanitizeMcpError(err)).not.toContain('sk-ant-');
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('redacts OpenAI-style API keys (sk-...)', () => {
    const err = new Error('Unauthorized: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(sanitizeMcpError(err)).not.toMatch(/sk-proj-\S+/);
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const err = new Error('Auth error: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
    expect(sanitizeMcpError(err)).not.toContain('eyJhbGciO');
    expect(sanitizeMcpError(err)).toContain('Bearer [REDACTED]');
  });

  it('redacts Authorization header values', () => {
    const err = new Error('Header: Authorization: sk-secret-token-12345');
    expect(sanitizeMcpError(err)).not.toContain('sk-secret');
    expect(sanitizeMcpError(err)).toContain('Authorization: [REDACTED]');
  });

  it('redacts api_key= patterns', () => {
    const err = new Error('api_key=supersecret1234');
    expect(sanitizeMcpError(err)).not.toContain('supersecret');
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('preserves non-sensitive error messages unchanged', () => {
    const err = new Error('Directory not found: /tmp/project');
    expect(sanitizeMcpError(err)).toBe('Directory not found: /tmp/project');
  });

  it('handles non-Error thrown values', () => {
    expect(sanitizeMcpError('plain string error')).toBe('plain string error');
    expect(sanitizeMcpError(42)).toBe('42');
  });

  it('does not redact short tokens (avoids false positives on short words)', () => {
    // "sk-" with fewer than 20 chars after should not be redacted
    const err = new Error('key: sk-short');
    // sk-short has only 5 chars after "sk-", below the 20-char threshold
    expect(sanitizeMcpError(err)).toBe('key: sk-short');
  });
});

// ============================================================================
// DECISION-AID HANDLERS
//
// Les handlers ne sont pas exportés. On les teste via le cache filesystem :
// on écrit un llm-context.json dans un répertoire temporaire, puis on
// réutilise les helpers purs (buildAdjacency, bfs, computeRiskScore) en
// les dupliquant ici — sans dépendre de tree-sitter ni de runAnalysis.
// ============================================================================

import { readFile } from 'node:fs/promises';
import type { SerializedCallGraph, FunctionNode } from '../../core/analyzer/call-graph.js';

// ── Helpers de fixtures ──────────────────────────────────────────────────────

function makeNode(overrides: {
  id: string; name: string; filePath: string;
  fanIn?: number; fanOut?: number; className?: string; language?: string;
}): FunctionNode {
  return {
    id: overrides.id, name: overrides.name, filePath: overrides.filePath,
    className: overrides.className, isAsync: false,
    language: overrides.language ?? 'TypeScript',
    startIndex: 0, endIndex: 100,
    fanIn: overrides.fanIn ?? 0, fanOut: overrides.fanOut ?? 0,
  };
}

async function writeCacheFixture(dir: string, callGraph: object) {
  const analysisDir = join(dir, '.spec-gen', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  await writeFile(
    join(analysisDir, 'llm-context.json'),
    JSON.stringify({ callGraph, signatures: [] }),
    'utf-8'
  );
}

/**
 * Graph fixture:
 *   entry ──► hub ──► workerA
 *              │      workerB
 *              └────► util
 *   leaf   (fanIn=0, no edges — dead code candidate)
 *   util   (fanIn=2, no outgoing — pure leaf)
 */
function makeCallGraph(): SerializedCallGraph {
  const entry   = makeNode({ id: 'f1', name: 'entry',   filePath: 'src/api/entry.ts',       fanIn: 0, fanOut: 1 });
  const hub     = makeNode({ id: 'f2', name: 'hub',     filePath: 'src/services/hub.ts',    fanIn: 1, fanOut: 3 });
  const workerA = makeNode({ id: 'f3', name: 'workerA', filePath: 'src/workers/workerA.ts', fanIn: 1, fanOut: 0 });
  const workerB = makeNode({ id: 'f4', name: 'workerB', filePath: 'src/workers/workerB.ts', fanIn: 1, fanOut: 0 });
  const leaf    = makeNode({ id: 'f5', name: 'leaf',    filePath: 'src/utils/leaf.ts',      fanIn: 0, fanOut: 0 });
  const util    = makeNode({ id: 'f6', name: 'util',    filePath: 'src/utils/util.ts',      fanIn: 2, fanOut: 0 });

  return {
    nodes: [entry, hub, workerA, workerB, leaf, util],
    edges: [
      { callerId: 'f1', calleeId: 'f2', calleeName: 'hub',     line: 10 },
      { callerId: 'f2', calleeId: 'f3', calleeName: 'workerA', line: 20 },
      { callerId: 'f2', calleeId: 'f4', calleeName: 'workerB', line: 21 },
      { callerId: 'f2', calleeId: 'f6', calleeName: 'util',    line: 22 },
      { callerId: 'f1', calleeId: 'f6', calleeName: 'util',    line: 11 },
    ],
    hubFunctions:    [hub],
    entryPoints:     [entry],
    layerViolations: [],
    stats: { totalNodes: 6, totalEdges: 5, avgFanIn: 1, avgFanOut: 1 },
  };
}

// ── Réimplémentation pure des helpers (miroir exact de mcp.ts) ───────────────

function _buildAdjacency(cg: SerializedCallGraph) {
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const forward  = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const n of cg.nodes) { forward.set(n.id, new Set()); backward.set(n.id, new Set()); }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }
  return { nodeMap, forward, backward };
}

function _bfs(seeds: string[], adj: Map<string, Set<string>>, maxDepth: number): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(id => ({ id, depth: 0 }));
  for (const id of seeds) visited.set(id, 0);
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const nId of adj.get(id) ?? []) {
      if (!visited.has(nId)) { visited.set(nId, depth + 1); queue.push({ id: nId, depth: depth + 1 }); }
    }
  }
  return visited;
}

function _computeRiskScore(node: FunctionNode, blastRadius: number, isHub: boolean): number {
  const raw = (node.fanIn ?? 0) * 4 + (node.fanOut ?? 0) * 2 + (isHub ? 20 : 0) + blastRadius * 1.5;
  return Math.min(100, Math.round(raw));
}

// ── Wrappers de test (lisent le cache, appliquent la logique des handlers) ───

async function readCache(dir: string) {
  try {
    const raw = await readFile(join(dir, '.spec-gen', 'analysis', 'llm-context.json'), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function analyzeImpact(dir: string, symbol: string, depth = 2) {
  const ctx = await readCache(dir);
  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward, backward } = _buildAdjacency(cg);
  const hubIds = new Set(cg.hubFunctions.map((n: FunctionNode) => n.id));
  const seeds  = cg.nodes.filter((n: FunctionNode) => n.name.toLowerCase().includes(symbol.toLowerCase()));
  if (seeds.length === 0) return { error: `No function matching "${symbol}" found in call graph.` };
  const seedIds = seeds.map((n: FunctionNode) => n.id);
  const upMap   = _bfs(seedIds, backward, depth);
  const downMap = _bfs(seedIds, forward,  depth);
  const upNodes   = [...upMap.entries()].filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => { const n = nodeMap.get(id); return n ? { name: n.name, file: n.filePath, depth: d } : null; }).filter(Boolean);
  const downNodes = [...downMap.entries()].filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => { const n = nodeMap.get(id); return n ? { name: n.name, file: n.filePath, depth: d } : null; }).filter(Boolean);
  const blastRadius = upNodes.length + downNodes.length;
  const results = seeds.map((seed: FunctionNode) => {
    const isHub = hubIds.has(seed.id);
    const riskScore = _computeRiskScore(seed, blastRadius, isHub);
    return {
      symbol: seed.name, file: seed.filePath,
      metrics: { fanIn: seed.fanIn, fanOut: seed.fanOut, isHub },
      blastRadius: { total: blastRadius, upstream: upNodes.length, downstream: downNodes.length },
      riskScore,
      riskLevel: riskScore <= 20 ? 'low' : riskScore <= 45 ? 'medium' : riskScore <= 70 ? 'high' : 'critical',
      upstreamChain: upNodes, downstreamCriticalPath: downNodes,
    };
  });
  return seeds.length === 1 ? results[0] : { matches: results };
}

async function getLowRiskCandidates(dir: string, limit = 5, filePattern?: string) {
  const ctx = await readCache(dir);
  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg       = ctx.callGraph as SerializedCallGraph;
  const hubIds   = new Set(cg.hubFunctions.map((n: FunctionNode) => n.id));
  const entryIds = new Set(cg.entryPoints.map((n: FunctionNode) => n.id));
  let candidates = cg.nodes.filter((n: FunctionNode) =>
    (n.fanIn ?? 0) <= 2 && (n.fanOut ?? 0) <= 3 && !hubIds.has(n.id) && !entryIds.has(n.id)
  );
  if (filePattern) candidates = candidates.filter((n: FunctionNode) => n.filePath.includes(filePattern));
  candidates.sort((a: FunctionNode, b: FunctionNode) => {
    const ra = (a.fanIn ?? 0) + (a.fanOut ?? 0), rb = (b.fanIn ?? 0) + (b.fanOut ?? 0);
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });
  return {
    total: candidates.length, returned: Math.min(limit, candidates.length),
    candidates: candidates.slice(0, limit).map((n: FunctionNode) => ({
      name: n.name, file: n.filePath, fanIn: n.fanIn ?? 0, fanOut: n.fanOut ?? 0,
      riskScore: _computeRiskScore(n, 0, false),
    })),
  };
}

async function getLeafFunctions(dir: string, limit = 20, filePattern?: string, sortBy: 'fanIn' | 'name' | 'file' = 'fanIn') {
  const ctx = await readCache(dir);
  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const hasOutgoing = new Set(cg.edges.filter((e: { calleeId: string }) => e.calleeId).map((e: { callerId: string }) => e.callerId));
  let leaves = cg.nodes.filter((n: FunctionNode) => !hasOutgoing.has(n.id));
  if (filePattern) leaves = leaves.filter((n: FunctionNode) => n.filePath.includes(filePattern));
  leaves.sort((a: FunctionNode, b: FunctionNode) => {
    if (sortBy === 'fanIn') return (b.fanIn ?? 0) - (a.fanIn ?? 0);
    if (sortBy === 'name')  return a.name.localeCompare(b.name);
    return a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);
  });
  return {
    totalLeaves: leaves.length, returned: Math.min(limit, leaves.length), sortedBy: sortBy,
    leaves: leaves.slice(0, limit).map((n: FunctionNode) => ({
      name: n.name, file: n.filePath, fanIn: n.fanIn ?? 0, fanOut: 0,
      refactorAdvice: (n.fanIn ?? 0) === 0
        ? 'Unreachable or dead code — safe to delete after confirmation.'
        : 'Pure leaf: rewrite freely, then re-run tests for its callers.',
    })),
  };
}

async function getCriticalHubs(dir: string, limit = 10, minFanIn = 3) {
  const ctx = await readCache(dir);
  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map((n: FunctionNode) => [n.id, n]));
  const violatorFiles = new Set(
    cg.layerViolations.flatMap((v: { callerId: string; calleeId: string }) =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath].filter(Boolean)
    )
  );
  const hubs = cg.nodes
    .filter((n: FunctionNode) => (n.fanIn ?? 0) >= minFanIn)
    .map((n: FunctionNode) => {
      const fanIn = n.fanIn ?? 0, fanOut = n.fanOut ?? 0;
      const hasViolation = violatorFiles.has(n.filePath);
      const criticality  = fanIn * 3 + fanOut * 1.5 + (hasViolation ? 10 : 0);
      const stabilityScore = Math.max(0, Math.round(100 - Math.min(100, criticality)));
      let approach: string;
      if (fanIn >= 8 && fanOut >= 5)  approach = 'split responsibility';
      else if (fanIn >= 8)            approach = 'introduce façade';
      else if (fanOut >= 5)           approach = 'delegate';
      else                            approach = 'extract';
      return { name: n.name, file: n.filePath, fanIn, fanOut,
        hasLayerViolation: hasViolation,
        criticality: Math.round(criticality * 10) / 10, stabilityScore,
        riskScore: _computeRiskScore(n, fanIn + fanOut, true),
        recommendedApproach: { approach } };
    })
    .sort((a: { criticality: number }, b: { criticality: number }) => b.criticality - a.criticality)
    .slice(0, limit);
  return {
    totalHubs: cg.nodes.filter((n: FunctionNode) => (n.fanIn ?? 0) >= minFanIn).length,
    returned: hubs.length, minFanIn, hubs,
  };
}

// ============================================================================
// analyze_impact
// ============================================================================

describe('analyze_impact', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-impact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await analyzeImpact(testDir, 'hub') as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns error when symbol is not found', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'nonexistent') as { error: string };
    expect(r.error).toMatch(/No function matching/);
  });

  it('returns a single object (not matches[]) for a unique symbol', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'hub') as Record<string, unknown>;
    expect(r).not.toHaveProperty('matches');
    expect(r.symbol).toBe('hub');
  });

  it('returns matches[] when symbol matches multiple nodes', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'worker') as { matches: unknown[] };
    expect(r.matches).toHaveLength(2);
  });

  it('symbol matching is case-insensitive', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const a = await analyzeImpact(testDir, 'HUB') as { symbol: string };
    const b = await analyzeImpact(testDir, 'Hub') as { symbol: string };
    expect(a.symbol).toBe('hub');
    expect(b.symbol).toBe('hub');
  });

  it('reports correct fanIn and fanOut for hub', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'hub') as { metrics: { fanIn: number; fanOut: number } };
    expect(r.metrics.fanIn).toBe(1);
    expect(r.metrics.fanOut).toBe(3);
  });

  it('blast radius includes upstream and downstream nodes', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'hub') as { blastRadius: { total: number; upstream: number; downstream: number } };
    expect(r.blastRadius.upstream).toBe(1);   // entry
    expect(r.blastRadius.downstream).toBe(3); // workerA, workerB, util
    expect(r.blastRadius.total).toBe(4);
  });

  it('leaf node has zero blast radius', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'leaf') as { blastRadius: { total: number } };
    expect(r.blastRadius.total).toBe(0);
  });

  it('riskScore is capped at 100', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 30; cg.nodes[1].fanOut = 30;
    await writeCacheFixture(testDir, cg);
    const r = await analyzeImpact(testDir, 'hub') as { riskScore: number };
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });

  it('riskLevel is "low" for a leaf with no callers', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'leaf') as { riskLevel: string };
    expect(r.riskLevel).toBe('low');
  });

  it('riskLevel escalates to high/critical for a heavily-called hub', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 15;
    await writeCacheFixture(testDir, cg);
    const r = await analyzeImpact(testDir, 'hub') as { riskLevel: string };
    expect(['high', 'critical']).toContain(r.riskLevel);
  });

  it('depth=1 limits downstream traversal to 1 hop', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await analyzeImpact(testDir, 'entry', 1) as { downstreamCriticalPath: Array<{ name: string }> };
    const names = r.downstreamCriticalPath.map(n => n.name);
    expect(names).toContain('hub');
    expect(names).not.toContain('workerA');
  });
});

// ============================================================================
// get_low_risk_refactor_candidates
// ============================================================================

describe('get_low_risk_refactor_candidates', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-lowrisk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await getLowRiskCandidates(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('excludes hub functions', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir) as { candidates: Array<{ name: string }> };
    expect(r.candidates.map(c => c.name)).not.toContain('hub');
  });

  it('excludes entry points', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir) as { candidates: Array<{ name: string }> };
    expect(r.candidates.map(c => c.name)).not.toContain('entry');
  });

  it('all candidates have fanIn <= 2', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir) as { candidates: Array<{ fanIn: number }> };
    for (const c of r.candidates) expect(c.fanIn).toBeLessThanOrEqual(2);
  });

  it('all candidates have fanOut <= 3', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir) as { candidates: Array<{ fanOut: number }> };
    for (const c of r.candidates) expect(c.fanOut).toBeLessThanOrEqual(3);
  });

  it('respects the limit parameter', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir, 1) as { candidates: unknown[]; returned: number };
    expect(r.candidates).toHaveLength(1);
    expect(r.returned).toBe(1);
  });

  it('filters by filePattern', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir, 5, 'workers') as { candidates: Array<{ file: string }> };
    for (const c of r.candidates) expect(c.file).toContain('workers');
  });

  it('filePattern with no match returns empty candidates', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir, 5, 'no-such-path') as { candidates: unknown[]; total: number };
    expect(r.candidates).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('candidates are sorted by ascending fanIn+fanOut', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir, 10) as { candidates: Array<{ fanIn: number; fanOut: number }> };
    for (let i = 1; i < r.candidates.length; i++) {
      const prev = r.candidates[i - 1].fanIn + r.candidates[i - 1].fanOut;
      const curr = r.candidates[i].fanIn    + r.candidates[i].fanOut;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it('each candidate carries a riskScore in [0, 100]', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLowRiskCandidates(testDir) as { candidates: Array<{ riskScore: number }> };
    for (const c of r.candidates) {
      expect(c.riskScore).toBeGreaterThanOrEqual(0);
      expect(c.riskScore).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================================================
// get_leaf_functions
// ============================================================================

describe('get_leaf_functions', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-leaves-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await getLeafFunctions(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns only nodes with no outgoing edges', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir) as { leaves: Array<{ name: string }> };
    const names = r.leaves.map(l => l.name);
    expect(names).toContain('workerA');
    expect(names).toContain('workerB');
    expect(names).toContain('leaf');
    expect(names).toContain('util');
    expect(names).not.toContain('hub');
    expect(names).not.toContain('entry');
  });

  it('flags fanIn=0 leaves as dead code', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir) as { leaves: Array<{ name: string; refactorAdvice: string }> };
    expect(r.leaves.find(l => l.name === 'leaf')?.refactorAdvice).toMatch(/dead code/);
  });

  it('marks called leaves with "Pure leaf" advice', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir) as { leaves: Array<{ name: string; refactorAdvice: string }> };
    expect(r.leaves.find(l => l.name === 'util')?.refactorAdvice).toMatch(/Pure leaf/);
  });

  it('sortBy fanIn: most-called leaves first', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir, 20, undefined, 'fanIn') as { leaves: Array<{ fanIn: number }> };
    for (let i = 1; i < r.leaves.length; i++)
      expect(r.leaves[i - 1].fanIn).toBeGreaterThanOrEqual(r.leaves[i].fanIn);
  });

  it('sortBy name: alphabetical order', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir, 20, undefined, 'name') as { leaves: Array<{ name: string }> };
    const names = r.leaves.map(l => l.name);
    expect(names).toEqual([...names].sort());
  });

  it('sortBy file: grouped by file path', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir, 20, undefined, 'file') as { leaves: Array<{ file: string }> };
    const files = r.leaves.map(l => l.file);
    for (let i = 1; i < files.length; i++)
      expect(files[i].localeCompare(files[i - 1])).toBeGreaterThanOrEqual(0);
  });

  it('respects the limit parameter', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir, 2) as { leaves: unknown[]; returned: number };
    expect(r.leaves).toHaveLength(2);
    expect(r.returned).toBe(2);
  });

  it('filters by filePattern', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir, 20, 'workers') as { leaves: Array<{ file: string }> };
    for (const l of r.leaves) expect(l.file).toContain('workers');
  });

  it('totalLeaves matches actual leaf count (4 in fixture)', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getLeafFunctions(testDir) as { totalLeaves: number };
    expect(r.totalLeaves).toBe(4);
  });
});

// ============================================================================
// get_critical_hubs
// ============================================================================

describe('get_critical_hubs', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-hubs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await getCriticalHubs(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns empty list when no node meets minFanIn', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await getCriticalHubs(testDir, 10, 99) as { hubs: unknown[]; totalHubs: number };
    expect(r.hubs).toHaveLength(0);
    expect(r.totalHubs).toBe(0);
  });

  it('respects minFanIn threshold', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 5;
    await writeCacheFixture(testDir, cg);
    const with3 = await getCriticalHubs(testDir, 10, 3) as { hubs: Array<{ name: string }> };
    const with6 = await getCriticalHubs(testDir, 10, 6) as { hubs: Array<{ name: string }> };
    expect(with3.hubs.map(h => h.name)).toContain('hub');
    expect(with6.hubs.map(h => h.name)).not.toContain('hub');
  });

  it('hubs are sorted by descending criticality', async () => {
    const cg = makeCallGraph();
    cg.nodes.push(makeNode({ id: 'f7', name: 'bigHub', filePath: 'src/core/big.ts', fanIn: 10, fanOut: 8 }));
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ criticality: number }> };
    for (let i = 1; i < r.hubs.length; i++)
      expect(r.hubs[i - 1].criticality).toBeGreaterThanOrEqual(r.hubs[i].criticality);
  });

  it('respects the limit parameter', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 5;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 1, 1) as { hubs: unknown[] };
    expect(r.hubs).toHaveLength(1);
  });

  it('approach "split responsibility" when fanIn>=8 AND fanOut>=5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 8; cg.nodes[1].fanOut = 5;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ name: string; recommendedApproach: { approach: string } }> };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('split responsibility');
  });

  it('approach "introduce façade" when fanIn>=8 AND fanOut<5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 8; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ name: string; recommendedApproach: { approach: string } }> };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('introduce façade');
  });

  it('approach "delegate" when fanIn<8 AND fanOut>=5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 5;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ name: string; recommendedApproach: { approach: string } }> };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('delegate');
  });

  it('approach "extract" for moderate hub (fanIn<8, fanOut<5)', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ name: string; recommendedApproach: { approach: string } }> };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('extract');
  });

  it('criticality adds +10 for layer violation files', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    cg.layerViolations = [{ callerId: 'f2', calleeId: 'f3', callerLayer: 'api', calleeLayer: 'storage', reason: 'test' }];
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ name: string; criticality: number; hasLayerViolation: boolean }> };
    const hub = r.hubs.find(h => h.name === 'hub')!;
    expect(hub.hasLayerViolation).toBe(true);
    // 4*3 + 2*1.5 + 10 = 25
    expect(hub.criticality).toBe(25);
  });

  it('stabilityScore = max(0, round(100 - criticality))', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await getCriticalHubs(testDir, 10, 1) as { hubs: Array<{ criticality: number; stabilityScore: number }> };
    for (const h of r.hubs) {
      expect(h.stabilityScore).toBe(Math.max(0, Math.round(100 - Math.min(100, h.criticality))));
      expect(h.stabilityScore).toBeGreaterThanOrEqual(0);
      expect(h.stabilityScore).toBeLessThanOrEqual(100);
    }
  });
});
