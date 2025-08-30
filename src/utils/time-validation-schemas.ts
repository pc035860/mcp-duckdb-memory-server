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
    .describe("Optional time range filtering options"),
  searchMode: z
    .enum(['keyword', 'semantic', 'hybrid'])
    .optional()
    .describe("Search strategy: 'keyword' for traditional text search, 'semantic' for vector similarity search, 'hybrid' for combined approach (default: determined automatically)"),
  output: z
    .object({
      compact: z
        .boolean()
        .optional()
        .describe("Compact mode. When true, defaults to not loading observations for lightweight results."),
      includeObservations: z
        .boolean()
        .optional()
        .describe("Whether to load observations content for entities. Defaults to !compact."),
      maxEntities: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of entities to return (default 20)."),
      maxObservationsPerEntity: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum observations shown per entity in preview (default 3)."),
      snippetChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum characters per observation preview snippet (default 280)."),
      includeRelations: z
        .enum(['none','subset','all'])
        .optional()
        .describe("Relations output policy: none, subset (default, capped), or all."),
      maxRelations: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Maximum relations when includeRelations=subset (default 200)."),
      maxResponseChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Hard cap for total response size; triggers progressive truncation (default 50000)."),
    })
    .optional()
    .describe("Output limiting options to control response size")
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
    .describe("Optional time range filtering options"),
  output: z
    .object({
      compact: z.boolean().optional(),
      includeObservations: z.boolean().optional(),
      maxEntities: z.number().int().positive().optional(),
      maxObservationsPerEntity: z.number().int().nonnegative().optional(),
      snippetChars: z.number().int().positive().optional(),
      includeRelations: z.enum(['none','subset','all']).optional(),
      maxRelations: z.number().int().nonnegative().optional(),
      maxResponseChars: z.number().int().positive().optional(),
    })
    .optional()
    .describe("Output limiting options to control response size")
});

/**
 * Dynamic builders that inject default values from server config into descriptions.
 */
export type OutputDefaults = {
  compact: boolean;
  includeObservations: boolean;
  maxEntities: number;
  maxObservationsPerEntity: number;
  snippetChars: number;
  includeRelations: 'none' | 'subset' | 'all';
  maxRelations: number;
  maxResponseChars: number;
};

export function buildSearchNodesOptionsSchema(defaults: OutputDefaults) {
  return z.object({
    scope: z
      .string()
      .optional()
      .describe("Optional scope to filter entities, e.g., 'project' or '[project]'"),
    timeRange: TimeRangeOptionsSchema
      .optional()
      .describe("Optional time range filtering options"),
    searchMode: z
      .enum(['keyword', 'semantic', 'hybrid'])
      .optional()
      .describe("Search strategy: 'keyword' (text), 'semantic' (VSS), 'hybrid'. Omit for auto."),
    output: z
      .object({
        compact: z
          .boolean()
          .optional()
          .describe(`Compact mode (default ${defaults.compact}). When true, defaults to not loading observations.`),
        includeObservations: z
          .boolean()
          .optional()
          .describe(`Whether to load observations (default ${defaults.includeObservations} or !compact).`),
        maxEntities: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum entities (default ${defaults.maxEntities}).`),
        maxObservationsPerEntity: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(`Observations per entity in preview (default ${defaults.maxObservationsPerEntity}).`),
        snippetChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Preview snippet chars (default ${defaults.snippetChars}).`),
        includeRelations: z
          .enum(['none','subset','all'])
          .optional()
          .describe(`Relations policy (default '${defaults.includeRelations}').`),
        maxRelations: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(`Max relations when subset (default ${defaults.maxRelations}).`),
        maxResponseChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Response size cap (default ${defaults.maxResponseChars}).`),
      })
      .optional()
      .describe("Output limiting options to control response size"),
  });
}

export function buildMultiKeywordSearchOptionsSchema(defaults: OutputDefaults) {
  return z.object({
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
      .describe("Optional time range filtering options"),
    output: z
      .object({
        compact: z.boolean().optional().describe(`Compact mode (default ${defaults.compact}).`),
        includeObservations: z
          .boolean()
          .optional()
          .describe(`Whether to load observations (default ${defaults.includeObservations} or !compact).`),
        maxEntities: z.number().int().positive().optional().describe(`Maximum entities (default ${defaults.maxEntities}).`),
        maxObservationsPerEntity: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(`Observations per entity in preview (default ${defaults.maxObservationsPerEntity}).`),
        snippetChars: z.number().int().positive().optional().describe(`Preview snippet chars (default ${defaults.snippetChars}).`),
        includeRelations: z
          .enum(['none','subset','all'])
          .optional()
          .describe(`Relations policy (default '${defaults.includeRelations}').`),
        maxRelations: z.number().int().nonnegative().optional().describe(`Max relations when subset (default ${defaults.maxRelations}).`),
        maxResponseChars: z.number().int().positive().optional().describe(`Response size cap (default ${defaults.maxResponseChars}).`),
      })
      .optional()
      .describe("Output limiting options to control response size"),
  });
}