// Search services entry point

// Export hybrid search engine
export {
  HybridSearchEngine,
  type HybridSearchResult,
  type KeywordSearchResult,
  type SearchStrategy,
  type HybridSearchConfig,
  DEFAULT_HYBRID_CONFIG,
} from './hybrid-search-engine.js';

// RRF (Reciprocal Rank Fusion) algorithm constants
export const RRF_CONSTANTS = {
  DEFAULT_K: 60,        // Standard RRF constant
  MIN_K: 1,            // Minimum K value
  MAX_K: 1000,         // Maximum K value
} as const;

// Search mode constants
export const SEARCH_MODES = {
  KEYWORD: 'keyword',
  SEMANTIC: 'semantic', 
  HYBRID: 'hybrid',
} as const;

// Default search thresholds
export const SEARCH_THRESHOLDS = {
  SEMANTIC_SIMILARITY: 0.7,  // Minimum similarity for semantic search
  KEYWORD_RELEVANCE: 0.1,    // Minimum relevance for keyword search
  HYBRID_CONFIDENCE: 0.3,    // Minimum confidence for hybrid results
} as const;

// Search weights for hybrid mode
export const SEARCH_WEIGHTS = {
  KEYWORD_DEFAULT: 0.4,      // Default weight for keyword search
  SEMANTIC_DEFAULT: 0.6,     // Default weight for semantic search
  BALANCED: 0.5,             // Balanced weight for both strategies
} as const;