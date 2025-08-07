import { z } from "zod";

/**
 * Zod schema for TimeRangeOptions used in MCP tool definitions
 */
export const TimeRangeOptionsSchema = z.object({
  // Absolute time range
  createdAfter: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp for filtering entities created after this time (e.g., '2024-01-01T00:00:00Z')"),
  createdBefore: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp for filtering entities created before this time (e.g., '2024-12-31T23:59:59Z')"),
  
  // Relative time range
  lastDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter entities created in the last N days"),
  lastHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter entities created in the last N hours"),
  lastMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter entities created in the last N minutes"),
  
  // Time range application target
  timeScope: z
    .enum(['entities', 'observations', 'relations', 'any'])
    .optional()
    .describe("Specify what timestamps to filter on: 'entities' for entity creation time, 'observations' for observation creation time, 'relations' for relation creation time, or 'any' for any timestamp")
}).refine(
  (data) => {
    // Ensure both absolute and relative time ranges are not specified together
    const hasAbsolute = data.createdAfter || data.createdBefore;
    const hasRelative = data.lastDays || data.lastHours || data.lastMinutes;
    return !(hasAbsolute && hasRelative);
  },
  {
    message: "Cannot specify both absolute time range (createdAfter/createdBefore) and relative time range (lastDays/lastHours/lastMinutes) together"
  }
);

/**
 * Zod schema for SearchNodesOptions used in MCP tool definitions
 */
export const SearchNodesOptionsSchema = z.object({
  scope: z
    .string()
    .optional()
    .describe("Optional scope to filter entities, e.g., 'project' or '[project]'"),
  timeRange: TimeRangeOptionsSchema
    .optional()
    .describe("Optional time range filtering options")
});

/**
 * Zod schema for MultiKeywordSearchOptions used in MCP tool definitions
 */
export const MultiKeywordSearchOptionsSchema = z.object({
  mode: z
    .enum(["OR", "AND"])
    .optional()
    .describe("How to combine keywords (default: OR)"),
  scope: z
    .string()
    .optional()
    .describe("Optional scope to filter entities, e.g., 'project' or '[project]'"),
  timeRange: TimeRangeOptionsSchema
    .optional()
    .describe("Optional time range filtering options")
});