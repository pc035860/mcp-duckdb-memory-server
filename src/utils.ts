export const extractError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      message: error.message,
    };
  } else {
    return {
      message: "Unknown error",
    };
  }
};

/**
 * DuckDB Timestamp Value interface for type safety
 */
export interface DuckDBTimestampValue {
  micros: bigint;
  toString(): string;
  toParts(): {
    date: { year: number; month: number; day: number };
    time: { hour: number; min: number; sec: number; micros: number };
  };
}

/**
 * Type guard to check if value is a DuckDBTimestampValue
 */
export function isDuckDBTimestampValue(value: unknown): value is DuckDBTimestampValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    'micros' in value &&
    typeof (value as any).micros === 'bigint' &&
    'toString' in value &&
    typeof (value as any).toString === 'function' &&
    'toParts' in value &&
    typeof (value as any).toParts === 'function'
  );
}

/**
 * Convert various timestamp formats to ISO string with robust error handling
 * 
 * Handles:
 * - DuckDBTimestampValue objects (with micros property)
 * - JavaScript Date objects
 * - ISO string timestamps
 * - null/undefined values
 * - Invalid timestamp values
 * - Precision loss prevention
 * 
 * @param timestamp - The timestamp value to convert
 * @param fallbackToCurrentTime - Whether to use current time for null/invalid values
 * @returns ISO string timestamp or null for invalid inputs
 */
export function convertTimestampToISO(
  timestamp: unknown,
  fallbackToCurrentTime: boolean = false
): string | null {
  try {
    // Handle null/undefined
    if (timestamp === null || timestamp === undefined) {
      return fallbackToCurrentTime ? new Date().toISOString() : null;
    }

    // Handle DuckDBTimestampValue objects
    if (isDuckDBTimestampValue(timestamp)) {
      // Convert bigint microseconds to milliseconds for JavaScript Date
      // Use Number() conversion with precision check
      const microseconds = timestamp.micros;
      const milliseconds = Number(microseconds / 1000n);
      
      // Check for precision loss or overflow
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        console.warn(`DuckDB timestamp conversion warning: potential precision loss or invalid value`, { microseconds });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      const date = new Date(milliseconds);
      
      // Validate the created date
      if (isNaN(date.getTime())) {
        console.warn(`DuckDB timestamp conversion failed: invalid date created`, { microseconds, milliseconds });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      return date.toISOString();
    }

    // Handle JavaScript Date objects
    if (timestamp instanceof Date) {
      if (isNaN(timestamp.getTime())) {
        console.warn(`Invalid Date object detected`, { timestamp });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      return timestamp.toISOString();
    }

    // Handle string values (ISO timestamps, etc.)
    if (typeof timestamp === 'string') {
      // Check for obvious invalid strings
      if (timestamp.trim() === '') {
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        console.warn(`String timestamp conversion failed`, { timestamp });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      // Check for the infamous 1970-01-01 issue
      if (date.getFullYear() === 1970 && date.getMonth() === 0 && date.getDate() === 1) {
        console.warn(`Detected 1970 timestamp, likely a conversion error`, { originalTimestamp: timestamp });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      return date.toISOString();
    }

    // Handle number values (Unix timestamps in ms or s)
    if (typeof timestamp === 'number') {
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        console.warn(`Invalid numeric timestamp`, { timestamp });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      // Detect if it's seconds or milliseconds (heuristic: assume seconds if < 1e10)
      const milliseconds = timestamp < 1e10 ? timestamp * 1000 : timestamp;
      const date = new Date(milliseconds);
      
      if (isNaN(date.getTime())) {
        console.warn(`Numeric timestamp conversion failed`, { timestamp, milliseconds });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      return date.toISOString();
    }

    // Handle bigint values (microseconds)
    if (typeof timestamp === 'bigint') {
      const milliseconds = Number(timestamp / 1000n);
      
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        console.warn(`BigInt timestamp conversion warning`, { timestamp });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      const date = new Date(milliseconds);
      if (isNaN(date.getTime())) {
        console.warn(`BigInt timestamp conversion failed`, { timestamp, milliseconds });
        return fallbackToCurrentTime ? new Date().toISOString() : null;
      }
      
      return date.toISOString();
    }

    // Unsupported type
    console.warn(`Unsupported timestamp type: ${typeof timestamp}`, { timestamp });
    return fallbackToCurrentTime ? new Date().toISOString() : null;
    
  } catch (error) {
    console.error(`Timestamp conversion error:`, error, { timestamp });
    return fallbackToCurrentTime ? new Date().toISOString() : null;
  }
}

/**
 * Safely convert timestamp with fallback to current time
 * Useful for required timestamp fields
 */
export function convertTimestampToISOWithFallback(timestamp: unknown): string {
  return convertTimestampToISO(timestamp, true) || new Date().toISOString();
}

/**
 * Extract timestamp parts from DuckDBTimestampValue for advanced manipulation
 */
export function extractTimestampParts(timestamp: unknown): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
} | null {
  try {
    if (isDuckDBTimestampValue(timestamp)) {
      const parts = timestamp.toParts();
      return {
        year: parts.date.year,
        month: parts.date.month,
        day: parts.date.day,
        hour: parts.time.hour,
        minute: parts.time.min,
        second: parts.time.sec,
        microsecond: parts.time.micros,
      };
    }
    
    // Fallback to JavaScript Date for other types
    const isoString = convertTimestampToISO(timestamp);
    if (!isoString) return null;
    
    const date = new Date(isoString);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1, // JavaScript months are 0-based
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      microsecond: date.getUTCMilliseconds() * 1000, // Convert ms to μs
    };
  } catch (error) {
    console.error(`Timestamp parts extraction error:`, error, { timestamp });
    return null;
  }
}

/**
 * Performance-optimized timestamp converter with caching
 * Use for high-frequency conversions
 */
class TimestampConverter {
  private static conversionCache = new Map<string, string>();
  private static maxCacheSize = 1000;
  
  static convertWithCache(timestamp: unknown): string | null {
    // Generate cache key
    const cacheKey = this.generateCacheKey(timestamp);
    
    // Check cache first
    if (this.conversionCache.has(cacheKey)) {
      return this.conversionCache.get(cacheKey)!;
    }
    
    // Convert and cache result
    const result = convertTimestampToISO(timestamp);
    
    if (result && this.conversionCache.size < this.maxCacheSize) {
      this.conversionCache.set(cacheKey, result);
    }
    
    return result;
  }
  
  private static generateCacheKey(timestamp: unknown): string {
    if (isDuckDBTimestampValue(timestamp)) {
      return `duckdb:${timestamp.micros.toString()}`;
    }
    if (timestamp instanceof Date) {
      return `date:${timestamp.getTime()}`;
    }
    return `other:${String(timestamp)}`;
  }
  
  static clearCache(): void {
    this.conversionCache.clear();
  }
}

export { TimestampConverter };