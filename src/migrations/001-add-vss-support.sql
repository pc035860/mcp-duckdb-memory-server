-- Migration: Add VSS (Vector Similarity Search) support
-- This migration adds embedding columns and indexes for vector similarity search functionality
-- Compatible with DuckDB VSS extension

-- Add embedding columns to entities table
-- Stores vector embeddings for semantic search of entity names and types
-- Using FLOAT[1536] for OpenAI text-embedding-3-small model (1536 dimensions)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding FLOAT[1536];

-- Add embedding columns to observations table  
-- Stores vector embeddings for semantic search of observation content
-- Using FLOAT[1536] for OpenAI text-embedding-3-small model (1536 dimensions)
ALTER TABLE observations ADD COLUMN IF NOT EXISTS embedding FLOAT[1536];

-- Add embedding metadata columns for tracking and debugging
-- Tracks which embedding model was used for potential future migrations
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_model VARCHAR DEFAULT NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS embedding_model VARCHAR DEFAULT NULL;

-- Add timestamp for embedding generation (for cache invalidation and updates)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP DEFAULT NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP DEFAULT NULL;

-- Create indexes for efficient embedding operations
-- Note: Removed WHERE clauses for DuckDB WASM compatibility (partial indexes not supported)
CREATE INDEX IF NOT EXISTS idx_entities_has_embedding ON entities(name);
CREATE INDEX IF NOT EXISTS idx_observations_has_embedding ON observations(id);

-- Indexes for embedding metadata and freshness queries
CREATE INDEX IF NOT EXISTS idx_entities_embedding_model ON entities(embedding_model);
CREATE INDEX IF NOT EXISTS idx_observations_embedding_model ON observations(embedding_model);
CREATE INDEX IF NOT EXISTS idx_entities_embedding_updated ON entities(embedding_updated_at);
CREATE INDEX IF NOT EXISTS idx_observations_embedding_updated ON observations(embedding_updated_at);

-- Composite indexes for efficient VSS queries with time filtering
-- These support queries that combine semantic search with time range filtering
CREATE INDEX IF NOT EXISTS idx_entities_embedding_created ON entities(created_at, embedding_updated_at);
CREATE INDEX IF NOT EXISTS idx_observations_embedding_created ON observations(entityName, created_at, embedding_updated_at);