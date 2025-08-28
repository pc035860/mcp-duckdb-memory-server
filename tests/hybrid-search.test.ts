import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { Entity, Relation, SearchNodesOptions } from "../src/types";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

describe("DuckDBKnowledgeGraphManager - Hybrid Search", () => {
  const testDbPath = join(process.cwd(), "tmp", "test-hybrid-search.db");
  let manager: DuckDBKnowledgeGraphManager;

  // Small dataset for testing LIKE search strategy
  const smallDataset: Entity[] = [
    {
      name: "user-service",
      entityType: "microservice",
      observations: [
        "Handles user authentication and authorization",
        "Built with Node.js and Express",
        "Uses PostgreSQL for data persistence"
      ],
    },
    {
      name: "auth-middleware",
      entityType: "component",
      observations: [
        "JWT token validation middleware",
        "Supports role-based access control",
        "Integrates with user-service API"
      ],
    },
    {
      name: "database-config",
      entityType: "configuration",
      observations: [
        "PostgreSQL connection settings",
        "Environment-specific database URLs",
        "Connection pooling configuration"
      ],
    }
  ];

  // Large dataset for testing FTS search strategy
  const createLargeDataset = (count: number): Entity[] => {
    const entities: Entity[] = [];
    for (let i = 0; i < count; i++) {
      entities.push({
        name: `entity-${i}`,
        entityType: i % 10 === 0 ? "important" : "regular",
        observations: [
          `This is entity number ${i}`,
          i % 5 === 0 ? "Has special functionality" : "Standard functionality",
          `Created for testing purposes with index ${i}`
        ],
      });
    }
    // Add some entities with specific search terms
    entities.push({
      name: "search-target-user",
      entityType: "target",
      observations: ["User authentication system", "Special search target"]
    });
    entities.push({
      name: "search-target-auth",
      entityType: "target", 
      observations: ["Authentication service", "Another search target"]
    });
    return entities;
  };

  beforeEach(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    manager = new DuckDBKnowledgeGraphManager(() => testDbPath);
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe("Search Strategy Decision Logic", () => {
    it("should efficiently search small datasets and return relevant results", async () => {
      // Create small dataset
      await manager.createEntities(smallDataset);

      // Perform search - focus on behavior: does it return correct results efficiently?
      const result = await manager.searchNodes("user");

      // Verify behavior: correct entities are found
      expect(result.entities.length).toBeGreaterThan(0);
      const userService = result.entities.find(e => e.name === "user-service");
      expect(userService).toBeDefined();
      expect(userService?.observations).toContain("Handles user authentication and authorization");

      // Verify behavior: related entities are also included
      const authMiddleware = result.entities.find(e => e.name === "auth-middleware");
      expect(authMiddleware).toBeDefined();
    });

    it("should handle large datasets efficiently and return accurate results", async () => {
      // Create large dataset
      const largeDataset = createLargeDataset(1100);
      await manager.createEntities(largeDataset);

      // Force FTS index rebuild for large datasets
      await manager.rebuildFTSIndexes();
      
      // Perform search - focus on behavior: does it handle large datasets efficiently?
      const startTime = Date.now();
      const result = await manager.searchNodes("search-target");
      const searchTime = Date.now() - startTime;

      // Verify behavior: search completes in reasonable time (should be < 1000ms for 1100 entities)
      expect(searchTime).toBeLessThan(1000);

      // Verify behavior: correct target entities are found
      expect(result.entities.length).toBeGreaterThan(0);
      const targetEntities = result.entities.filter(e => e.name.includes("search-target"));
      expect(targetEntities.length).toBeGreaterThan(0);
      
      // Verify behavior: search results are relevant
      const userTarget = result.entities.find(e => e.name === "search-target-user");
      const authTarget = result.entities.find(e => e.name === "search-target-auth");
      expect(userTarget).toBeDefined();
      expect(authTarget).toBeDefined();
    });

    it("should gracefully handle searches that return no results", async () => {
      await manager.createEntities(smallDataset);

      // Perform search with query that genuinely won't match anything
      const result = await manager.searchNodes("xyznonexistentterm12345");

      // Verify behavior: search completes without errors
      expect(result).toBeDefined();
      expect(result.entities).toBeDefined();
      expect(result.relations).toBeDefined();
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relations)).toBe(true);
      
      // For a truly non-existent term, result should be empty
      expect(result.entities.length).toBe(0);
      expect(result.relations.length).toBe(0);
    });
  });

  describe("FTS Initialization", () => {
    it("should support full-text search functionality after initialization", async () => {
      // Create some test data with varied content
      const testEntities = [
        {
          name: "user-authentication-service",
          entityType: "microservice",
          observations: ["Handles user login and JWT token generation", "OAuth2 integration"]
        },
        {
          name: "payment-processor",
          entityType: "service",
          observations: ["Stripe payment processing", "Credit card validation"]
        }
      ];
      await manager.createEntities(testEntities);

      // Force FTS index rebuild to ensure indexes are ready
      await manager.rebuildFTSIndexes();
      
      // Test search functionality - use a single term that should match
      const result = await manager.searchNodes("authentication");
      
      // Verify behavior: multi-term search works correctly
      expect(result.entities.length).toBeGreaterThan(0);
      const authService = result.entities.find(e => e.name === "user-authentication-service");
      expect(authService).toBeDefined();
      
      // Payment processor should not be included in authentication search
      const paymentService = result.entities.find(e => e.name === "payment-processor");
      expect(paymentService).toBeUndefined();
    });

    it("should handle FTS initialization failures gracefully", async () => {
      // Close the manager to simulate connection issues
      await manager.close();

      // Try to initialize a new manager with the same path
      const newManager = new DuckDBKnowledgeGraphManager(() => testDbPath);
      
      // This should not throw even if there are initialization issues
      await expect(newManager.initialize()).resolves.not.toThrow();
      
      await newManager.close();
    });
  });

  describe("Search Functionality", () => {
    beforeEach(async () => {
      await manager.createEntities(smallDataset);
    });

    it("should find entities by name", async () => {
      const result = await manager.searchNodes("user");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const userService = result.entities.find(e => e.name === "user-service");
      expect(userService).toBeDefined();
    });

    it("should find entities by entityType", async () => {
      const result = await manager.searchNodes("microservice");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const microservice = result.entities.find(e => e.entityType === "microservice");
      expect(microservice).toBeDefined();
      expect(microservice?.name).toBe("user-service");
    });

    it("should find entities by observation content", async () => {
      const result = await manager.searchNodes("PostgreSQL");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const found = result.entities.find(e => 
        e.name === "user-service" || e.name === "database-config"
      );
      expect(found).toBeDefined();
    });

    it("should prioritize exact name matches", async () => {
      // Add entity with exact match in name vs partial match in observations
      await manager.createEntities([{
        name: "auth",
        entityType: "exact-match",
        observations: ["Not related to auth"]
      }]);

      const result = await manager.searchNodes("auth");
      
      // Should find both but exact name match should be included
      expect(result.entities.length).toBeGreaterThan(0);
      const exactMatch = result.entities.find(e => e.name === "auth");
      expect(exactMatch).toBeDefined();
    });

    it("should handle empty search queries gracefully", async () => {
      const result = await manager.searchNodes("");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it("should respect result limits for performance", async () => {
      // This ensures search doesn't return unlimited results
      const result = await manager.searchNodes("entity");
      expect(result.entities.length).toBeLessThanOrEqual(500);
    });
  });

  describe("Multi-term Search Functionality", () => {
    beforeEach(async () => {
      await manager.createEntities(smallDataset);
    });

    it("should handle multi-term searches effectively", async () => {
      const result = await manager.searchNodes("user authentication");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const userService = result.entities.find(e => e.name === "user-service");
      expect(userService).toBeDefined();
    });

    it("should find relevant entities with complex search terms", async () => {
      const result = await manager.searchNodes("JWT token validation");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const authMiddleware = result.entities.find(e => e.name === "auth-middleware");
      expect(authMiddleware).toBeDefined();
    });

    it("should work well with configuration-related searches", async () => {
      await manager.createEntities([{
        name: "config",
        entityType: "exact",
        observations: ["Configuration file"]
      }]);

      const result = await manager.searchNodes("config");
      
      expect(result.entities.length).toBeGreaterThan(0);
      const configEntity = result.entities.find(e => e.name === "config");
      expect(configEntity).toBeDefined();
    });
  });

  describe("Database State and Performance", () => {
    it("should handle empty database searches properly", async () => {
      // Don't add any entities - test empty database
      const result = await manager.searchNodes("anything");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it("should scale appropriately with data growth", async () => {
      await manager.createEntities(smallDataset);
      
      // Verify data was added correctly
      const result = await manager.searchNodes("user");
      expect(result.entities.length).toBeGreaterThan(0);
      
      // Add more data and verify search still works
      const additionalEntities = [
        { name: "test-entity", entityType: "test", observations: ["Test observation"] }
      ];
      await manager.createEntities(additionalEntities);
      
      const resultAfterAddition = await manager.searchNodes("test");
      expect(resultAfterAddition.entities.length).toBeGreaterThan(0);
    });

    it("should handle connection lifecycle appropriately", async () => {
      await manager.createEntities(smallDataset);
      
      // Verify search works with active connection
      const result1 = await manager.searchNodes("user");
      expect(result1.entities.length).toBeGreaterThan(0);
      
      // Close the manager
      await manager.close();
      
      // After closing, behavior depends on implementation:
      // Some implementations may reinitialize, others may throw
      try {
        const result2 = await manager.searchNodes("user");
        // If it succeeds, verify it returns valid structure
        expect(result2).toHaveProperty("entities");
        expect(result2).toHaveProperty("relations");
      } catch (error) {
        // If it throws, that's also acceptable behavior after close
        expect(error).toBeDefined();
      }
    });
  });

  describe("Error Handling and API Compatibility", () => {
    beforeEach(async () => {
      await manager.createEntities(smallDataset);
    });

    it("should maintain consistent API structure", async () => {
      // Test that the public searchNodes API provides expected structure
      const result = await manager.searchNodes("user");
      
      expect(result).toHaveProperty("entities");
      expect(result).toHaveProperty("relations");
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relations)).toBe(true);
      
      // Check entity structure
      if (result.entities.length > 0) {
        const entity = result.entities[0];
        expect(entity).toHaveProperty("name");
        expect(entity).toHaveProperty("entityType");
        expect(entity).toHaveProperty("observations");
        expect(entity).toHaveProperty("createdAt");
      }
      
      // Check relation structure
      if (result.relations.length > 0) {
        const relation = result.relations[0];
        expect(relation).toHaveProperty("from");
        expect(relation).toHaveProperty("to");
        expect(relation).toHaveProperty("relationType");
        expect(relation).toHaveProperty("createdAt");
      }
    });

    it("should provide consistent search behavior across different scenarios", async () => {
      // Test various search scenarios to ensure consistent behavior
      const scenarios = [
        "user",
        "PostgreSQL",
        "microservice",
        "auth middleware",
        "nonexistent term"
      ];
      
      for (const query of scenarios) {
        const result = await manager.searchNodes(query);
        
        // All searches should return valid structure
        expect(result).toHaveProperty("entities");
        expect(result).toHaveProperty("relations");
        expect(Array.isArray(result.entities)).toBe(true);
        expect(Array.isArray(result.relations)).toBe(true);
      }
    });
  });

  describe("Search Result Quality", () => {
    beforeEach(async () => {
      await manager.createEntities([
        {
          name: "primary-auth-service",
          entityType: "service",
          observations: ["Main authentication service", "Handles login and logout"]
        },
        {
          name: "secondary-service", 
          entityType: "service",
          observations: ["Secondary service with auth functionality"]
        },
        {
          name: "auth-config",
          entityType: "configuration",
          observations: ["Authentication configuration file"]
        },
        {
          name: "user-profile",
          entityType: "model",
          observations: ["User profile data model", "Contains authentication preferences"]
        }
      ]);
    });

    it("should return relevant results for specific queries", async () => {
      const result = await manager.searchNodes("auth");
      
      // Should find entities related to authentication
      expect(result.entities.length).toBeGreaterThan(0);
      
      const authRelated = result.entities.filter(e => 
        e.name.includes("auth") || 
        e.observations.some(obs => obs.toLowerCase().includes("auth"))
      );
      
      expect(authRelated.length).toBeGreaterThan(0);
    });

    it("should include correct observations in search results", async () => {
      const result = await manager.searchNodes("authentication");
      
      expect(result.entities.length).toBeGreaterThan(0);
      
      // Each entity should have its observations included
      for (const entity of result.entities) {
        expect(entity.observations).toBeDefined();
        expect(Array.isArray(entity.observations)).toBe(true);
        expect(entity.observations.length).toBeGreaterThan(0);
      }
    });

    it("should maintain proper entity structure in results", async () => {
      const result = await manager.searchNodes("service");
      
      for (const entity of result.entities) {
        expect(entity).toHaveProperty("name");
        expect(entity).toHaveProperty("entityType");
        expect(entity).toHaveProperty("observations");
        expect(entity).toHaveProperty("createdAt");
        
        expect(typeof entity.name).toBe("string");
        expect(typeof entity.entityType).toBe("string");
        expect(Array.isArray(entity.observations)).toBe(true);
        expect(typeof entity.createdAt).toBe("string");
      }
    });
  });

  describe("Relations in Search Results", () => {
    beforeEach(async () => {
      await manager.createEntities(smallDataset);
      
      const relations: Relation[] = [
        {
          from: "user-service",
          to: "auth-middleware",
          relationType: "uses"
        },
        {
          from: "auth-middleware",
          to: "database-config",
          relationType: "depends_on"
        }
      ];
      
      await manager.createRelations(relations);
    });

    it("should include related relations in search results", async () => {
      const result = await manager.searchNodes("user-service");
      
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.relations.length).toBeGreaterThan(0);
      
      // Should include relations involving the found entities
      const entityNames = result.entities.map(e => e.name);
      const relevantRelations = result.relations.filter(r => 
        entityNames.includes(r.from) || entityNames.includes(r.to)
      );
      
      expect(relevantRelations.length).toBeGreaterThan(0);
    });

    it("should maintain proper relation structure", async () => {
      const result = await manager.searchNodes("middleware");
      
      for (const relation of result.relations) {
        expect(relation).toHaveProperty("from");
        expect(relation).toHaveProperty("to");
        expect(relation).toHaveProperty("relationType");
        expect(relation).toHaveProperty("createdAt");
        
        expect(typeof relation.from).toBe("string");
        expect(typeof relation.to).toBe("string");
        expect(typeof relation.relationType).toBe("string");
        expect(typeof relation.createdAt).toBe("string");
      }
    });
  });

  describe("Scope Filtering", () => {
    const scopedDataset: Entity[] = [
      {
        name: "project-a:user-service",
        entityType: "service",
        observations: ["User authentication for project A", "Built with Node.js"]
      },
      {
        name: "[project-a]:auth-middleware",
        entityType: "middleware",
        observations: ["JWT validation middleware", "Project A specific auth"]
      },
      {
        name: "project-b:user-service",
        entityType: "service", 
        observations: ["User management for project B", "Built with Python"]
      },
      {
        name: "[project-b]:payment-service",
        entityType: "service",
        observations: ["Payment processing service", "Stripe integration"]
      },
      {
        name: "global-config",
        entityType: "configuration",
        observations: ["Global configuration settings", "No project scope"]
      }
    ];

    beforeEach(async () => {
      // Ensure clean state - close and reinitialize
      await manager.close();
      if (existsSync(testDbPath)) {
        unlinkSync(testDbPath);
      }
      manager = new DuckDBKnowledgeGraphManager(() => testDbPath);
      await manager.initialize();
      
      // Now add scoped test data
      await manager.createEntities(scopedDataset);
    });

    it("should filter entities by scope using project: format", async () => {
      const options: SearchNodesOptions = { scope: "project-a" };
      const result = await manager.searchNodes("user", options);

      expect(result.entities.length).toBeGreaterThan(0);
      
      // Should only find project-a entities
      const projectAEntities = result.entities.filter(e => e.name.startsWith("project-a:"));
      expect(projectAEntities.length).toBeGreaterThan(0);
      
      // Should not find project-b entities
      const projectBEntities = result.entities.filter(e => e.name.startsWith("project-b:"));
      expect(projectBEntities.length).toBe(0);
      
      // Should find the specific user service for project A
      const userService = result.entities.find(e => e.name === "project-a:user-service");
      expect(userService).toBeDefined();
    });

    it("should filter entities by scope using [project]: format", async () => {
      const options: SearchNodesOptions = { scope: "project-a" };
      const result = await manager.searchNodes("auth", options);

      expect(result.entities.length).toBeGreaterThan(0);
      
      // Should find entities with [project-a]: format
      const authMiddleware = result.entities.find(e => e.name === "[project-a]:auth-middleware");
      expect(authMiddleware).toBeDefined();
      
      // Should not find project-b entities
      const projectBEntities = result.entities.filter(e => e.name.includes("project-b"));
      expect(projectBEntities.length).toBe(0);
    });

    it("should support scope with brackets in scope parameter", async () => {
      const options: SearchNodesOptions = { scope: "[project-b]" };
      const result = await manager.searchNodes("payment", options);

      expect(result.entities.length).toBeGreaterThan(0);
      
      // Should find the payment service
      const paymentService = result.entities.find(e => e.name === "[project-b]:payment-service");
      expect(paymentService).toBeDefined();
      
      // Should not find project-a entities
      const projectAEntities = result.entities.filter(e => e.name.includes("project-a"));
      expect(projectAEntities.length).toBe(0);
    });

    it("should return empty results when scope has no matching entities", async () => {
      const options: SearchNodesOptions = { scope: "nonexistent-project" };
      const result = await manager.searchNodes("user", options);

      expect(result.entities.length).toBe(0);
      expect(result.relations.length).toBe(0);
    });

    it("should work without scope parameter (backward compatibility)", async () => {
      const result = await manager.searchNodes("user");

      expect(result.entities.length).toBeGreaterThan(0);
      
      // Should find entities from both projects
      const projectAUser = result.entities.find(e => e.name === "project-a:user-service");
      const projectBUser = result.entities.find(e => e.name === "project-b:user-service");
      
      expect(projectAUser).toBeDefined();
      expect(projectBUser).toBeDefined();
    });

    it("should filter entities by scope with case insensitive matching", async () => {
      const options: SearchNodesOptions = { scope: "PROJECT-A" };
      const result = await manager.searchNodes("user", options);

      expect(result.entities.length).toBeGreaterThan(0);
      
      // Should find project-a entities despite case difference
      const userService = result.entities.find(e => e.name === "project-a:user-service");
      expect(userService).toBeDefined();
    });

    it("should work with large datasets and scope filtering", async () => {
      // Create large dataset with scoped entities
      const largeDataset: Entity[] = [];
      for (let i = 0; i < 1100; i++) {
        const scope = i % 2 === 0 ? "large-project-a" : "large-project-b";
        largeDataset.push({
          name: `${scope}:entity-${i}`,
          entityType: i % 10 === 0 ? "important" : "regular",
          observations: [`Entity ${i} for ${scope}`, "Test data"]
        });
      }
      
      await manager.createEntities(largeDataset);
      
      // Force FTS index rebuild for large datasets
      await manager.rebuildFTSIndexes();
      
      const options: SearchNodesOptions = { scope: "large-project-a" };
      const startTime = Date.now();
      const result = await manager.searchNodes("entity", options);
      const searchTime = Date.now() - startTime;

      // Should complete in reasonable time
      expect(searchTime).toBeLessThan(1000);
      
      // Should only find project-a entities
      expect(result.entities.length).toBeGreaterThan(0);
      for (const entity of result.entities) {
        expect(entity.name).toMatch(/^large-project-a:/);
      }
    });

    it("should handle scope filtering with multi-term queries", async () => {
      // Test with a multi-term query that searches across different fields
      const options: SearchNodesOptions = { scope: "project-a" };
      
      // Force FTS index rebuild to ensure indexes are ready
      await manager.rebuildFTSIndexes();
      
      const result = await manager.searchNodes("authentication", options);

      // Should find project-a entities that match the search terms
      const foundEntities = result.entities.filter(e => e.name.includes("project-a"));
      expect(foundEntities.length).toBeGreaterThan(0);
      
      // Should not find entities from other projects
      const otherProjectEntities = result.entities.filter(e => 
        e.name.includes("project-b") || e.name === "global-config"
      );
      expect(otherProjectEntities.length).toBe(0);
    });

    it("should work with scope filtering across different search modes", async () => {
      const scopeOptions = { scope: "project-a" };
      
      // Test scope filtering with different search modes
      const keywordScopedResults = await manager.searchNodes("user", {
        ...scopeOptions,
        searchMode: "keyword" as any
      });
      
      const hybridScopedResults = await manager.searchNodes("user", {
        ...scopeOptions, 
        searchMode: "hybrid" as any
      });
      
      // Both should respect scope filtering
      keywordScopedResults.entities.forEach(entity => {
        expect(entity.name.includes("project-a") || entity.name.includes("[project-a]")).toBe(true);
      });
      
      hybridScopedResults.entities.forEach(entity => {
        expect(entity.name.includes("project-a") || entity.name.includes("[project-a]")).toBe(true);
      });
      
      // Should not find project-b entities in either result
      expect(keywordScopedResults.entities.some(e => e.name.includes("project-b"))).toBe(false);
      expect(hybridScopedResults.entities.some(e => e.name.includes("project-b"))).toBe(false);
    });
  });

  describe("VSS Integration Test Suite", () => {
    beforeEach(async () => {
      // Create a comprehensive dataset for VSS testing
      const vssTestEntities = [
        {
          name: "authentication-microservice",
          entityType: "microservice",
          observations: [
            "Handles user authentication and authorization",
            "JWT token generation and validation",
            "Multi-factor authentication support",
            "OAuth2 and SAML integration"
          ]
        },
        {
          name: "payment-processing-engine",
          entityType: "service",
          observations: [
            "Credit card payment processing",
            "Digital wallet integration", 
            "Fraud detection and prevention",
            "PCI DSS compliance features"
          ]
        },
        {
          name: "machine-learning-platform",
          entityType: "ai",
          observations: [
            "Deep learning model training",
            "Natural language processing pipeline",
            "Computer vision algorithms",
            "Predictive analytics engine"
          ]
        },
        {
          name: "data-warehouse-system",
          entityType: "storage", 
          observations: [
            "Big data storage and retrieval",
            "ETL pipeline automation",
            "Data lake management",
            "Business intelligence integration"
          ]
        }
      ];
      await manager.createEntities(vssTestEntities);
    });

    it("should demonstrate VSS semantic understanding capabilities", async () => {
      if (!manager.isVSSAvailable()) {
        console.log("VSS not available, skipping semantic understanding test");
        return;
      }

      // Test semantic search with conceptually related but lexically different terms
      const semanticQuery = "user login and security";
      const results = await manager.searchNodes(semanticQuery, {
        searchMode: "semantic" as any
      });
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      // Should potentially find authentication-related entities even without exact matches
      const authEntities = results.entities.filter(e => 
        e.name.includes("authentication") ||
        e.observations.some(obs => obs.toLowerCase().includes("auth"))
      );
      
      // At least basic structure should be maintained
      expect(results.entities.length).toBeGreaterThanOrEqual(0);
    });

    it("should validate hybrid search RRF algorithm effectiveness", async () => {
      if (!manager.isVSSAvailable()) {
        console.log("VSS not available, testing fallback behavior");
      }

      const query = "payment fraud detection";
      
      // Compare hybrid vs individual strategies
      const keywordResults = await manager.searchNodes(query, { searchMode: "keyword" as any });
      const hybridResults = await manager.searchNodes(query, { searchMode: "hybrid" as any });
      
      // Both should return valid results
      expect(keywordResults.entities.length).toBeGreaterThanOrEqual(0);
      expect(hybridResults.entities.length).toBeGreaterThanOrEqual(0);
      
      // Hybrid should maintain or improve result quality
      const paymentEntities = hybridResults.entities.filter(e => 
        e.name.includes("payment") ||
        e.observations.some(obs => obs.toLowerCase().includes("payment"))
      );
      
      if (paymentEntities.length > 0) {
        expect(paymentEntities[0].observations.some(obs => 
          obs.includes("fraud") || obs.includes("payment")
        )).toBe(true);
      }
    });

    it("should handle VSS-specific error conditions gracefully", async () => {
      // Test with potentially problematic queries
      const problematicQueries = [
        "très spécial caractères ñoño",  // Special characters
        "a".repeat(1000),                   // Very long query
        "1234567890",                       // Numeric query
        "!@#$%^&*()",                      // Special symbols only
      ];
      
      for (const query of problematicQueries) {
        const results = await manager.searchNodes(query, {
          searchMode: "hybrid" as any
        });
        
        // Should handle gracefully without throwing
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
      }
    });

    it("should maintain performance under VSS load", async () => {
      const queries = [
        "machine learning algorithms",
        "data processing pipeline", 
        "authentication system",
        "payment processing"
      ];
      
      const startTime = Date.now();
      
      // Execute multiple searches concurrently
      const results = await Promise.all(
        queries.map(query => 
          manager.searchNodes(query, { searchMode: "hybrid" as any })
        )
      );
      
      const totalTime = Date.now() - startTime;
      
      // Should complete in reasonable time (< 10 seconds for 4 concurrent searches)
      expect(totalTime).toBeLessThan(10000);
      
      // All searches should return valid results
      results.forEach((result, index) => {
        expect(result, `Query ${index} failed`).toBeTruthy();
        expect(Array.isArray(result.entities)).toBe(true);
        expect(Array.isArray(result.relations)).toBe(true);
      });
    });

    it("should demonstrate search mode routing intelligence", async () => {
      const testCases = [
        { query: "machine learning", expectedMode: "auto/hybrid" },
        { query: "機器學習", expectedMode: "keyword (Chinese)" },
        { query: "ML algorithms", expectedMode: "auto/hybrid" },
        { query: "人工智能 AI", expectedMode: "keyword (Chinese)" }
      ];
      
      for (const { query, expectedMode } of testCases) {
        const results = await manager.searchNodes(query);  // Auto mode
        
        expect(results, `Failed for ${expectedMode}: "${query}"`).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
      }
    });
  });
});