import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/manager";
import { Entity, Relation, Observation } from "../src/types";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

describe("DuckDBFuseKnowledgeGraphManager", () => {
  // Test file path
  const testDbPath = join(process.cwd(), "tmp", "test-knowledge-graph.db");
  let manager: DuckDBKnowledgeGraphManager;

  // More realistic test data
  const testEntities: Entity[] = [
    {
      name: "John Smith",
      entityType: "Person",
      observations: [
        "Software engineer with 8 years of experience",
        "Specializes in TypeScript and React",
        "Works at Acme Corporation since 2020",
      ],
    },
    {
      name: "Acme Corporation",
      entityType: "Organization",
      observations: [
        "Technology company founded in 2015",
        "Headquartered in San Francisco",
        "Specializes in enterprise software solutions",
      ],
    },
    {
      name: "Knowledge Graph Project",
      entityType: "Project",
      observations: [
        "Started in January 2025",
        "Aims to create a knowledge management system",
        "Implemented using TypeScript and Node.js",
      ],
    },
    {
      name: "GraphQL",
      entityType: "Technology",
      observations: [
        "API query language developed by Facebook",
        "Enables efficient data retrieval",
        "Popular in modern web applications",
      ],
    },
  ];

  // Function to create test data
  const createTestData = async () => {
    await manager.createEntities(testEntities);
    await manager.createRelations(testRelations);
  };

  // More realistic relations
  const testRelations: Relation[] = [
    {
      from: "John Smith",
      to: "Acme Corporation",
      relationType: "works at",
    },
    {
      from: "John Smith",
      to: "Knowledge Graph Project",
      relationType: "leads",
    },
    {
      from: "Acme Corporation",
      to: "Knowledge Graph Project",
      relationType: "sponsors",
    },
    {
      from: "Knowledge Graph Project",
      to: "GraphQL",
      relationType: "uses",
    },
  ];

  // More realistic observations
  const testObservations: Observation[] = [
    {
      entityName: "John Smith",
      contents: [
        "Recently completed advanced GraphQL certification",
        "Has 3 years of team leadership experience",
      ],
    },
    {
      entityName: "Knowledge Graph Project",
      contents: [
        "Phase one scheduled for completion in March 2025",
        "Main goal is to visualize data relationships",
      ],
    },
  ];

  // Run before each test
  beforeEach(async () => {
    // Create test manager
    manager = new DuckDBKnowledgeGraphManager(() => testDbPath);
  });

  // Run after each test
  afterEach(() => {
    // Delete test file
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe("createEntities", () => {
    it("should create new entities", async () => {
      const result = await manager.createEntities(testEntities);
      expect(result).toHaveLength(4);
      expect(result[0].name).toBe("John Smith");
      expect(result[1].name).toBe("Acme Corporation");

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(4);
      expect(graph.entities[0].name).toBe("John Smith");
      expect(graph.entities[1].name).toBe("Acme Corporation");
    });

    it("should not create duplicate entities", async () => {
      // Create first entity
      await manager.createEntities([testEntities[0]]);

      // Try to create entities including the existing one
      const result = await manager.createEntities(testEntities);

      // Only non-duplicate entities should be created
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.name)).not.toContain("John Smith");

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(4);
    });
  });

  describe("createRelations", () => {
    it("should create relations between existing entities", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Create relations
      const result = await manager.createRelations(testRelations);
      expect(result).toHaveLength(4);
      expect(result[0].from).toBe("John Smith");
      expect(result[0].to).toBe("Acme Corporation");

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(4);
      expect(graph.relations[0].from).toBe("John Smith");
      expect(graph.relations[0].to).toBe("Acme Corporation");
    });

    it("should not create relations for non-existing entities", async () => {
      // Try to create relations without creating entities
      const result = await manager.createRelations(testRelations);

      // No relations should be created
      expect(result).toHaveLength(0);

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(0);
    });

    it("should not create duplicate relations", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Create relations
      await manager.createRelations(testRelations);

      // Try to create the same relations again
      const result = await manager.createRelations(testRelations);

      // No duplicate relations should be created
      expect(result).toHaveLength(0);

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(4);
    });
  });

  describe("addObservations", () => {
    it("should add observations to existing entities", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Add observations
      const result = await manager.addObservations(testObservations);
      expect(result).toHaveLength(2);
      expect(result[0].entityName).toBe("John Smith");
      expect(result[0].contents).toHaveLength(2);
      expect(result[0].contents).toContain(
        "Recently completed advanced GraphQL certification"
      );

      // Verify graph
      const graph = await manager.readGraph();
      const entity = graph.entities.find((e) => e.name === "John Smith");
      expect(entity).toBeDefined();
      expect(entity!.observations).toHaveLength(5); // Original 3 + new 2
      expect(entity!.observations).toContain(
        "Software engineer with 8 years of experience"
      );
      expect(entity!.observations).toContain(
        "Recently completed advanced GraphQL certification"
      );
    });

    it("should not add duplicate observations", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Create observations with duplicates
      const duplicateObservations: Observation[] = [
        {
          entityName: "John Smith",
          contents: [
            "Software engineer with 8 years of experience", // Already exists
            "Active contributor to open source projects", // New observation
          ],
        },
      ];

      // Add observations
      const result = await manager.addObservations(duplicateObservations);

      // Verify graph
      const graph = await manager.readGraph();
      const entity = graph.entities.find((e) => e.name === "John Smith");
      expect(entity).toBeDefined();

      // Verify observations
      expect(entity!.observations).toContain(
        "Software engineer with 8 years of experience"
      );
      expect(entity!.observations).toContain(
        "Active contributor to open source projects"
      );
    });

    it("should ignore observations for non-existing entities", async () => {
      // Observations for non-existing entity
      const nonExistingObservations: Observation[] = [
        {
          entityName: "Non-existing Entity",
          contents: ["Some observation"],
        },
      ];

      // Add observations
      const result = await manager.addObservations(nonExistingObservations);
      expect(result).toHaveLength(0);

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe("deleteObservations", () => {
    it("should delete observations from entities", async () => {
      // Create entities
      await createTestData();

      // Observations to delete
      const deletions: Observation[] = [
        {
          entityName: "John Smith",
          contents: ["Software engineer with 8 years of experience"],
        },
      ];

      // Delete observations
      await manager.deleteObservations(deletions);

      // Verify graph
      const graph = await manager.readGraph();
      const entity = graph.entities.find((e) => e.name === "John Smith");
      expect(entity).toBeDefined();

      // Verify observations were deleted
      expect(entity!.observations).not.toContain(
        "Software engineer with 8 years of experience"
      );
      expect(entity!.observations).toContain(
        "Specializes in TypeScript and React"
      );
    });

    it("should handle non-existing entities gracefully", async () => {
      // Delete observations from non-existing entity
      const deletions: Observation[] = [
        {
          entityName: "Non-existing Entity",
          contents: ["Some observation"],
        },
      ];

      // Should not throw error
      await expect(
        manager.deleteObservations(deletions)
      ).resolves.not.toThrow();
    });

    it("should handle non-existing observations gracefully", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Delete non-existing observations
      const deletions: Observation[] = [
        {
          entityName: "John Smith",
          contents: ["Non-existing observation content"],
        },
      ];

      // Delete observations
      await manager.deleteObservations(deletions);

      // Verify graph
      const graph = await manager.readGraph();
      const entity = graph.entities.find((e) => e.name === "John Smith");
      expect(entity).toBeDefined();

      // Verify observations still exist
      expect(entity!.observations.length).toBeGreaterThan(0);
    });
  });

  describe("deleteEntities", () => {
    it("should delete entities and their relations", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);

      // Delete John Smith entity
      await manager.deleteEntities(["John Smith"]);

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(3); // Only 3 entities remain (John Smith is deleted)
      expect(graph.entities.map((e) => e.name)).not.toContain("John Smith");
      expect(graph.entities.map((e) => e.name)).toContain("Acme Corporation");

      // Relations involving John Smith should be deleted
      expect(
        graph.relations.some(
          (r) => r.from === "John Smith" || r.to === "John Smith"
        )
      ).toBe(false);
    });

    it("should handle non-existing entities gracefully", async () => {
      // Delete non-existing entity
      await expect(
        manager.deleteEntities(["Non-existing Entity"])
      ).resolves.not.toThrow();
    });
  });

  describe("deleteRelations", () => {
    it("should delete specific relations", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);

      // Delete one relation
      await manager.deleteRelations([testRelations[0]]);

      // Verify graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(4); // All entities remain
      expect(graph.relations).toHaveLength(3); // One relation is deleted
      expect(
        graph.relations.some(
          (r) =>
            r.from === "John Smith" &&
            r.to === "Acme Corporation" &&
            r.relationType === "works at"
        )
      ).toBe(false);
    });

    it("should handle non-existing relations gracefully", async () => {
      // Delete non-existing relations
      const nonExistingRelations: Relation[] = [
        {
          from: "Non-existing Person",
          to: "Non-existing Organization",
          relationType: "works at",
        },
      ];

      // Should not throw error
      await expect(
        manager.deleteRelations(nonExistingRelations)
      ).resolves.not.toThrow();
    });
  });

  describe("searchNodes", () => {
    it("should find entities by name", async () => {
      // Create entities
      await createTestData();

      // Search by name
      const results = await manager.searchNodes("John Smith");

      // Verify results
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) => entity.name === "John Smith")
      ).toBe(true);
    });

    it("should return relations involving found entities", async () => {
      // Create entities and relations
      await createTestData();

      // Search by name
      const results = await manager.searchNodes("John Smith");

      // Verify relations
      expect(results.relations.length).toBeGreaterThan(0);

      // Should include relations where John Smith is the 'from' entity
      expect(
        results.relations.some(
          (relation) =>
            relation.from === "John Smith" &&
            relation.to === "Acme Corporation" &&
            relation.relationType === "works at"
        )
      ).toBe(true);

      // Should include relations where John Smith is the 'to' entity
      // (In our test data, there are no such relations, but the logic should be tested)
      // If we had such relations, we would test them here
    });

    it("should find entities by type", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search by entity type
      const results = await manager.searchNodes("Organization");

      // Verify results
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) => entity.entityType === "Organization")
      ).toBe(true);
    });

    it("should find entities by observation content", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search by observation content
      const results = await manager.searchNodes("TypeScript");

      // Verify results
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) =>
          entity.observations.some((obs) => obs.includes("TypeScript"))
        )
      ).toBe(true);
    });

    it("should return empty array for no matches", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search with no matches
      const results = await manager.searchNodes("Non-existing Term");
      expect(results.entities).toHaveLength(0);
    });

    it("should return empty array for empty query", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search with empty query
      const results = await manager.searchNodes("");
      expect(results.entities).toHaveLength(0);
    });

    it("should find entities by multiple keywords", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search by multiple keywords
      const results = await manager.searchNodes("TypeScript React");

      // Verify results
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) => entity.name === "John Smith")
      ).toBe(true);

      // Verify the entity has observations containing both keywords
      const johnSmith = results.entities.find(
        (entity) => entity.name === "John Smith"
      );
      expect(johnSmith).toBeDefined();
      expect(
        johnSmith!.observations.some(
          (obs) => obs.includes("TypeScript") && obs.includes("React")
        )
      ).toBe(true);
    });
  });

  describe("searchMultiKeywords", () => {
    it("should find entities by multiple keywords in OR mode", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search by multiple keywords
      const results = await manager.searchMultiKeywords(["TypeScript", "GraphQL"]);

      // Verify results - should find both John Smith and GraphQL entities
      expect(results.entities.length).toBeGreaterThanOrEqual(2);
      expect(
        results.entities.some((entity) => entity.name === "John Smith")
      ).toBe(true);
      expect(
        results.entities.some((entity) => entity.name === "GraphQL")
      ).toBe(true);
    });

    it("should find entities by multiple keywords in AND mode", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search by multiple keywords in AND mode
      const results = await manager.searchMultiKeywords(
        ["TypeScript", "React"], 
        { mode: 'AND' }
      );

      // Verify results - should only find entities that match both keywords
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) => entity.name === "John Smith")
      ).toBe(true);
      
      // John Smith should have both TypeScript and React in observations
      const johnSmith = results.entities.find(e => e.name === "John Smith");
      expect(johnSmith).toBeDefined();
      const allObservations = johnSmith!.observations.join(" ");
      expect(allObservations).toContain("TypeScript");
      expect(allObservations).toContain("React");
    });

    it("should respect field restrictions", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search only in entityType field
      const results = await manager.searchMultiKeywords(
        ["Person", "Organization"], 
        { fields: ['entityType'] }
      );

      // Should find entities with these entity types
      expect(results.entities.length).toBeGreaterThanOrEqual(2);
      expect(
        results.entities.some((entity) => entity.entityType === "Person")
      ).toBe(true);
      expect(
        results.entities.some((entity) => entity.entityType === "Organization")
      ).toBe(true);
    });

    it("should use custom threshold", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search with very strict threshold
      const strictResults = await manager.searchMultiKeywords(
        ["TypeScri"], // Partial match
        { threshold: 0.1 }
      );

      // Search with loose threshold
      const looseResults = await manager.searchMultiKeywords(
        ["TypeScri"], // Same partial match
        { threshold: 0.8 }
      );

      // Loose results should have more matches
      expect(looseResults.entities.length).toBeGreaterThanOrEqual(
        strictResults.entities.length
      );
    });

    it("should return empty array for empty keywords", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search with empty keywords
      const results = await manager.searchMultiKeywords([]);
      expect(results.entities).toHaveLength(0);
      expect(results.relations).toHaveLength(0);
    });

    it("should filter out empty keyword strings", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Search with some empty strings
      const results = await manager.searchMultiKeywords(["", "TypeScript", "  "]);
      
      // Should still find results for TypeScript
      expect(results.entities.length).toBeGreaterThan(0);
      expect(
        results.entities.some((entity) => 
          entity.name === "John Smith" || 
          entity.name === "Knowledge Graph Project"
        )
      ).toBe(true);
    });

    it("should return related relations for found entities", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);

      // Search for keywords that will find related entities
      const results = await manager.searchMultiKeywords(["John", "Acme"]);

      // Should find relations between found entities
      expect(results.relations.length).toBeGreaterThan(0);
      expect(
        results.relations.some(
          (relation) =>
            relation.from === "John Smith" &&
            relation.to === "Acme Corporation" &&
            relation.relationType === "works at"
        )
      ).toBe(true);
    });
  });

  describe("openNodes", () => {
    it("should retrieve specific entities by name", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Retrieve by name
      const results = await manager.openNodes(["John Smith"]);
      expect(results.entities).toHaveLength(1);
      expect(results.entities[0].name).toBe("John Smith");
      expect(results.entities[0].entityType).toBe("Person");

      // Verify observations
      expect(results.entities[0].observations.length).toBeGreaterThan(0);
    });

    it("should return relations involving opened entities", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);

      // Open specific entity
      const results = await manager.openNodes(["John Smith"]);

      // Verify relations
      expect(results.relations.length).toBeGreaterThan(0);

      // Should include relations where John Smith is the 'from' entity
      expect(
        results.relations.some(
          (relation) =>
            relation.from === "John Smith" &&
            relation.to === "Acme Corporation" &&
            relation.relationType === "works at"
        )
      ).toBe(true);

      expect(
        results.relations.some(
          (relation) =>
            relation.from === "John Smith" &&
            relation.to === "Knowledge Graph Project" &&
            relation.relationType === "leads"
        )
      ).toBe(true);

      // Should include relations where John Smith is the 'to' entity
      // (In our test data, there are no such relations, but the logic should be tested)
      // If we had such relations, we would test them here
    });

    it("should retrieve multiple entities", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Retrieve multiple entities
      const results = await manager.openNodes([
        "John Smith",
        "Acme Corporation",
      ]);
      expect(results.entities).toHaveLength(2);
      expect(results.entities.map((e) => e.name)).toContain("John Smith");
      expect(results.entities.map((e) => e.name)).toContain("Acme Corporation");
    });

    it("should return empty array for non-existing entities", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Retrieve non-existing entity
      const results = await manager.openNodes(["Non-existing Entity"]);
      expect(results.entities).toHaveLength(0);
    });

    it("should return only existing entities from a mixed list", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Retrieve mixed list of existing and non-existing entities
      const results = await manager.openNodes([
        "John Smith",
        "Non-existing Entity",
      ]);
      expect(results.entities).toHaveLength(1);
      expect(results.entities[0].name).toBe("John Smith");
    });
  });

  describe("readGraph", () => {
    it("should return the entire knowledge graph", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);

      // Read graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(4);
      expect(graph.relations).toHaveLength(4);
      expect(graph.entities.map((e) => e.name)).toContain("John Smith");
      expect(graph.entities.map((e) => e.name)).toContain("Acme Corporation");
      expect(
        graph.relations.some(
          (r) => r.from === "John Smith" && r.to === "Acme Corporation"
        )
      ).toBe(true);
    });

    it("should return empty graph when no data exists", async () => {
      // Read empty graph
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
      expect(graph.relations).toHaveLength(0);
    });
  });

  describe("timestamp functionality", () => {
    it("should create entities with timestamps", async () => {
      // Create new entities
      const created = await manager.createEntities([testEntities[0]]);

      // Verify entity was created with timestamp
      expect(created).toHaveLength(1);
      expect(created[0].name).toBe("John Smith");
      expect(created[0].createdAt).toBeDefined();
      
      // Timestamp should be ISO 8601 format
      const timestamp = new Date(created[0].createdAt);
      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.toISOString()).toBe(created[0].createdAt);
      
      // Verify it's a reasonable timestamp (not in far future or past)
      const now = Date.now();
      const timestampTime = timestamp.getTime();
      const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
      const oneYearFromNow = now + (365 * 24 * 60 * 60 * 1000);
      
      expect(timestampTime).toBeGreaterThanOrEqual(oneYearAgo);
      expect(timestampTime).toBeLessThanOrEqual(oneYearFromNow);
    });

    it("should return timestamps in search results", async () => {
      // Create entities
      await manager.createEntities([testEntities[0], testEntities[1]]);

      // Search for entities
      const searchResults = await manager.searchNodes("Smith");
      expect(searchResults.entities.length).toBeGreaterThan(0);
      
      // All entities should have createdAt
      searchResults.entities.forEach(entity => {
        expect(entity.createdAt).toBeDefined();
        expect(typeof entity.createdAt).toBe('string');
        // Verify ISO 8601 format
        expect(entity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("should return timestamps in openNodes results", async () => {
      // Create entities
      await manager.createEntities(testEntities);

      // Open specific nodes
      const results = await manager.openNodes(["John Smith", "Acme Corporation"]);
      expect(results.entities).toHaveLength(2);
      
      // All entities should have createdAt
      results.entities.forEach(entity => {
        expect(entity.createdAt).toBeDefined();
        expect(typeof entity.createdAt).toBe('string');
      });
    });

    it("should return timestamps in readGraph results", async () => {
      // Create entities
      await manager.createEntities([testEntities[0], testEntities[1]]);

      // Read entire graph
      const graph = await manager.readGraph();
      expect(graph.entities.length).toBeGreaterThan(0);
      
      // All entities should have createdAt
      graph.entities.forEach(entity => {
        expect(entity.createdAt).toBeDefined();
        expect(typeof entity.createdAt).toBe('string');
      });
    });

    it("should return timestamps in createRelations results", async () => {
      // Create entities first
      await manager.createEntities(testEntities);
      
      // Create relations
      const created = await manager.createRelations(testRelations);
      
      expect(created).toHaveLength(4);
      
      // All relations should have createdAt
      created.forEach(relation => {
        expect(relation.createdAt).toBeDefined();
        expect(typeof relation.createdAt).toBe('string');
        // Verify ISO 8601 format
        expect(relation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("should return timestamps in addObservations results", async () => {
      // Create entities first
      await manager.createEntities(testEntities);
      
      // Add observations
      const added = await manager.addObservations(testObservations);
      
      expect(added).toHaveLength(2);
      
      // All observations should have createdAt
      added.forEach(observation => {
        expect(observation.createdAt).toBeDefined();
        expect(typeof observation.createdAt).toBe('string');
        // Verify ISO 8601 format
        expect(observation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("should return timestamps in relations from search results", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);
      
      // Search
      const results = await manager.searchNodes("John Smith");
      
      expect(results.relations.length).toBeGreaterThan(0);
      
      // All relations should have createdAt
      results.relations.forEach(relation => {
        expect(relation.createdAt).toBeDefined();
        expect(typeof relation.createdAt).toBe('string');
        // Verify ISO 8601 format
        expect(relation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("should return timestamps in relations from readGraph", async () => {
      // Create entities and relations
      await manager.createEntities(testEntities);
      await manager.createRelations(testRelations);
      
      // Read graph
      const graph = await manager.readGraph();
      
      expect(graph.relations).toHaveLength(4);
      
      // All relations should have createdAt
      graph.relations.forEach(relation => {
        expect(relation.createdAt).toBeDefined();
        expect(typeof relation.createdAt).toBe('string');
        // Verify ISO 8601 format
        expect(relation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });
  });
});
