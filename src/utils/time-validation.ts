import { TimeRangeOptions } from "../types";

/**
 * Validates ISO 8601 timestamp format
 * Supports formats like: 2024-01-01T00:00:00Z, 2024-01-01T00:00:00.000Z, 2024-01-01T00:00:00+08:00
 */
export function isValidISO8601(timestamp: string): boolean {
  if (!timestamp || typeof timestamp !== 'string') {
    return false;
  }

  // ISO 8601 regex pattern - more flexible to handle various formats
  const iso8601Regex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/;
  
  if (!iso8601Regex.test(timestamp)) {
    return false;
  }
  
  // Try to parse with Date to ensure it's a valid date
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      return false;
    }
    
    // Additional validation: ensure the parsed date makes sense
    // For timestamps with timezone offset, check if they represent a valid time
    return date.getFullYear() >= 1970 && date.getFullYear() <= 3000;
  } catch {
    return false;
  }
}

/**
 * Validates time range options
 */
export function validateTimeRangeOptions(options: TimeRangeOptions): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate absolute time range
  if (options.createdAfter) {
    if (!isValidISO8601(options.createdAfter)) {
      errors.push(`Invalid createdAfter format: ${options.createdAfter}. Expected ISO 8601 format.`);
    }
  }

  if (options.createdBefore) {
    if (!isValidISO8601(options.createdBefore)) {
      errors.push(`Invalid createdBefore format: ${options.createdBefore}. Expected ISO 8601 format.`);
    }
  }

  // Validate time logic (createdAfter < createdBefore)
  if (options.createdAfter && options.createdBefore) {
    try {
      const afterDate = new Date(options.createdAfter);
      const beforeDate = new Date(options.createdBefore);
      
      if (afterDate >= beforeDate) {
        errors.push(`createdAfter (${options.createdAfter}) must be earlier than createdBefore (${options.createdBefore})`);
      }
    } catch {
      // ISO validation above should catch these, but just in case
      errors.push("Failed to compare createdAfter and createdBefore dates");
    }
  }

  // Validate relative time range
  if (options.lastDays !== undefined) {
    if (!Number.isInteger(options.lastDays) || options.lastDays <= 0) {
      errors.push(`lastDays must be a positive integer, got: ${options.lastDays}`);
    }
  }

  if (options.lastHours !== undefined) {
    if (!Number.isInteger(options.lastHours) || options.lastHours <= 0) {
      errors.push(`lastHours must be a positive integer, got: ${options.lastHours}`);
    }
  }

  if (options.lastMinutes !== undefined) {
    if (!Number.isInteger(options.lastMinutes) || options.lastMinutes <= 0) {
      errors.push(`lastMinutes must be a positive integer, got: ${options.lastMinutes}`);
    }
  }

  // Validate that both absolute and relative time ranges are not specified together
  const hasAbsolute = options.createdAfter || options.createdBefore;
  const hasRelative = options.lastDays || options.lastHours || options.lastMinutes;
  
  if (hasAbsolute && hasRelative) {
    errors.push("Cannot specify both absolute time range (createdAfter/createdBefore) and relative time range (lastDays/lastHours/lastMinutes) together");
  }

  // Validate timeScope
  if (options.timeScope) {
    const validScopes = ['entities', 'observations', 'relations', 'any'];
    if (!validScopes.includes(options.timeScope)) {
      errors.push(`Invalid timeScope: ${options.timeScope}. Valid values are: ${validScopes.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Converts relative time range to absolute timestamps
 */
export function resolveRelativeTimeRange(options: TimeRangeOptions): { createdAfter?: string; createdBefore?: string } {
  if (!options.lastDays && !options.lastHours && !options.lastMinutes) {
    return {};
  }

  const now = new Date();
  let millisecondsBack = 0;

  if (options.lastDays) {
    millisecondsBack += options.lastDays * 24 * 60 * 60 * 1000;
  }
  
  if (options.lastHours) {
    millisecondsBack += options.lastHours * 60 * 60 * 1000;
  }
  
  if (options.lastMinutes) {
    millisecondsBack += options.lastMinutes * 60 * 1000;
  }

  const createdAfter = new Date(now.getTime() - millisecondsBack).toISOString();
  
  return { createdAfter, createdBefore: now.toISOString() };
}

/**
 * Normalizes time range options by resolving relative time ranges to absolute timestamps
 */
export function normalizeTimeRangeOptions(options: TimeRangeOptions): { createdAfter?: string; createdBefore?: string; timeScope?: string } {
  // If absolute time range is specified, use it directly
  if (options.createdAfter || options.createdBefore) {
    return {
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      timeScope: options.timeScope
    };
  }

  // If relative time range is specified, convert to absolute
  const resolved = resolveRelativeTimeRange(options);
  return {
    ...resolved,
    timeScope: options.timeScope
  };
}