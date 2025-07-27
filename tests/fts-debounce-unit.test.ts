import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { Entity, Observation } from "../src/types";
import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";

describe("FTS Debounce 機制單元測試", () => {
  // 測試檔案路徑
  const testDbPath = join(process.cwd(), "tmp", "test-fts-debounce-unit.db");
  let manager: DuckDBKnowledgeGraphManager;

  // 測試資料
  const testEntities: Entity[] = [
    {
      name: "Test Entity 1",
      entityType: "TestType",
      observations: ["Test observation 1"]
    }
  ];

  const testObservations: Observation[] = [
    {
      entityName: "Test Entity 1",
      contents: ["New observation"]
    }
  ];

  beforeEach(async () => {
    // 確保測試目錄存在
    const tmpDir = join(process.cwd(), "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }

    // 清理現有測試檔案
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // 創建管理器（使用低閾值確保 FTS 啟用）
    manager = new DuckDBKnowledgeGraphManager(() => testDbPath, undefined, false, 0);
    await manager.initialize();

    // Mock 時間函數
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();

    if (manager && !manager.closed) {
      await manager.close();
    }

    // 清理測試檔案
    if (existsSync(testDbPath)) {
      try {
        unlinkSync(testDbPath);
      } catch (error) {
        // 忽略清理錯誤
      }
    }

    vi.clearAllMocks();
  });

  describe("Debounce 機制核心功能", () => {
    it("應該在操作後延遲觸發重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 觸發操作
      await manager.createEntities(testEntities);

      // 確認還未立即執行重建
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進 4.9 秒，仍未觸發
      vi.advanceTimersByTime(4900);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進到 5 秒，應該觸發
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("連續操作應該重置 debounce 計時器", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 第一次操作
      await manager.createEntities(testEntities);

      // 等待 3 秒
      vi.advanceTimersByTime(3000);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 第二次操作（應該重置計時器）
      await manager.addObservations(testObservations);

      // 再等待 3 秒（總共 6 秒，但計時器被重置）
      vi.advanceTimersByTime(3000);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 再等待 2 秒（第二次操作後的 5 秒）
      vi.advanceTimersByTime(2000);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("多次快速操作應該只觸發一次重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 連續執行多次操作
      await manager.createEntities(testEntities);
      await manager.addObservations(testObservations);
      await manager.deleteEntities(["Test Entity 1"]);

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("邊界情況處理", () => {
    it("管理器關閉時應該跳過重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.createEntities(testEntities);
      
      // 關閉管理器
      await manager.close();

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 不應該嘗試重建
      expect(rebuildSpy).not.toHaveBeenCalled();
    });

    it("重建失敗時不應該影響後續操作", async () => {
      // Mock rebuildFTSIndexes 拋出錯誤
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes')
        .mockImplementation(() => Promise.reject(new Error("重建失敗")));

      // 這個操作應該成功，即使後續的重建失敗
      const result = await manager.createEntities(testEntities);
      expect(result).toBeDefined();

      // 等待 debounce 並觸發重建
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      
      // 管理器應該仍然可用
      expect(manager.closed).toBe(false);

      // 後續操作應該仍然可以執行
      rebuildSpy.mockResolvedValue(); // 重置 mock
      const result2 = await manager.addObservations(testObservations);
      expect(result2).toBeDefined();
    });

    it("close() 方法應該清理計時器", async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      // 觸發操作（會設置計時器）
      await manager.createEntities(testEntities);
      expect(setTimeoutSpy).toHaveBeenCalled();

      // 關閉管理器應該清理計時器
      await manager.close();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("計時器管理", () => {
    it("多次觸發應該正確管理計時器", async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 第一次觸發
      await manager.createEntities(testEntities);

      // 第二次觸發應該清理前一個計時器
      await manager.addObservations(testObservations);
      
      // clearTimeout 應該被調用來清理前一個計時器
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // 最終應該只觸發一次重建
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("並發操作應該安全地處理計時器", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 並發執行多個操作
      const operations = [
        manager.createEntities([{ name: "Entity 1", entityType: "Type", observations: ["Obs 1"] }]),
        manager.createEntities([{ name: "Entity 2", entityType: "Type", observations: ["Obs 2"] }]),
        manager.createEntities([{ name: "Entity 3", entityType: "Type", observations: ["Obs 3"] }])
      ];

      await Promise.all(operations);

      // 等待 debounce
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("FTS 狀態檢查", () => {
    it("應該正確報告 FTS 狀態", async () => {
      const ftsInfo = await manager.getFTSInfo();
      
      // 驗證 FTS 資訊結構
      expect(ftsInfo).toHaveProperty('enabled');
      expect(ftsInfo).toHaveProperty('extensionLoaded');
      expect(ftsInfo).toHaveProperty('searchStrategy');
      expect(ftsInfo).toHaveProperty('indexCount');
      
      // 由於閾值設為 0，FTS 應該啟用
      expect(ftsInfo.enabled).toBe(true);
      expect(ftsInfo.searchStrategy).toBe('BM25');
    });

    it("高閾值時應該停用 FTS", async () => {
      // 關閉現有管理器
      await manager.close();
      
      // 創建新管理器，使用高閾值
      const highThresholdPath = join(process.cwd(), "tmp", "test-high-threshold.db");
      if (existsSync(highThresholdPath)) {
        unlinkSync(highThresholdPath);
      }
      
      manager = new DuckDBKnowledgeGraphManager(() => highThresholdPath, undefined, false, 10000);
      await manager.initialize();

      const ftsInfo = await manager.getFTSInfo();
      expect(ftsInfo.enabled).toBe(false);
      expect(ftsInfo.searchStrategy).toBe('ILIKE');
    });
  });

  describe("實際操作觸發測試", () => {
    it("createEntities 應該觸發 debounce", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.createEntities(testEntities);

      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("addObservations 應該觸發 debounce", async () => {
      // 先創建實體
      await manager.createEntities(testEntities);
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.addObservations(testObservations);

      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("deleteEntities 應該觸發 debounce", async () => {
      // 先創建實體
      await manager.createEntities(testEntities);
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.deleteEntities(["Test Entity 1"]);

      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("deleteObservations 應該觸發 debounce", async () => {
      // 先創建實體和觀察
      await manager.createEntities(testEntities);
      await manager.addObservations(testObservations);
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.deleteObservations(["Test Entity 1"], ["New observation"]);

      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("效能和優化", () => {
    it("批量操作應該優化重建頻率", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      // 模擬批量操作
      const batchSize = 10;
      for (let i = 0; i < batchSize; i++) {
        await manager.createEntities([{
          name: `Batch Entity ${i}`,
          entityType: "BatchType",
          observations: [`Batch observation ${i}`]
        }]);
        
        // 短暫延遲（小於 debounce 時間）
        vi.advanceTimersByTime(100);
      }

      // 等待 debounce 完成
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 儘管有多次操作，應該只重建一次
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("debounce 時間應該符合設計預期", () => {
      // 測試驗證 5 秒的 debounce 時間
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      manager.createEntities(testEntities);

      // 在 4999ms 時不應觸發
      vi.advanceTimersByTime(4999);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 在 5000ms 時應該觸發
      vi.advanceTimersByTime(1);
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });
});