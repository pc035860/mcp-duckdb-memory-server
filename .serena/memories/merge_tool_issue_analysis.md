# DuckDB Merge Tool 主鍵衝突問題分析

## 問題描述
用戶遇到錯誤：`PRIMARY KEY or UNIQUE constraint violation: duplicate key "merp-frontend:product-import-feature"`

## 當前邏輯問題 (第 155-184 行)
當前的 entities merge 邏輯：
1. 先插入 source1 的所有 entities (第 155-160 行)
2. 再插入 source2 中不存在的 entities (第 164-171 行)  
3. 然後更新已存在的 entities (第 174-184 行)

**問題根源**: 如果 source1 內部就有重複的 entity name，第一步就會失敗

## 相同問題也存在於
- observations merge (第 190-224 行)
- relations merge (第 231-267 行)

## 需要的解決方案
使用去重邏輯，比如：
- 使用 INSERT OR REPLACE 語法
- 或者先合併兩個 source 的資料並去重，然後一次性插入
- 確保保留最早的 created_at 時間戳記