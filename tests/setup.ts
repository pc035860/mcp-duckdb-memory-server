import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

export async function setup() {
  // Ensure test directory exists
  const testDir = join(process.cwd(), "tmp");
  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true });
  }
  
  console.log("Test environment initialized");
}

export async function teardown() {
  // Clean up test directory
  const testDir = join(process.cwd(), "tmp");
  if (existsSync(testDir)) {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to clean up test directory:", error);
    }
  }
  
  console.log("Test environment cleaned up");
}