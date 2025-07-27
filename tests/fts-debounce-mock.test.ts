import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { Entity, Observation } from "../src/types";
import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";

describe("FTS Debounce 機制 Mock 測試", () => {
  // 測試檔案路徑
  const testDbPath = join(process.cwd(), "tmp", "test-fts-debounce-mock.db");
  let manager: DuckDBKnowledgeGraphManager;

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

    // 使用獨特的檔案名避免衝突
    const uniquePath = `${testDbPath}.${Date.now()}.${Math.random()}`;
    
    // 創建管理器
    manager = new DuckDBKnowledgeGraphManager(() => uniquePath, undefined, false, 0);
    
    // Mock 時間函數
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();

    if (manager && !manager.closed) {
      try {
        await manager.close();
      } catch (error) {
        // 忽略關閉錯誤
      }
    }

    vi.clearAllMocks();
  });

  describe("Debounce 計時器行為", () => {
    it("應該正確設置和清理計時器", async () => {
      // Mock 相關方法以避免實際資料庫操作
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();
      const createEntitiesSpy = vi.spyOn(manager, 'createEntities').mockImplementation(async (entities) => {
        // 觸發排程方法（模擬實際行為）
        (manager as any).scheduleIndexRebuild();
        return entities.map(e => ({ ...e, createdAt: new Date().toISOString() }));
      });

      await manager.initialize();

      // 觸發操作
      await manager.createEntities([{
        name: "Test Entity",
        entityType: "TestType",
        observations: ["Test observation"]
      }]);

      // 確認還未立即執行重建
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 快進到 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 確認重建被執行
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("連續觸發應該重置計時器", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();
      
      // Mock scheduleIndexRebuild 方法以便直接測試
      const scheduleIndexRebuildSpy = vi.spyOn(manager as any, 'scheduleIndexRebuild');

      await manager.initialize();

      // 第一次觸發
      (manager as any).scheduleIndexRebuild();
      
      // 等待 3 秒
      vi.advanceTimersByTime(3000);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 第二次觸發（應該重置計時器）
      (manager as any).scheduleIndexRebuild();

      // 再等待 3 秒（總共 6 秒，但計時器被重置）
      vi.advanceTimersByTime(3000);
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 再等待 2 秒（第二次觸發後的 5 秒）
      vi.advanceTimersByTime(2000);
      await vi.runOnlyPendingTimersAsync();

      // 現在應該執行重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("多次快速觸發應該只執行一次重建", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      // 快速連續觸發多次
      for (let i = 0; i < 5; i++) {
        (manager as any).scheduleIndexRebuild();
      }

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("邊界情況處理", () => {
    it("FTS 未啟用時應該跳過排程", async () => {
      // 創建 FTS 未啟用的管理器
      const uniquePath = `${testDbPath}.disabled.${Date.now()}`;
      const disabledManager = new DuckDBKnowledgeGraphManager(() => uniquePath, undefined, false, 10000);
      
      const rebuildSpy = vi.spyOn(disabledManager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(disabledManager, 'initialize').mockResolvedValue();

      await disabledManager.initialize();

      // 嘗試觸發排程
      (disabledManager as any).scheduleIndexRebuild();

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 不應該嘗試重建
      expect(rebuildSpy).not.toHaveBeenCalled();

      await disabledManager.close();
    });

    it("管理器關閉時應該跳過排程", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();
      const closeSpy = vi.spyOn(manager, 'close').mockResolvedValue();

      await manager.initialize();

      // 觸發排程
      (manager as any).scheduleIndexRebuild();
      
      // 關閉管理器
      await manager.close();

      // 等待 debounce 時間
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 不應該嘗試重建
      expect(rebuildSpy).not.toHaveBeenCalled();
    });

    it("重建失敗時不應該影響主流程", async () => {
      // Mock rebuildFTSIndexes 拋出錯誤
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes')
        .mockImplementation(() => Promise.reject(new Error("重建失敗")));
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      // 觸發排程
      (manager as any).scheduleIndexRebuild();

      // 等待 debounce 並觸發重建
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      
      // 管理器應該仍然可用（檢查 closed 屬性）
      expect(manager.closed).toBe(false);
    });
  });

  describe("計時器管理", () => {
    it("close() 方法應該清理計時器", async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.initialize();

      // 觸發排程（會設置計時器）
      (manager as any).scheduleIndexRebuild();

      // 關閉管理器應該清理計時器
      await manager.close();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it("多次觸發應該正確清理前一個計時器", async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      // 第一次觸發
      (manager as any).scheduleIndexRebuild();

      // 第二次觸發應該清理前一個計時器
      (manager as any).scheduleIndexRebuild();
      
      // clearTimeout 應該被調用來清理前一個計時器
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // 最終應該只觸發一次重建
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Debounce 時間驗證", () => {
    it("應該在精確的 5 秒後觸發", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      (manager as any).scheduleIndexRebuild();

      // 在 4999ms 時不應觸發
      vi.advanceTimersByTime(4999);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).not.toHaveBeenCalled();

      // 在 5000ms 時應該觸發
      vi.advanceTimersByTime(1);
      await vi.runOnlyPendingTimersAsync();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });

    it("應該正確處理並發排程請求", async () => {
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      // 同時觸發多次排程
      for (let i = 0; i < 10; i++) {
        (manager as any).scheduleIndexRebuild();
      }

      // 等待 debounce
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();

      // 應該只觸發一次重建
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("錯誤處理", () => {
    it("計時器設置錯誤時應該正確處理", async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(() => {
        throw new Error("計時器錯誤");
      });
      
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();

      await manager.initialize();

      // 觸發排程不應該拋出錯誤
      expect(() => {
        (manager as any).scheduleIndexRebuild();
      }).not.toThrow();

      setTimeoutSpy.mockRestore();
    });

    it("clearTimeout 錯誤時應該正確處理", async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {
        throw new Error("清理計時器錯誤");
      });
      
      const initializeSpy = vi.spyOn(manager, 'initialize').mockResolvedValue();
      const rebuildSpy = vi.spyOn(manager, 'rebuildFTSIndexes').mockResolvedValue();

      await manager.initialize();

      // 觸發兩次排程（第二次會嘗試清理第一個計時器）
      (manager as any).scheduleIndexRebuild();
      
      // 這不應該拋出錯誤
      expect(() => {
        (manager as any).scheduleIndexRebuild();
      }).not.toThrow();

      clearTimeoutSpy.mockRestore();
    });
  });
});