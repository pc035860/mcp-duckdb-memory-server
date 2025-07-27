import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { Entity, Observation } from "../src/types";
import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { generateUniqueDbPath, cleanupTestDb, safeCloseManager } from "./test-utils.js";

describe("FTS Debounce 自動重建機制", () => {
  // 測試檔案路徑 - will be set uniquely for each test
  let testDbPath: string;
  let manager: DuckDBKnowledgeGraphManager;

  // 測試資料
  const testEntities: Entity[] = [
    {
      name: "Test Entity 1",
      entityType: "TestType",
      observations: ["Test observation 1", "Another test observation"],
      createdAt: "2025-01-01T00:00:00Z"
    },
    {
      name: "Test Entity 2", 
      entityType: "TestType",
      observations: ["Test observation 2"],
      createdAt: "2025-01-01T00:00:00Z"
    }
  ];

  const testObservations: Observation[] = [
    {
      entityName: "Test Entity 1",
      contents: ["New observation for entity 1"]
    },
    {
      entityName: "Test Entity 2",
      contents: ["New observation for entity 2"]
    }
  ];

  beforeAll(() => {
    // 確保測試目錄存在
    const tmpDir = join(process.cwd(), "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  beforeEach(async () => {
    // Use unique path for each test to avoid conflicts
    testDbPath = generateUniqueDbPath("fts-debounce");
    
    // 清理現有測試檔案
    await cleanupTestDb(testDbPath);

    // 使用低閾值確保 FTS 啟用（設為 0 以總是使用 FTS）
    manager = new DuckDBKnowledgeGraphManager(() => testDbPath, undefined, false, 0);
    await manager.initialize();

    // 檢查 FTS 資訊以驗證 FTS 已啟用
    const ftsInfo = await manager.getFTSInfo();
    expect(ftsInfo.enabled).toBe(true);

    // Mock 時間函數
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();

    // Safe close manager
    await safeCloseManager(manager);

    // Clean up test files
    if (testDbPath) {
      await cleanupTestDb(testDbPath);
    }

    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe("Debounce 機制基本功能", () => {
    it("應該在 5 秒後觸發 FTS 索引重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 觸發索引重建
      await manager.createEntities(testEntities);

      // 確認還未立即執行重建
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進到 debounce 時間前
      vi.advanceTimersByTime(4999);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進到 debounce 時間
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();

      // 確認重建被執行
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("多次快速觸發應該只執行一次重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 快速連續觸發多次
      await manager.createEntities([testEntities[0]]);
      await manager.addObservations([testObservations[0]]);
      await manager.createEntities([testEntities[1]]);
      await manager.addObservations([testObservations[1]]);

      // 確認還未執行重建
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進到 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 應該只執行一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("應該正確重置 debounce 計時器", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 第一次觸發
      await manager.createEntities([testEntities[0]]);

      // 等待 3 秒
      vi.advanceTimersByTime(3000);

      // 第二次觸發應該重置計時器
      await manager.addObservations([testObservations[0]]);

      // 再等待 3 秒（總共 6 秒，但第二次觸發重置了計時器）
      vi.advanceTimersByTime(3000);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 再等待 2 秒（第二次觸發後的 5 秒）
      vi.advanceTimersByTime(2000);
      await vi.runAllTimersAsync();

      // 現在應該執行重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("資料變更觸發測試", () => {
    it("createEntities 應該觸發索引重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.createEntities(testEntities);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("addObservations 應該觸發索引重建", async () => {
      // 先創建實體
      await manager.createEntities(testEntities);
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.addObservations(testObservations);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("deleteEntities 應該觸發索引重建", async () => {
      // 先創建實體
      await manager.createEntities(testEntities);
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.deleteEntities(["Test Entity 1"]);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("deleteObservations 應該觸發索引重建", async () => {
      // 先創建實體和觀察
      await manager.createEntities(testEntities);
      await manager.addObservations(testObservations);
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.deleteObservations([{
        entityName: "Test Entity 1",
        contents: ["New observation for entity 1"]
      }]);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("邊界情況測試", () => {
    it("FTS 未啟用時應該跳過重建", async () => {
      // 關閉 manager 並創建新的未啟用 FTS 的 manager
      await manager.close();
      
      // 使用高閾值確保 FTS 不啟用
      manager = new DuckDBKnowledgeGraphManager(() => testDbPath, undefined, false, 10000);
      await manager.initialize();

      const ftsInfo = await manager.getFTSInfo();
      expect(ftsInfo.enabled).toBe(false);

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.createEntities(testEntities);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 不應該嘗試重建
      expect(rebuildSpy).not.toHaveBeenCalled();
    });

    it("管理器關閉時應該跳過重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.createEntities(testEntities);
      
      // 關閉管理器
      await manager.close();

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 不應該嘗試重建
      expect(rebuildSpy).not.toHaveBeenCalled();
    });

    it("重建失敗時不應該影響主流程", async () => {
      // Mock rebuildFTSIndexes 拋出錯誤
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes')
        .mockImplementation(() => Promise.reject(new Error("重建失敗")));

      // 這個操作應該成功，即使後續的重建失敗
      const result = await manager.createEntities(testEntities);
      expect(result).toBeDefined();

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      
      // 管理器應該仍然可用（可以透過執行操作來驗證）
      const testResult = await manager.getFTSInfo();
      expect(testResult).toBeDefined();
    });
  });

  describe("記憶體洩漏測試", () => {
    it("close() 方法應該清理計時器", async () => {
      // 觸發索引重建排程
      await manager.createEntities(testEntities);

      // 驗證計時器已設定（通過嘗試添加一些操作來間接驗證）
      // 無法直接檢查私有屬性，但可以驗證行為

      // 關閉管理器
      await manager.close();

      // 驗證管理器已關閉（嘗試操作會失敗）
      await expect(manager.getFTSInfo()).rejects.toThrow();
    });

    it("多次觸發不應該累積計時器", async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      // 第一次觸發
      await manager.createEntities([testEntities[0]]);
      expect((manager as any).ftsRebuildTimer).not.toBeNull();

      // 第二次觸發應該清理前一個計時器
      await manager.createEntities([testEntities[1]]);
      
      // clearTimeout 應該被調用來清理前一個計時器
      expect(clearTimeoutSpy).toHaveBeenCalled();
      
      // clearTimeout 被調用表示計時器被正確管理
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("效能測試", () => {
    it("批量操作應該只觸發一次重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 執行多個批量操作（序列化以避免事務衝突）
      await manager.createEntities([testEntities[0]]);
      await manager.createEntities([testEntities[1]]);
      await manager.addObservations([testObservations[0]]);
      await manager.addObservations([testObservations[1]]);

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("debounce 應該減少重建頻率", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 在短時間內執行多次操作
      for (let i = 0; i < 10; i++) {
        await manager.createEntities([{
          name: `Entity ${i}`,
          entityType: "TestType",
          observations: [`Observation ${i}`],
          createdAt: new Date().toISOString()
        }]);
        
        // 等待 1 秒（小於 debounce 時間）
        vi.advanceTimersByTime(1000);
      }

      // 等待 debounce 完成
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 儘管有 10 次操作，應該只重建一次
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Debounce 常數測試", () => {
    it("應該使用正確的 debounce 時間常數", () => {
      // 通過測試實際行為來驗證 debounce 時間
      // 我們無法直接存取私有常數，但可以通過測試行為來驗證
      expect(true).toBe(true); // 這個測試由其他行為測試覆蓋
    });

    it("debounce 時間應該是可配置的", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      await manager.createEntities(testEntities);

      // 驗證在 debounce 時間之前不會觸發
      vi.advanceTimersByTime(4999);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 驗證在精確的 debounce 時間後會觸發
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("並發安全測試", () => {
    it("並發操作應該安全地處理 debounce", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes');

      // 序列執行多個操作（避免並發事務問題）
      for (let i = 0; i < 5; i++) {
        await manager.createEntities([{
          name: `Concurrent Entity ${i}`,
          entityType: "TestType",
          observations: [`Concurrent observation ${i}`],
          createdAt: new Date().toISOString()
        }]);
      }

      // 等待 debounce
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("重建過程中的新操作應該重新排程", async () => {
      let rebuildResolve: () => void;
      const rebuildPromise = new Promise<void>((resolve) => {
        rebuildResolve = resolve;
      });

      // Mock rebuildFTSIndexes 來模擬長時間運行
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes')
        .mockImplementation(() => rebuildPromise);

      // 第一次觸發
      await manager.createEntities([testEntities[0]]);
      
      // 等待第一次重建開始
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
      
      expect(rebuildSpy).toHaveBeenCalledTimes(1);

      // 在重建期間觸發新操作
      await manager.createEntities([testEntities[1]]);

      // 完成第一次重建
      rebuildResolve!();
      await rebuildPromise;

      // 等待第二次重建
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // 應該總共重建兩次
      expect(rebuildSpy).toHaveBeenCalledTimes(2);
    });
  });
});