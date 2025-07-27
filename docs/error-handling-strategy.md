# 錯誤處理策略文檔

## 概述
本專案採用分層錯誤處理策略，根據操作的重要性和影響範圍決定是否拋出異常。

## 策略分類

### 1. 關鍵操作 (Critical Operations)
**特徵**: 主要業務邏輯，失敗會影響資料一致性
**處理**: 記錄錯誤 + 拋出異常
**範例**: 
- 創建實體失敗 (`createEntities`)
- 主要資料庫操作失敗
- 事務提交失敗

```typescript
try {
  await conn.run("INSERT INTO entities ...", params);
} catch (error: unknown) {
  this.logger.error("Error creating entities", extractError(error));
  throw error; // 必須拋出，影響資料完整性
}
```

### 2. 清理操作 (Cleanup Operations)  
**特徵**: 輔助性質，失敗不影響主要功能
**處理**: 記錄錯誤 + 繼續執行
**範例**:
- 刪除實體時的關聯資料清理 (`deleteEntities`)
- 索引更新失敗
- 非關鍵的附加操作

```typescript
// 清理關聯的 observations（非關鍵）
try {
  await conn.run("DELETE FROM observations WHERE entityName IN ...");
} catch (error: unknown) {
  this.logger.error("Error deleting observations", extractError(error));
  // 繼續執行，不影響主要的實體刪除操作
}

// 主要操作（關鍵）
await conn.run("DELETE FROM entities WHERE name IN ...");
```

### 3. 查詢操作 (Query Operations)
**特徵**: 讀取操作，失敗時返回安全的預設值
**處理**: 記錄錯誤 + 返回空結果
**範例**:
- 搜尋失敗時返回空陣列
- 統計查詢失敗時返回 0

```typescript
try {
  const result = await conn.runAndReadAll("SELECT ...");
  return processResult(result);
} catch (error: unknown) {
  this.logger.error("Search query failed", extractError(error));
  return []; // 安全的預設值
}
```

## 實作指南

### 決策樹
```
操作失敗
    ↓
是否為關鍵操作？
    ├─ 是 → 記錄錯誤 + 拋出異常
    └─ 否 → 檢查操作類型
        ├─ 清理操作 → 記錄錯誤 + 繼續執行
        └─ 查詢操作 → 記錄錯誤 + 返回安全預設值
```

### 程式碼範例

#### ✅ 正確的關鍵操作錯誤處理
```typescript
async createEntities(entities: Entity[]): Promise<Entity[]> {
  try {
    await conn.run("BEGIN TRANSACTION");
    // ... 主要邏輯
    await conn.run("COMMIT");
    return result;
  } catch (error: unknown) {
    await conn.run("ROLLBACK");
    this.logger.error("Error creating entities", extractError(error));
    throw error; // 必須拋出
  }
}
```

#### ✅ 正確的清理操作錯誤處理
```typescript
async deleteEntities(entityNames: string[]): Promise<void> {
  // 非關鍵清理操作
  try {
    await conn.run("DELETE FROM observations WHERE ...");
  } catch (error: unknown) {
    this.logger.error("Error deleting observations", extractError(error));
    // 繼續執行，不拋出異常
  }
  
  // 關鍵主要操作
  await conn.run("DELETE FROM entities WHERE ...");
}
```

#### ✅ 正確的查詢操作錯誤處理
```typescript
async searchNodes(query: string): Promise<KnowledgeGraph> {
  try {
    // ... 搜尋邏輯
    return { entities, relations };
  } catch (error: unknown) {
    this.logger.error("Search failed", extractError(error));
    return { entities: [], relations: [] }; // 安全預設值
  }
}
```

## 維護注意事項

1. **新增錯誤處理時，先確定操作類型**
2. **關鍵操作必須保證資料一致性**
3. **所有錯誤都要記錄，便於除錯**
4. **測試要涵蓋各種錯誤場景**

## 常見反模式

### ❌ 錯誤的錯誤處理
```typescript
// 不好：關鍵操作不拋出異常
try {
  await conn.run("INSERT INTO entities ...");
} catch (error) {
  this.logger.error("Failed to create entity");
  // 缺少 throw，可能導致資料不一致
}

// 不好：清理操作拋出異常阻止主要功能
try {
  await conn.run("DELETE FROM observations ...");
} catch (error) {
  this.logger.error("Failed to clean observations");
  throw error; // 不應該拋出，會阻止實體刪除
}
```

這種策略確保系統在部分功能失敗時仍能提供核心功能，同時保證資料的一致性和完整性。