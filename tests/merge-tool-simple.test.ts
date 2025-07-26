import { describe, it, expect } from "vitest";
import { DuckDBMergeTool } from "../src/tools/merge-duckdb.js";
import { existsSync } from "fs";

describe("DuckDBMergeTool basic tests", () => {
  it("should instantiate correctly", () => {
    const tool = new DuckDBMergeTool();
    expect(tool).toBeDefined();
  });

  it("should reject non-existent files", async () => {
    const tool = new DuckDBMergeTool();
    
    await expect(
      tool.merge("/non/existent/file1.db", "/non/existent/file2.db", "/tmp/output.db")
    ).rejects.toThrow("File not found");
  });

  it("should reject when output file already exists", async () => {
    const tool = new DuckDBMergeTool();
    
    // Use existing files (we know package.json exists)
    await expect(
      tool.merge("package.json", "package.json", "package.json")
    ).rejects.toThrow("Output file already exists");
  });

  it("should have correct usage information", () => {
    const tool = new DuckDBMergeTool();
    
    // Capture console output
    const originalLog = console.log;
    let output = "";
    console.log = (msg: string) => { output += msg + "\n"; };
    
    tool.printUsage();
    
    console.log = originalLog;
    
    expect(output).toContain("Usage: merge-duckdb");
    expect(output).toContain("source1.db");
    expect(output).toContain("source2.db");
    expect(output).toContain("output.db");
    expect(output).toContain("Merge Rules:");
  });
});