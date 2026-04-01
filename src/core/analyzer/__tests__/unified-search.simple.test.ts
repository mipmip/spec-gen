/**
 * Simple working tests for Unified Search
 * Tests the core logic without complex mocking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildBidirectionalMapping,
  calculateCrossScore,
  determineResultType,
  extractSourceMetadata,
} from '../unified-search.js';

describe('UnifiedSearch - Core Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildBidirectionalMapping', () => {
    it('should build function to requirements mapping', () => {
      const mappings = [
        {
          domain: 'auth',
          requirement: 'ValidateToken',
          functions: [
            { file: 'src/auth/jwt.ts', name: 'validateToken' },
            { file: 'src/auth/middleware.ts', name: 'authMiddleware' },
          ],
        },
      ];

      const result = buildBidirectionalMapping(mappings);

      expect(result.functionToRequirements.size).toBe(2);
      expect(result.functionToRequirements.get('src/auth/jwt.ts::validateToken')).toEqual([
        { domain: 'auth', requirement: 'ValidateToken' },
      ]);
      expect(result.functionToRequirements.get('src/auth/middleware.ts::authMiddleware')).toEqual([
        { domain: 'auth', requirement: 'ValidateToken' },
      ]);
    });

    it('should build requirement to functions mapping', () => {
      const mappings = [
        {
          domain: 'auth',
          requirement: 'ValidateToken',
          functions: [{ file: 'src/auth/jwt.ts', name: 'validateToken' }],
        },
      ];

      const result = buildBidirectionalMapping(mappings);

      expect(result.requirementToFunctions.size).toBe(1);
      expect(result.requirementToFunctions.get('auth.validateToken')).toEqual([
        { file: 'src/auth/jwt.ts', name: 'validateToken' },
      ]);
    });

    it('should handle empty mappings', () => {
      const result = buildBidirectionalMapping([]);

      expect(result.functionToRequirements.size).toBe(0);
      expect(result.requirementToFunctions.size).toBe(0);
    });

    it('should handle mappings without functions', () => {
      const mappings = [
        {
          domain: 'auth',
          requirement: 'ValidateToken',
        },
      ];

      const result = buildBidirectionalMapping(mappings);

      expect(result.functionToRequirements.size).toBe(0);
      expect(result.requirementToFunctions.size).toBe(0);
    });
  });

  describe('calculateCrossScore', () => {
    const mockMappingIndex = {
      functionToRequirements: new Map([
        ['src/auth/jwt.ts::validateToken', [{ domain: 'auth', requirement: 'ValidateToken' }]],
      ]),
      requirementToFunctions: new Map([
        ['auth.validateToken', [{ file: 'src/auth/jwt.ts', name: 'validateToken' }]],
      ]),
    };

    const config = {
      directMappingBoost: 0.3,
      reverseMappingBoost: 0.3,
      mutualMappingBoost: 0.5,
      additionalLinkBoost: 0.1,
      maxAdditionalBoost: 0.3,
    };

    it('should apply direct mapping boost for code results', () => {
      const result = {
        record: {
          id: 'src/auth/jwt.ts::validateToken',
          name: 'validateToken',
          filePath: 'src/auth/jwt.ts',
          className: '',
          language: 'TypeScript',
          signature: '',
          docstring: '',
          fanIn: 0,
          fanOut: 0,
          isHub: false,
          isEntryPoint: false,
          text: '',
        },
        score: 0.8,
      };

      const { mappingBoost, linkedArtifacts } = calculateCrossScore(
        result as any,
        mockMappingIndex,
        config
      );

      expect(mappingBoost).toBe(0.3);
      expect(linkedArtifacts).toEqual([{ type: 'spec' as const, id: 'auth.validateToken', score: 0.8 }]);
    });

    it('should apply reverse mapping boost for spec results', () => {
      const result = {
        record: {
          id: 'auth.validateToken',
          domain: 'auth',
        },
        score: 0.7,
      };

      const { mappingBoost, linkedArtifacts } = calculateCrossScore(
        result as any,
        mockMappingIndex,
        config
      );

      expect(mappingBoost).toBe(0.3);
      expect(linkedArtifacts).toEqual([
        { type: 'code', id: 'src/auth/jwt.ts::validateToken', score: 0.7 },
      ]);
    });

    it('should handle results without mappings', () => {
      const result = {
        record: {
          id: 'src/utils/logger.ts::log',
          name: 'log',
          filePath: 'src/utils/logger.ts',
        },
        score: 0.6,
      };

      const { mappingBoost, linkedArtifacts } = calculateCrossScore(
        result as any,
        mockMappingIndex,
        config
      );

      expect(mappingBoost).toBe(0);
      expect(linkedArtifacts).toEqual([]);
    });

    it('should handle multiple links with capped boost', () => {
      const multiLinkMapping = {
        functionToRequirements: new Map([
          [
            'src/auth/jwt.ts::validateToken',
            [
              { domain: 'auth', requirement: 'ValidateToken' },
              { domain: 'auth', requirement: 'HandleAuthentication' },
            ],
          ],
        ]),
        requirementToFunctions: new Map(),
      };

      const result = {
        record: {
          id: 'src/auth/jwt.ts::validateToken',
          name: 'validateToken',
          filePath: 'src/auth/jwt.ts',
        },
        score: 0.8,
      };

      const { mappingBoost } = calculateCrossScore(result as any, multiLinkMapping, config);

      // 0.3 (base) + 0.1 (additional) = 0.4, capped at 0.3
      expect(mappingBoost).toBe(0.4);
    });
  });

  describe('determineResultType', () => {
    it('should return "both" for code results with spec links', () => {
      const result = {
        record: {
          id: 'src/auth/jwt.ts::validateToken',
          name: 'validateToken',
          filePath: 'src/auth/jwt.ts',
        },
        score: 0.8,
      };

      const linkedArtifacts = [{ type: 'spec' as const, id: 'auth:ValidateToken', score: 0.8 }];

      const resultType = determineResultType(result as any, linkedArtifacts);
      expect(resultType).toBe('both');
    });

    it('should return "both" for spec results with code links', () => {
      const result = {
        record: {
          id: 'auth:ValidateToken',
          domain: 'auth',
        },
        score: 0.7,
      };

      const linkedArtifacts = [{ type: 'code' as const, id: 'src/auth/jwt.ts::validateToken', score: 0.8 }];

      const resultType = determineResultType(result as any, linkedArtifacts);
      expect(resultType).toBe('both');
    });

    it('should return "code" for code results without links', () => {
      const result = {
        record: {
          id: 'src/utils/logger.ts::log',
          name: 'log',
          filePath: 'src/utils/logger.ts',
        },
        score: 0.6,
      };

      const linkedArtifacts: any[] = [];

      const resultType = determineResultType(result as any, linkedArtifacts);
      expect(resultType).toBe('code');
    });

    it('should return "spec" for spec results without links', () => {
      const result = {
        record: {
          id: 'utils:logging',
          domain: 'utils',
        },
        score: 0.5,
      };

      const linkedArtifacts: any[] = [];

      const resultType = determineResultType(result as any, linkedArtifacts);
      expect(resultType).toBe('spec');
    });
  });

  describe('extractSourceMetadata', () => {
    it('should extract metadata for code results', () => {
      const result = {
        record: {
          id: 'src/auth/jwt.ts::validateToken',
          name: 'validateToken',
          filePath: 'src/auth/jwt.ts',
          className: 'AuthService',
          language: 'TypeScript',
        },
        score: 0.8,
      };

      const metadata = extractSourceMetadata(result as any);

      expect(metadata).toEqual({
        filePath: 'src/auth/jwt.ts',
        functionName: 'validateToken',
        className: 'AuthService',
        language: 'TypeScript',
      });
    });

    it('should extract metadata for spec results', () => {
      const result = {
        record: {
          id: 'auth:ValidateToken',
          domain: 'auth',
          section: 'requirements',
          title: 'Requirement: ValidateToken',
        },
        score: 0.7,
      };

      const metadata = extractSourceMetadata(result as any);

      expect(metadata).toEqual({
        domain: 'auth',
        section: 'requirements',
        title: 'Requirement: ValidateToken',
      });
    });
  });
});
