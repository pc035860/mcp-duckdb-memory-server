---
title: "修正 TypeScript 類型錯誤"
type: "complex"
status: "planning"
priority: "medium"
created: "2025-07-24"
estimated_hours: 3
tags:
  - "typescript"
  - "code-quality"
  - "bug-fix"
---

# 修正 TypeScript 類型錯誤

## 1. 背景與目標
**問題：** 執行 `pnpm typecheck` 發現 18 個 TypeScript 類型錯誤，主要包括隱式 any 類型、Fuse.js API 使用錯誤、以及類型轉換問題
**目標：** 解決所有類型錯誤，提升程式碼的類型安全性和開發體驗

## 2. 技術方案
**方法：** 分類修正不同類型的錯誤，添加適當的類型註解和修正 API 使用方式
**關鍵決策：** 保持現有功能不變，僅修正類型問題

## 3. 實作步驟

### 階段一：修正隱式 any 類型錯誤（12個錯誤）
- [ ] 在 `src/manager.ts` 中為資料庫查詢回調的 `row` 參數添加類型註解
- [ ] 在 `src/managers/duckdb-manager.ts` 中為相同問題添加類型註解
- [ ] 定義 `DatabaseRow` interface 來統一資料庫查詢結果的類型
- [ ] 確保所有 map/forEach 回調參數都有明確的類型

### 階段二：修正 Fuse.js 相關錯誤（6個錯誤）
- [ ] 檢查當前 Fuse.js 版本和正確的 API 使用方式
- [ ] 修正 `fuse.options` 的訪問方式（可能需改為 `fuse.getOptions()` 或直接移除）
- [ ] 修正 `Fuse.FuseResult` 類型引用方式，改為正確的類型導入
- [ ] 測試修正後的搜尋功能是否正常運作

### 階段三：修正類型轉換錯誤（2個錯誤）
- [ ] 在 `src/managers/proxy-manager.ts` 中添加適當的類型斷言或類型守衛
- [ ] 確保 `unknown` 類型在使用前經過適當的類型檢查
- [ ] 測試 ProxyManager 的 IPC 通訊功能

## 4. 測試策略
- **類型檢查：** 執行 `pnpm typecheck` 確認無類型錯誤
- **功能測試：** 執行 `pnpm test` 確保現有功能不受影響
- **手動驗證：** 測試搜尋功能和 IPC 通訊是否正常

## 5. 成功指標
- `pnpm typecheck` 執行成功無錯誤
- 所有單元測試通過
- 程式碼的類型安全性得到提升

## 6. 時程
- **預估：** 3 小時
- **里程碑：** 每個階段完成後執行 typecheck 驗證進度

## 7. 補充說明
這些類型錯誤不會影響運行時功能，但會影響開發體驗和程式碼品質。修正後將提供更好的 IDE 支援和類型提示。