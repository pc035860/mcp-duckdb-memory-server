import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  convertTimestampToISO, 
  convertTimestampToISOWithFallback,
  extractTimestampParts,
  TimestampConverter 
} from '../src/utils';

// Mock DuckDBTimestampValue for testing
class MockDuckDBTimestampValue {
  constructor(public micros: bigint) {}
  
  toString(): string {
    return new Date(Number(this.micros / 1000n)).toISOString();
  }
  
  toParts() {
    const date = new Date(Number(this.micros / 1000n));
    return {
      date: {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      },
      time: {
        hour: date.getUTCHours(),
        min: date.getUTCMinutes(),
        sec: date.getUTCSeconds(),
        micros: date.getUTCMilliseconds() * 1000,
      },
    };
  }
}

describe('Timestamp Conversion Utils', () => {
  beforeEach(() => {
    // Clear console mock calls
    vi.clearAllMocks();
    // Clear conversion cache
    TimestampConverter.clearCache();
  });

  describe('convertTimestampToISO', () => {
    it('should handle null and undefined values', () => {
      expect(convertTimestampToISO(null)).toBe(null);
      expect(convertTimestampToISO(undefined)).toBe(null);
      expect(convertTimestampToISO(null, true)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(convertTimestampToISO(undefined, true)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should handle DuckDBTimestampValue objects', () => {
      // Create a timestamp for 2023-01-01 12:00:00 UTC
      const timestamp2023 = new Date('2023-01-01T12:00:00.000Z').getTime();
      const microSeconds = BigInt(timestamp2023 * 1000);
      const mockTimestamp = new MockDuckDBTimestampValue(microSeconds);
      
      const result = convertTimestampToISO(mockTimestamp);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should handle JavaScript Date objects', () => {
      const date = new Date('2023-01-01T12:00:00.000Z');
      const result = convertTimestampToISO(date);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should handle valid ISO string timestamps', () => {
      const isoString = '2023-01-01T12:00:00.000Z';
      const result = convertTimestampToISO(isoString);
      expect(result).toBe(isoString);
    });

    it('should detect and handle 1970 timestamp issue', () => {
      const result = convertTimestampToISO('1970-01-01T00:00:00.000Z');
      expect(result).toBe(null);
      
      const resultWithFallback = convertTimestampToISO('1970-01-01T00:00:00.000Z', true);
      expect(resultWithFallback).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(resultWithFallback).not.toBe('1970-01-01T00:00:00.000Z');
    });

    it('should handle numeric timestamps (milliseconds)', () => {
      const timestamp = new Date('2023-01-01T12:00:00.000Z').getTime();
      const result = convertTimestampToISO(timestamp);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should handle numeric timestamps (seconds)', () => {
      const timestamp = Math.floor(new Date('2023-01-01T12:00:00.000Z').getTime() / 1000);
      const result = convertTimestampToISO(timestamp);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should handle bigint timestamps (microseconds)', () => {
      const timestamp = BigInt(new Date('2023-01-01T12:00:00.000Z').getTime() * 1000);
      const result = convertTimestampToISO(timestamp);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should handle invalid inputs gracefully', () => {
      expect(convertTimestampToISO('invalid-date')).toBe(null);
      expect(convertTimestampToISO('')).toBe(null);
      expect(convertTimestampToISO(NaN)).toBe(null);
      expect(convertTimestampToISO(Infinity)).toBe(null);
      expect(convertTimestampToISO(-1)).toBe(null);
      expect(convertTimestampToISO({})).toBe(null);
    });

    it('should handle invalid Date objects', () => {
      const invalidDate = new Date('invalid');
      const result = convertTimestampToISO(invalidDate);
      expect(result).toBe(null);
    });

    it('should handle precision loss for very large bigint values', () => {
      const veryLargeBigInt = BigInt('999999999999999999999');
      const result = convertTimestampToISO(veryLargeBigInt);
      expect(result).toBe(null);
    });
  });

  describe('convertTimestampToISOWithFallback', () => {
    it('should always return a valid ISO string', () => {
      const result = convertTimestampToISOWithFallback(null);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      
      const result2 = convertTimestampToISOWithFallback('invalid');
      expect(result2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return original timestamp when valid', () => {
      const validISO = '2023-01-01T12:00:00.000Z';
      const result = convertTimestampToISOWithFallback(validISO);
      expect(result).toBe(validISO);
    });
  });

  describe('extractTimestampParts', () => {
    it('should extract parts from DuckDBTimestampValue', () => {
      const timestamp2023 = new Date('2023-06-15T14:30:45.123Z').getTime();
      const microSeconds = BigInt(timestamp2023 * 1000);
      const mockTimestamp = new MockDuckDBTimestampValue(microSeconds);
      
      const parts = extractTimestampParts(mockTimestamp);
      expect(parts).toEqual({
        year: 2023,
        month: 6,
        day: 15,
        hour: 14,
        minute: 30,
        second: 45,
        microsecond: 123000,
      });
    });

    it('should extract parts from regular timestamps', () => {
      const date = new Date('2023-06-15T14:30:45.123Z');
      const parts = extractTimestampParts(date);
      expect(parts).toEqual({
        year: 2023,
        month: 6,
        day: 15,
        hour: 14,
        minute: 30,
        second: 45,
        microsecond: 123000,
      });
    });

    it('should return null for invalid timestamps', () => {
      const parts = extractTimestampParts('invalid');
      expect(parts).toBe(null);
    });
  });

  describe('TimestampConverter', () => {
    it('should cache conversion results', () => {
      const date = new Date('2023-01-01T12:00:00.000Z');
      
      // First call
      const result1 = TimestampConverter.convertWithCache(date);
      expect(result1).toBe('2023-01-01T12:00:00.000Z');
      
      // Second call should use cache
      const result2 = TimestampConverter.convertWithCache(date);
      expect(result2).toBe('2023-01-01T12:00:00.000Z');
      expect(result1).toBe(result2);
    });

    it('should generate different cache keys for different timestamp types', () => {
      const date = new Date('2023-01-01T12:00:00.000Z');
      const timestamp = date.getTime();
      const microSeconds = BigInt(timestamp * 1000);
      const mockTimestamp = new MockDuckDBTimestampValue(microSeconds);
      
      // All should produce the same result but with different cache keys
      const result1 = TimestampConverter.convertWithCache(date);
      const result2 = TimestampConverter.convertWithCache(timestamp);
      const result3 = TimestampConverter.convertWithCache(mockTimestamp);
      
      expect(result1).toBe('2023-01-01T12:00:00.000Z');
      expect(result2).toBe('2023-01-01T12:00:00.000Z');
      expect(result3).toBe('2023-01-01T12:00:00.000Z');
    });

    it('should clear cache when requested', () => {
      const date = new Date('2023-01-01T12:00:00.000Z');
      
      // Cache a result
      TimestampConverter.convertWithCache(date);
      
      // Clear cache
      TimestampConverter.clearCache();
      
      // Next call should work normally
      const result = TimestampConverter.convertWithCache(date);
      expect(result).toBe('2023-01-01T12:00:00.000Z');
    });
  });

  describe('Error handling and logging', () => {
    it('should log warnings for suspicious conversions', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      // Test 1970 detection
      convertTimestampToISO('1970-01-01T00:00:00.000Z');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Detected 1970 timestamp'),
        expect.any(Object)
      );
      
      consoleSpy.mockRestore();
    });

    it('should log errors for conversion failures', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      convertTimestampToISO('definitely-not-a-date');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('String timestamp conversion failed'),
        expect.any(Object)
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('Edge cases and regression prevention', () => {
    it('should handle empty strings', () => {
      expect(convertTimestampToISO('')).toBe(null);
      expect(convertTimestampToISO('   ')).toBe(null);
    });

    it('should handle very old and very new dates', () => {
      // Test year 1900
      const oldDate = new Date('1900-01-01T00:00:00.000Z');
      expect(convertTimestampToISO(oldDate)).toBe('1900-01-01T00:00:00.000Z');
      
      // Test year 2100
      const futureDate = new Date('2100-12-31T23:59:59.999Z');
      expect(convertTimestampToISO(futureDate)).toBe('2100-12-31T23:59:59.999Z');
    });

    it('should handle timezone-aware timestamps', () => {
      // ISO string with timezone
      const result = convertTimestampToISO('2023-01-01T12:00:00+02:00');
      expect(result).toBe('2023-01-01T10:00:00.000Z'); // Converted to UTC
    });

    it('should handle various Date constructor inputs', () => {
      // Date from timestamp
      const date1 = new Date(1672574400000); // 2023-01-01T12:00:00.000Z
      expect(convertTimestampToISO(date1)).toBe('2023-01-01T12:00:00.000Z');
      
      // Date from string
      const date2 = new Date('2023-01-01T12:00:00.000Z');
      expect(convertTimestampToISO(date2)).toBe('2023-01-01T12:00:00.000Z');
    });
  });
});