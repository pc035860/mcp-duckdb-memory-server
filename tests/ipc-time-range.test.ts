import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimeRangeOptions } from '../src/types';
import { 
  validateRequestTimeRange, 
  validateSearchNodesRequest, 
  validateSearchMultiKeywordsRequest 
} from '../src/servers/ipc/protocol';
import { validateTimeRangeOptions, isValidISO8601 } from '../src/utils/time-validation';

describe('IPC Time Range Parameter Support', () => {

  describe('Time Range Validation', () => {
    it('should validate ISO 8601 timestamps correctly', () => {
      // Valid ISO 8601 formats
      expect(isValidISO8601('2024-01-01T00:00:00Z')).toBe(true);
      expect(isValidISO8601('2024-12-31T23:59:59.999Z')).toBe(true);
      expect(isValidISO8601('2024-06-15T12:30:45+08:00')).toBe(true);

      // Invalid formats
      expect(isValidISO8601('2024-01-01')).toBe(false);
      expect(isValidISO8601('2024-01-01 00:00:00')).toBe(false);
      expect(isValidISO8601('invalid-date')).toBe(false);
      expect(isValidISO8601('')).toBe(false);
    });

    it('should validate absolute time range options', () => {
      const validOptions: TimeRangeOptions = {
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z',
        timeScope: 'entities'
      };

      const result = validateTimeRangeOptions(validOptions);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid time range logic', () => {
      const invalidOptions: TimeRangeOptions = {
        createdAfter: '2024-12-31T23:59:59Z',
        createdBefore: '2024-01-01T00:00:00Z'  // After is later than before
      };

      const result = validateTimeRangeOptions(invalidOptions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(err => err.includes('must be earlier than'))).toBe(true);
    });

    it('should validate relative time range options', () => {
      const validOptions: TimeRangeOptions = {
        lastDays: 7,
        timeScope: 'observations'
      };

      const result = validateTimeRangeOptions(validOptions);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject mixing absolute and relative time ranges', () => {
      const invalidOptions: TimeRangeOptions = {
        createdAfter: '2024-01-01T00:00:00Z',
        lastDays: 7  // Both absolute and relative specified
      };

      const result = validateTimeRangeOptions(invalidOptions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(err => err.includes('Cannot specify both'))).toBe(true);
    });

    it('should validate relative time range values', () => {
      // Invalid relative values
      const invalidOptions: TimeRangeOptions = {
        lastDays: -1  // Negative value
      };

      const result = validateTimeRangeOptions(invalidOptions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(err => err.includes('positive integer'))).toBe(true);
    });

    it('should validate timeScope values', () => {
      const invalidOptions: TimeRangeOptions = {
        lastDays: 7,
        timeScope: 'invalid' as any  // Invalid scope
      };

      const result = validateTimeRangeOptions(invalidOptions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(err => err.includes('Invalid timeScope'))).toBe(true);
    });
  });

  describe('IPC Request Validation', () => {
    it('should validate search nodes request with time range', () => {  
      const validPayload = {
        query: 'test query',
        options: {
          scope: 'project',
          timeRange: {
            createdAfter: '2024-01-01T00:00:00Z',
            createdBefore: '2024-12-31T23:59:59Z',
            timeScope: 'entities' as const
          }
        }
      };

      expect(() => validateSearchNodesRequest(validPayload)).not.toThrow();
    });

    it('should reject search nodes request with invalid time range', () => {
      const invalidPayload = {
        query: 'test query',
        options: {
          timeRange: {
            createdAfter: '2024-12-31T23:59:59Z',
            createdBefore: '2024-01-01T00:00:00Z'  // Invalid logic
          }
        }
      };

      expect(() => validateSearchNodesRequest(invalidPayload)).toThrow('must be earlier than');
    });

    it('should validate search multi keywords request with time range', () => {
      const validPayload = {
        keywords: ['test', 'keyword'],
        options: {
          mode: 'OR' as const,
          scope: 'project',
          timeRange: {
            lastDays: 30,
            timeScope: 'observations' as const
          }
        }
      };

      expect(() => validateSearchMultiKeywordsRequest(validPayload)).not.toThrow();
    });

    it('should reject search multi keywords request with invalid time range', () => {
      const invalidPayload = {
        keywords: ['test', 'keyword'],
        options: {
          timeRange: {
            lastDays: -5  // Invalid value
          }
        }
      };

      expect(() => validateSearchMultiKeywordsRequest(invalidPayload)).toThrow('positive integer');  
    });

    it('should reject empty keywords array', () => {
      const invalidPayload = {
        keywords: [],  // Empty array
        options: {}
      };

      expect(() => validateSearchMultiKeywordsRequest(invalidPayload)).toThrow('cannot be empty');
    });

    it('should reject non-string keywords', () => {
      const invalidPayload = {
        keywords: ['valid', 123, 'another'] as any,  // Mixed types
        options: {}
      };

      expect(() => validateSearchMultiKeywordsRequest(invalidPayload)).toThrow('must be strings');
    });

    it('should reject missing or invalid search query', () => {
      const invalidPayload = {
        query: '',  // Empty query
        options: {}
      };

      expect(() => validateSearchNodesRequest(invalidPayload)).toThrow('required and must be a string');
    });
  });

  describe('Time Range Options Processing', () => {
    it('should handle undefined time range gracefully', () => {
      expect(() => validateRequestTimeRange(undefined)).not.toThrow();
    });

    it('should process valid time range options', () => {
      const validTimeRange: TimeRangeOptions = {
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z',
        timeScope: 'any'
      };

      expect(() => validateRequestTimeRange(validTimeRange)).not.toThrow();
    });

    it('should throw error for invalid time range options', () => {
      const invalidTimeRange: TimeRangeOptions = {
        createdAfter: 'invalid-date'
      };

      expect(() => validateRequestTimeRange(invalidTimeRange)).toThrow('Invalid time range options');
    });
  });

  describe('JSON Serialization/Deserialization', () => {
    it('should properly serialize and deserialize time range options', () => {
      const originalTimeRange: TimeRangeOptions = {
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z',
        lastDays: undefined,  // Test undefined handling
        timeScope: 'entities'
      };

      // Simulate JSON serialization/deserialization like in IPC
      const serialized = JSON.stringify(originalTimeRange);
      const deserialized: TimeRangeOptions = JSON.parse(serialized);

      // Validate the deserialized object
      const result = validateTimeRangeOptions(deserialized);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Check that serialization preserved the data correctly
      expect(deserialized.createdAfter).toBe(originalTimeRange.createdAfter);
      expect(deserialized.createdBefore).toBe(originalTimeRange.createdBefore);
      expect(deserialized.timeScope).toBe(originalTimeRange.timeScope);
      // undefined properties should not be present after JSON round-trip
      expect(deserialized.lastDays).toBeUndefined();
    });

    it('should handle relative time range serialization', () => {
      const originalTimeRange: TimeRangeOptions = {
        lastDays: 7,
        lastHours: 12,
        lastMinutes: 30,
        timeScope: 'any'
      };

      const serialized = JSON.stringify(originalTimeRange);
      const deserialized: TimeRangeOptions = JSON.parse(serialized);

      const result = validateTimeRangeOptions(deserialized);
      expect(result.valid).toBe(true);
      expect(deserialized.lastDays).toBe(7);
      expect(deserialized.lastHours).toBe(12);
      expect(deserialized.lastMinutes).toBe(30);
    });
  });
});