/**
 * Tests for specGenGenerate programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { specGenGenerate } from './generate.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn(),
    readFile:  vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir:     vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../core/services/config-manager.js', () => ({
  readSpecGenConfig:  vi.fn(),
  readOpenSpecConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(),
}));

vi.mock('../core/generator/spec-pipeline.js', () => ({
  SpecGenerationPipeline: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { run: vi.fn() });
  }),
}));

vi.mock('../core/generator/openspec-format-generator.js', () => ({
  OpenSpecFormatGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateSpecs: vi.fn() });
  }),
}));

vi.mock('../core/generator/openspec-writer.js', () => ({
  OpenSpecWriter: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { writeSpecs: vi.fn() });
  }),
}));

vi.mock('../core/generator/adr-generator.js', () => ({
  ADRGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateADRs: vi.fn() });
  }),
}));

vi.mock('../core/generator/mapping-generator.js', () => ({
  MappingGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generate: vi.fn().mockResolvedValue({}) });
  }),
}));

import { readFile, access } from 'node:fs/promises';
import { readSpecGenConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockReadSpecGenConfig = vi.mocked(readSpecGenConfig);
const mockCreateLLMService = vi.mocked(createLLMService);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
const MOCK_CONFIG = {
  version: '1.0.0',
  openspecPath: './openspec',
  llm: {},
  generation: { provider: undefined, model: undefined, openaiCompatBaseUrl: undefined, skipSslVerify: false, domains: [] },
};
const MOCK_REPO_STRUCTURE = { projectType: 'nodejs', architecture: { pattern: 'layered' }, domains: [], frameworks: [], statistics: { analyzedFiles: 5, totalFiles: 5 } };
const MOCK_LLM_CONTEXT = {
  phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
  phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
  phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
};
const MOCK_PIPELINE_RESULT = {
  survey: { projectCategory: 'web-backend', frameworks: [], suggestedDomains: ['auth'] },
  entities: [], services: [], endpoints: [],
  architecture: { systemPurpose: 'test', architectureStyle: 'layered', layerMap: [], dataFlow: '', integrations: [], securityModel: '', keyDecisions: [] },
  metadata: { totalTokens: 100, estimatedCost: 0.01, duration: 1000, completedStages: [], skippedStages: [] },
};
const MOCK_WRITE_REPORT = {
  timestamp: new Date().toISOString(), openspecVersion: '1.0.0', specGenVersion: '1.0.0',
  filesWritten: ['openspec/auth/spec.md'], filesSkipped: [], filesBackedUp: [], filesMerged: [],
  configUpdated: true, validationErrors: [], warnings: [], nextSteps: [],
};
const MOCK_LLM_SERVICE = {
  completeJSON: vi.fn(),
  complete: vi.fn(),
  getTokenUsage: vi.fn().mockReturnValue({ totalTokens: 100 }),
  getCostTracking: vi.fn().mockReturnValue({ estimatedCost: 0.01 }),
  saveLogs: vi.fn().mockResolvedValue(undefined),
};

function setupMocks() {
  mockReadSpecGenConfig.mockResolvedValue(MOCK_CONFIG as ReturnType<typeof readSpecGenConfig> extends Promise<infer T> ? T : never);
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('repo-structure')) return Promise.resolve(JSON.stringify(MOCK_REPO_STRUCTURE));
    if (p.includes('llm-context')) return Promise.resolve(JSON.stringify(MOCK_LLM_CONTEXT));
    if (p.includes('dependency-graph')) return Promise.resolve(JSON.stringify({ statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 } }));
    return Promise.resolve('{}');
  });
  mockCreateLLMService.mockReturnValue(MOCK_LLM_SERVICE as ReturnType<typeof createLLMService>);

  vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { run: vi.fn().mockResolvedValue(MOCK_PIPELINE_RESULT) });
  });
  vi.mocked(OpenSpecFormatGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateSpecs: vi.fn().mockReturnValue([{ domain: 'auth', content: '# Auth' }]) });
  });
  vi.mocked(OpenSpecWriter).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { writeSpecs: vi.fn().mockResolvedValue(MOCK_WRITE_REPORT) });
  });
  vi.mocked(ADRGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateADRs: vi.fn().mockReturnValue([]) });
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ============================================================================
// TESTS
// ============================================================================

describe('specGenGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  describe('config validation', () => {
    it('throws if no spec-gen config', async () => {
      mockReadSpecGenConfig.mockResolvedValue(null as unknown as ReturnType<typeof readSpecGenConfig> extends Promise<infer T> ? T : never);
      await expect(specGenGenerate({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no analysis found', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      await expect(specGenGenerate({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no LLM API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(specGenGenerate({ rootPath: ROOT })).rejects.toThrow(/API key/i);
    });
  });

  describe('dry run', () => {
    it('returns empty report without running pipeline', async () => {
      const result = await specGenGenerate({ rootPath: ROOT, dryRun: true });

      expect(result.report.filesWritten).toHaveLength(0);
      expect(SpecGenerationPipeline).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('runs pipeline and writes specs', async () => {
      const result = await specGenGenerate({ rootPath: ROOT });

      expect(SpecGenerationPipeline).toHaveBeenCalled();
      expect(OpenSpecWriter).toHaveBeenCalled();
      expect(result.report.filesWritten).toContain('openspec/auth/spec.md');
    });

    it('returns pipeline result and duration', async () => {
      const result = await specGenGenerate({ rootPath: ROOT });

      expect(result.pipelineResult).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ADR generation', () => {
    it('generates ADRs when adr=true and pipeline has adrs', async () => {
      const pipelineResultWithADRs = {
        ...MOCK_PIPELINE_RESULT,
        adrs: [{ id: 'ADR-001', title: 'Use TypeScript', status: 'accepted' }],
      };
      vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { run: vi.fn().mockResolvedValue(pipelineResultWithADRs) });
      });
      vi.mocked(ADRGenerator).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { generateADRs: vi.fn().mockReturnValue([{ domain: 'adr', content: '# ADR' }]) });
      });

      await specGenGenerate({ rootPath: ROOT, adr: true });

      expect(ADRGenerator).toHaveBeenCalled();
    });

    it('skips ADR generation when adr=false', async () => {
      await specGenGenerate({ rootPath: ROOT, adr: false });
      expect(ADRGenerator).not.toHaveBeenCalled();
    });
  });

  describe('pipeline failure', () => {
    it('throws on pipeline error', async () => {
      vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { run: vi.fn().mockRejectedValue(new Error('LLM timeout')) });
      });

      await expect(specGenGenerate({ rootPath: ROOT })).rejects.toThrow(/LLM timeout|Pipeline/i);
    });
  });

  describe('missing llm-context.json', () => {
    it('uses empty context when llm-context.json missing', async () => {
      // access fails for llm-context.json → loadAnalysisData uses empty context
      mockAccess.mockImplementation((path) => {
        if (String(path).includes('llm-context')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });

      const result = await specGenGenerate({ rootPath: ROOT });
      expect(result.report).toBeDefined();
    });
  });
});
