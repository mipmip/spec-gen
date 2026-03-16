/**
 * LLM Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LLMService,
  MockLLMProvider,
  AnthropicProvider,
  OpenAIProvider,
  ClaudeCodeProvider,
  MistralVibeProvider,
  createMockLLMService,
  createLLMService,
  estimateTokens,
  lookupPricing,
  parseRetryAfterMs,
  type CompletionRequest,
} from './llm-service.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `llm-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================================
// TESTS
// ============================================================================

describe('LLMService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Token Estimation', () => {
    it('should estimate tokens for regular text', () => {
      const text = 'Hello, this is a simple test message.';
      const tokens = estimateTokens(text);

      // ~4 chars per token, so 38 chars ≈ 9-10 tokens
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(20);
    });

    it('should estimate more tokens for code', () => {
      const regularText = 'This is regular text without any special characters.';
      const codeText = 'function test() { return { a: 1, b: [2, 3] }; }';

      const regularTokens = estimateTokens(regularText);
      const codeTokens = estimateTokens(codeText);

      // Code should have more tokens per character due to special chars
      const regularRatio = regularText.length / regularTokens;
      const codeRatio = codeText.length / codeTokens;

      expect(codeRatio).toBeLessThan(regularRatio);
    });

    it('should handle empty string', () => {
      const tokens = estimateTokens('');
      expect(tokens).toBe(0);
    });
  });

  describe('MockLLMProvider', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      provider = new MockLLMProvider();
    });

    it('should return default response', async () => {
      const request: CompletionRequest = {
        systemPrompt: 'You are a helpful assistant.',
        userPrompt: 'Hello!',
      };

      const response = await provider.generateCompletion(request);

      expect(response.content).toBe('{"result": "mock response"}');
      expect(response.finishReason).toBe('stop');
    });

    it('should return custom response based on prompt content', async () => {
      provider.setResponse('test-keyword', '{"custom": "response"}');

      const request: CompletionRequest = {
        systemPrompt: 'System prompt',
        userPrompt: 'User prompt with test-keyword inside',
      };

      const response = await provider.generateCompletion(request);

      expect(response.content).toBe('{"custom": "response"}');
    });

    it('should track call history', async () => {
      const request1: CompletionRequest = { systemPrompt: 'A', userPrompt: 'B' };
      const request2: CompletionRequest = { systemPrompt: 'C', userPrompt: 'D' };

      await provider.generateCompletion(request1);
      await provider.generateCompletion(request2);

      expect(provider.callHistory).toHaveLength(2);
      expect(provider.callHistory[0].systemPrompt).toBe('A');
      expect(provider.callHistory[1].systemPrompt).toBe('C');
    });

    it('should simulate failures for testing', async () => {
      provider.shouldFail = true;
      provider.failCount = 2;

      const request: CompletionRequest = { systemPrompt: 'A', userPrompt: 'B' };

      // First two calls should fail
      await expect(provider.generateCompletion(request)).rejects.toThrow('Mock failure');
      await expect(provider.generateCompletion(request)).rejects.toThrow('Mock failure');

      // Third call should succeed
      const response = await provider.generateCompletion(request);
      expect(response.content).toBeDefined();
    });

    it('should reset state', async () => {
      provider.setResponse('key', 'value');
      await provider.generateCompletion({ systemPrompt: '', userPrompt: '' });

      provider.reset();

      expect(provider.callHistory).toHaveLength(0);
      expect(provider.shouldFail).toBe(false);
    });

    it('should count tokens correctly', () => {
      const text = 'Hello world';
      const tokens = provider.countTokens(text);

      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('LLMService with MockProvider', () => {
    let service: LLMService;
    let provider: MockLLMProvider;

    beforeEach(() => {
      const mock = createMockLLMService({
        logDir: join(tempDir, 'logs'),
        enableLogging: true,
      });
      service = mock.service;
      provider = mock.provider;
    });

    it('should complete a request', async () => {
      provider.setDefaultResponse('Test response');

      const response = await service.complete({
        systemPrompt: 'You are helpful.',
        userPrompt: 'Say hello.',
      });

      expect(response.content).toBe('Test response');
      expect(response.finishReason).toBe('stop');
    });

    it('should track token usage', async () => {
      await service.complete({
        systemPrompt: 'System prompt here.',
        userPrompt: 'User prompt here.',
      });

      const usage = service.getTokenUsage();

      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
      expect(usage.requests).toBe(1);
    });

    it('should track cost', async () => {
      await service.complete({
        systemPrompt: 'System prompt.',
        userPrompt: 'User prompt.',
      });

      const cost = service.getCostTracking();

      expect(cost.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(cost.currency).toBe('USD');
    });

    it('should reset tracking', async () => {
      await service.complete({
        systemPrompt: 'System prompt.',
        userPrompt: 'User prompt.',
      });

      service.resetTracking();

      const usage = service.getTokenUsage();
      expect(usage.requests).toBe(0);
      expect(usage.totalTokens).toBe(0);
    });

    it('should count tokens', () => {
      const tokens = service.countTokens('Hello world!');
      expect(tokens).toBeGreaterThan(0);
    });

    it('should get provider info', () => {
      expect(service.getProviderName()).toBe('mock');
      expect(service.getMaxContextTokens()).toBe(100000);
    });

    it('should retry on retryable errors', async () => {
      provider.shouldFail = true;
      provider.failCount = 2;

      const mock = createMockLLMService({
        maxRetries: 3,
        initialDelay: 10, // Fast retry for testing
      });

      mock.provider.shouldFail = true;
      mock.provider.failCount = 2;

      const response = await mock.service.complete({
        systemPrompt: 'A',
        userPrompt: 'B',
      });

      expect(response.content).toBeDefined();
      expect(mock.provider.callHistory).toHaveLength(3); // 2 failures + 1 success
    });

    it('should fail after max retries', async () => {
      const mock = createMockLLMService({
        maxRetries: 2,
        initialDelay: 10,
      });

      mock.provider.shouldFail = true;
      mock.provider.failCount = 10; // More than maxRetries

      await expect(mock.service.complete({
        systemPrompt: 'A',
        userPrompt: 'B',
      })).rejects.toThrow('Mock failure');
    });

    it('should throw when exceeding context limit', async () => {
      // Create a very long prompt
      const longPrompt = 'a'.repeat(500000); // Way over mock limit

      await expect(service.complete({
        systemPrompt: longPrompt,
        userPrompt: 'Short prompt',
      })).rejects.toThrow('exceeds context limit');
    });
  });

  describe('JSON Completion', () => {
    let service: LLMService;
    let provider: MockLLMProvider;

    beforeEach(() => {
      const mock = createMockLLMService();
      service = mock.service;
      provider = mock.provider;
    });

    it('should parse JSON response', async () => {
      provider.setDefaultResponse('{"name": "test", "value": 42}');

      const result = await service.completeJSON<{ name: string; value: number }>({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      });

      expect(result.name).toBe('test');
      expect(result.value).toBe(42);
    });

    it('should extract JSON from markdown code blocks', async () => {
      provider.setDefaultResponse('```json\n{"extracted": true}\n```');

      const result = await service.completeJSON<{ extracted: boolean }>({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      });

      expect(result.extracted).toBe(true);
    });

    it('should extract JSON from code blocks without language tag', async () => {
      provider.setDefaultResponse('```\n{"noTag": "value"}\n```');

      const result = await service.completeJSON<{ noTag: string }>({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      });

      expect(result.noTag).toBe('value');
    });

    it('should retry with correction on invalid JSON', async () => {
      // First call returns invalid JSON, second returns valid
      let callCount = 0;
      provider.generateCompletion = async (_request) => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '{"invalid": json}', // Invalid JSON
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            model: 'mock',
            finishReason: 'stop' as const,
          };
        }
        return {
          content: '{"valid": "json"}',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          model: 'mock',
          finishReason: 'stop' as const,
        };
      };

      const result = await service.completeJSON<{ valid: string }>({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      });

      expect(result.valid).toBe('json');
      expect(callCount).toBe(2);
    });

    it('should validate against schema', async () => {
      provider.setDefaultResponse('{"name": "test"}');

      const schema = {
        type: 'object',
        required: ['name', 'value'],
      };

      await expect(service.completeJSON({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema)).rejects.toThrow('Missing required field: value');
    });

    it('should validate array schema rejects non-array response', async () => {
      provider.setDefaultResponse('{"name": "test"}');

      const schema = {
        type: 'array',
        items: { type: 'object', required: ['name'] },
      };

      await expect(service.completeJSON({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema)).rejects.toThrow('Expected JSON array but received object');
    });

    it('should validate required fields in array items', async () => {
      provider.setDefaultResponse('[{"name": "test"}, {"other": "val"}]');

      const schema = {
        type: 'array',
        items: { type: 'object', required: ['name'] },
      };

      await expect(service.completeJSON({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema)).rejects.toThrow('Missing required field in array item: name');
    });

    it('should pass valid array through array schema validation', async () => {
      provider.setDefaultResponse('[{"name": "a"}, {"name": "b"}]');

      const schema = {
        type: 'array',
        items: { type: 'object', required: ['name'] },
      };

      const result = await service.completeJSON<Array<{ name: string }>>({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema);

      expect(result).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('should append schema to system prompt when provided', async () => {
      const calls: string[] = [];
      provider.generateCompletion = async (request) => {
        calls.push(request.systemPrompt);
        return {
          content: '[{"id": "1"}]',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          model: 'mock',
          finishReason: 'stop' as const,
        };
      };

      const schema = { type: 'array', items: { type: 'object' } };

      await service.completeJSON({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema);

      expect(calls[0]).toContain('MUST conform to this JSON Schema');
      expect(calls[0]).toContain('"type":"array"');
    });

    it('should pass jsonSchema to provider via request', async () => {
      const requests: CompletionRequest[] = [];
      provider.generateCompletion = async (request) => {
        requests.push(request);
        return {
          content: '[{"id": "1"}]',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          model: 'mock',
          finishReason: 'stop' as const,
        };
      };

      const schema = { type: 'array', items: { type: 'object' } };

      await service.completeJSON({
        systemPrompt: 'Return JSON.',
        userPrompt: 'Give me data.',
      }, schema);

      expect(requests[0].jsonSchema).toEqual(schema);
    });
  });

  describe('Logging', () => {
    it('should save logs to disk when enabled', async () => {
      const logDir = join(tempDir, 'logs');

      const { service, provider } = createMockLLMService({
        logDir,
        enableLogging: true,
      });

      provider.setDefaultResponse('Response 1');

      await service.complete({
        systemPrompt: 'System',
        userPrompt: 'User',
      });

      await service.saveLogs();

      const files = await readdir(logDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toMatch(/^llm-log-.*\.json$/);

      // Verify log content
      const logContent = JSON.parse(await readFile(join(logDir, files[0]), 'utf-8'));
      expect(logContent.summary.tokenUsage.requests).toBe(1);
      expect(logContent.requests).toHaveLength(1);
    });

    it('should redact secrets in logs', async () => {
      const logDir = join(tempDir, 'logs');

      const { service } = createMockLLMService({
        logDir,
        enableLogging: true,
      });

      await service.complete({
        systemPrompt: 'api_key="sk-12345678901234567890"',
        userPrompt: 'Password: secret123456789012345',
      });

      await service.saveLogs();

      const files = await readdir(logDir);
      const logContent = await readFile(join(logDir, files[0]), 'utf-8');

      expect(logContent).toContain('[REDACTED]');
      expect(logContent).not.toContain('sk-12345678901234567890');
    });
  });

  describe('Provider Initialization', () => {
    it('should create AnthropicProvider with correct properties', () => {
      const provider = new AnthropicProvider('test-key', 'claude-3-5-sonnet-20241022');

      expect(provider.name).toBe('anthropic');
      expect(provider.maxContextTokens).toBe(200000);
      expect(provider.maxOutputTokens).toBe(4096);
    });

    it('should create OpenAIProvider with correct properties', () => {
      const provider = new OpenAIProvider('test-key', 'gpt-4o');

      expect(provider.name).toBe('openai');
      expect(provider.maxContextTokens).toBe(128000);
      expect(provider.maxOutputTokens).toBe(4096);
    });
  });

  describe('Cost Tracking', () => {
    it('should track costs across multiple requests', async () => {
      const { service } = createMockLLMService();

      // Make multiple requests
      await service.complete({ systemPrompt: 'A', userPrompt: 'B' });
      await service.complete({ systemPrompt: 'C', userPrompt: 'D' });
      await service.complete({ systemPrompt: 'E', userPrompt: 'F' });

      const usage = service.getTokenUsage();
      const cost = service.getCostTracking();

      expect(usage.requests).toBe(3);
      expect(cost.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(cost.byProvider['mock']).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty prompts', async () => {
      const { service } = createMockLLMService();

      const response = await service.complete({
        systemPrompt: '',
        userPrompt: '',
      });

      expect(response).toBeDefined();
    });

    it('should handle very long responses', async () => {
      const { service, provider } = createMockLLMService();

      const longResponse = 'x'.repeat(10000);
      provider.setDefaultResponse(longResponse);

      const response = await service.complete({
        systemPrompt: 'System',
        userPrompt: 'User',
      });

      expect(response.content).toBe(longResponse);
    });

    it('should pass temperature and other options', async () => {
      const { service, provider } = createMockLLMService();

      await service.complete({
        systemPrompt: 'System',
        userPrompt: 'User',
        temperature: 0.7,
        maxTokens: 500,
        stopSequences: ['STOP'],
        responseFormat: 'json',
      });

      expect(provider.callHistory[0].temperature).toBe(0.7);
      expect(provider.callHistory[0].maxTokens).toBe(500);
      expect(provider.callHistory[0].stopSequences).toEqual(['STOP']);
      expect(provider.callHistory[0].responseFormat).toBe('json');
    });
  });
});

describe('Integration Tests (skipped without API keys)', () => {
  // These tests require actual API keys and should be skipped in CI
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  it.skipIf(!hasAnthropicKey)('should make real Anthropic API call', async () => {
    const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);
    const service = new LLMService(provider);

    const response = await service.complete({
      systemPrompt: 'You are a helpful assistant.',
      userPrompt: 'Say "test passed" and nothing else.',
      maxTokens: 50,
    });

    expect(response.content.toLowerCase()).toContain('test passed');
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  it.skipIf(!hasOpenAIKey)('should make real OpenAI API call', async () => {
    const provider = new OpenAIProvider(process.env.OPENAI_API_KEY!);
    const service = new LLMService(provider);

    const response = await service.complete({
      systemPrompt: 'You are a helpful assistant.',
      userPrompt: 'Say "test passed" and nothing else.',
      maxTokens: 50,
    });

    expect(response.content.toLowerCase()).toContain('test passed');
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  describe('CLI Providers', () => {
    it('should create ClaudeCode provider', () => {
      const provider = new ClaudeCodeProvider();
      
      expect(provider.name).toBe('claude-code');
      expect(provider.maxContextTokens).toBe(200_000);
    });

    it('should create MistralVibe provider', () => {
      const provider = new MistralVibeProvider();
      
      expect(provider.name).toBe('mistral-vibe');
      expect(provider.maxContextTokens).toBe(128_000);
    });

    it('should create service with claude-code provider', () => {
      const service = createLLMService({ provider: 'claude-code' });
      expect(service.getProviderName()).toBe('claude-code');
    });

    it('should create service with mistral-vibe provider', () => {
      const service = createLLMService({ provider: 'mistral-vibe' });
      expect(service.getProviderName()).toBe('mistral-vibe');
    });

    it('should support custom models for CLI providers', () => {
      const claudeProvider = new ClaudeCodeProvider('claude-sonnet');
      const mistralProvider = new MistralVibeProvider('mistral-small');

      expect(claudeProvider).toBeDefined();
      expect(mistralProvider).toBeDefined();
    });
  });
});

// ============================================================================
// lookupPricing
// ============================================================================

describe('lookupPricing', () => {
  it('returns exact match for known anthropic model', () => {
    const p = lookupPricing('anthropic', 'claude-3-haiku');
    expect(p.input).toBe(0.25);
    expect(p.output).toBe(1.25);
  });

  it('uses prefix match for versioned model IDs', () => {
    // "claude-sonnet-4-6-20251120" should match "claude-sonnet-4" prefix
    const p = lookupPricing('anthropic', 'claude-sonnet-4-6-20251120');
    expect(p.input).toBe(3.0);
    expect(p.output).toBe(15.0);
  });

  it('falls back to provider default when no match', () => {
    const p = lookupPricing('anthropic', 'unknown-model-xyz');
    expect(p.input).toBeDefined();
    expect(p.output).toBeDefined();
  });

  it('returns zero-cost for claude-code provider', () => {
    const p = lookupPricing('claude-code', 'any-model');
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });

  it('returns openai pricing for known openai model', () => {
    const p = lookupPricing('openai', 'gpt-4o-mini');
    expect(p.input).toBe(0.15);
  });

  it('falls back to anthropic table for unknown provider', () => {
    const p = lookupPricing('totally-unknown-provider', 'claude-3-haiku');
    // unknown provider → falls back to PRICING.anthropic
    expect(p).toBeDefined();
  });

  it('returns gemini pricing for gemini models', () => {
    const p = lookupPricing('gemini', 'gemini-2.0-flash');
    expect(p.input).toBe(0.1);
    expect(p.output).toBe(0.4);
  });
});

// ============================================================================
// parseRetryAfterMs
// ============================================================================

describe('parseRetryAfterMs', () => {
  it('returns undefined when body is empty and no header', () => {
    expect(parseRetryAfterMs('', null)).toBeUndefined();
  });

  it('parses numeric Retry-After header (seconds)', () => {
    const ms = parseRetryAfterMs('', '2');
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThan(3000);
  });

  it('returns undefined for zero-second Retry-After header', () => {
    expect(parseRetryAfterMs('', '0')).toBeUndefined();
  });

  it('returns undefined for non-numeric non-date Retry-After header', () => {
    expect(parseRetryAfterMs('', 'not-a-date-or-number')).toBeUndefined();
  });

  it('parses HTTP-date format Retry-After header', () => {
    const future = new Date(Date.now() + 5_000);
    const ms = parseRetryAfterMs('', future.toUTCString());
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10_000);
  });

  it('parses "Limit resets at:" in body', () => {
    const future = new Date(Date.now() + 10_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${future.getUTCFullYear()}-${pad(future.getUTCMonth()+1)}-${pad(future.getUTCDate())} ${pad(future.getUTCHours())}:${pad(future.getUTCMinutes())}:${pad(future.getUTCSeconds())} UTC`;
    const body = `Rate limit exceeded. Limit resets at: ${dateStr}`;
    const ms = parseRetryAfterMs(body);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15_000);
  });

  it('returns undefined when "Limit resets at:" is in the past', () => {
    const past = new Date(Date.now() - 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${past.getUTCFullYear()}-${pad(past.getUTCMonth()+1)}-${pad(past.getUTCDate())} ${pad(past.getUTCHours())}:${pad(past.getUTCMinutes())}:${pad(past.getUTCSeconds())} UTC`;
    const body = `Limit resets at: ${dateStr}`;
    expect(parseRetryAfterMs(body)).toBeUndefined();
  });
});
