# VSS R2 遷移測試指南

## 概述

這份指南提供了 VSS R2 資料庫遷移驗證的完整測試框架。透過建立各種測試情境的資料庫，我們可以確保遷移系統在不同條件下都能安全、可靠地執行。

## 測試情境

### 1. 空資料庫情境 (Empty)
- **目的**：測試全新安裝的遷移執行
- **特徵**：完全空白的資料庫，無任何表或資料
- **測試重點**：MigrationManager 初始化和 schema_migrations 表創建

### 2. 小型資料庫情境 (Small)
- **目的**：測試有少量資料的遷移安全性
- **資料規模**：15 個實體，75 個觀察，8 個關係
- **測試重點**：資料完整性保護，欄位新增不影響現有資料

### 3. 大型資料庫情境 (Large)
- **目的**：測試生產規模資料的遷移效能
- **資料規模**：1200+ 實體，6000+ 觀察，2500+ 關係
- **測試重點**：遷移效能、記憶體使用、執行時間

### 4. 特殊字元資料情境 (Special-Chars)
- **目的**：測試多語言和特殊字元的相容性
- **特殊資料**：Unicode 字元、中日韓文字、阿拉伯文、表情符號
- **測試重點**：資料編碼安全性、embedding 相容性

### 5. 邊界條件情境 (Edge-Cases)
- **目的**：測試系統邊界和錯誤處理
- **包含**：空字串、極長內容、特殊時間戳、NULL 值
- **測試重點**：錯誤處理機制、邊界值安全性

## 快速開始

### 1. 安裝依賴
```bash
# 安裝專案依賴
pnpm install

# 構建專案
pnpm build
```

### 2. 生成測試資料庫
```bash
# 生成所有測試情境
pnpm generate-test-scenarios

# 生成特定情境
pnpm generate-test-scenarios -- --scenario=small

# 指定輸出目錄
pnpm generate-test-scenarios -- --output=./my-tests
```

### 3. 驗證測試資料
```bash
# 驗證所有生成的測試資料
pnpm validate-test-data

# 驗證特定情境
pnpm validate-test-data -- --scenario=large
```

### 4. 執行完整測試套件
```bash
# 執行完整的遷移測試（生成 + 驗證 + 遷移測試）
pnpm test:migration
```

## 詳細使用說明

### 測試資料生成器

生成器會建立以下檔案結構：

```
test-scenarios/
├── test-migration-empty.db          # 空資料庫
├── test-migration-small.db          # 小型資料庫
├── test-migration-large.db          # 大型資料庫
├── test-migration-special-chars.db  # 特殊字元資料庫
├── test-migration-edge-cases.db     # 邊界條件資料庫
├── empty-validation.json            # 各情境的驗證配置
├── small-validation.json
├── large-validation.json
├── special-chars-validation.json
├── edge-cases-validation.json
├── run-migration-tests.ts           # 遷移測試執行腳本
└── package.json                     # 測試套件配置
```

### 測試資料驗證工具

驗證工具會檢查：

- ✅ 基本表結構（entities、observations、relations、schema_migrations）
- ✅ 資料數量是否符合預期（10% 容差範圍內）
- ✅ 資料完整性（無孤立記錄）
- ✅ 時間戳格式正確性
- ✅ 特殊功能驗證（Unicode、邊界條件等）
- ✅ 外鍵約束完整性

### 遷移測試執行器

遷移測試會：

1. **記錄遷移前狀態**：統計實體、觀察、關係數量
2. **執行遷移**：呼叫 `migrate-database` 工具
3. **驗證遷移結果**：
   - schema_migrations 表包含版本 1
   - entities 表包含 `embedding_vector` 欄位
   - 資料數量保持一致
   - 執行自定義驗證查詢
4. **生成測試報告**：包含測試結果、執行時間、錯誤詳情

## 命令列選項

### 測試資料生成器
```bash
tsx src/tools/test-scenario-generator.ts [options]

選項:
  --help          顯示幫助資訊
  --scenario=NAME 只生成特定情境 (empty, small, large, special-chars, edge-cases)
  --output=DIR    指定輸出目錄 (預設: ./test-scenarios)

範例:
  tsx src/tools/test-scenario-generator.ts --scenario=small
  tsx src/tools/test-scenario-generator.ts --output=./my-tests
```

### 測試資料驗證工具
```bash
tsx src/tools/validate-test-data.ts [options]

選項:
  --help           顯示幫助資訊
  --scenario=NAME  只驗證特定情境
  --dir=PATH       指定測試目錄 (預設: ./test-scenarios)

範例:
  tsx src/tools/validate-test-data.ts --scenario=large
  tsx src/tools/validate-test-data.ts --dir=./my-tests
```

## 測試報告

### 驗證報告 (validation-report.json)
```json
{
  "timestamp": "2025-08-28T12:00:00.000Z",
  "summary": {
    "total": 5,
    "passed": 5,
    "totalIssues": 0
  },
  "reports": [
    {
      "scenario": "empty",
      "status": "pass",
      "issues": [],
      "statistics": {
        "entities": 0,
        "observations": 0,
        "relations": 0,
        "uniqueEntityTypes": 0,
        "avgObservationsPerEntity": 0
      },
      "sampleData": {...}
    }
  ]
}
```

### 遷移測試報告 (migration-test-report.json)
```json
{
  "timestamp": "2025-08-28T12:30:00.000Z",
  "summary": {
    "total": 5,
    "passed": 5,
    "failed": 0
  },
  "results": [
    {
      "scenario": "small",
      "success": true,
      "errors": [],
      "timings": {
        "migrationTime": 234,
        "validationTime": 45
      },
      "counts": {
        "before": {"entities": 15, "observations": 75, "relations": 8},
        "after": {"entities": 15, "observations": 75, "relations": 8}
      }
    }
  ]
}
```

## 故障排除

### 常見問題

1. **生成器失敗：「資料庫檔案被鎖定」**
   ```bash
   # 清理舊的測試檔案
   cd test-scenarios
   npm run clean
   ```

2. **遷移測試失敗：「找不到遷移工具」**
   ```bash
   # 確保專案已建置
   pnpm build
   
   # 檢查遷移工具是否存在
   ls -la dist/tools/migrate-database.mjs
   ```

3. **驗證失敗：「資料數量不符」**
   - 檢查生成器是否正確執行
   - 確認資料庫檔案未被其他程序修改
   - 查看詳細錯誤訊息以了解具體差異

### 除錯技巧

```bash
# 啟用詳細日誌
DEBUG=1 tsx src/tools/test-scenario-generator.ts

# 檢查生成的資料庫
sqlite3 test-scenarios/test-migration-small.db ".tables"
sqlite3 test-scenarios/test-migration-small.db "SELECT COUNT(*) FROM entities;"

# 手動執行遷移測試單個步驟
cd test-scenarios
tsx run-migration-tests.ts
```

## 測試最佳實踐

### 1. 測試環境隔離
- 使用獨立的測試目錄
- 每次測試前清理舊檔案
- 避免與開發資料庫混淆

### 2. 數據完整性驗證
- 遷移前後資料數量必須一致
- 檢查外鍵約束完整性
- 驗證特殊字元處理正確性

### 3. 效能基準測試
- 記錄各情境的執行時間
- 監控記憶體使用情況
- 設定合理的逾時閾值

### 4. 錯誤處理驗證
- 測試中斷恢復機制
- 驗證回滾功能
- 檢查錯誤日誌完整性

## 集成 CI/CD

### GitHub Actions 範例
```yaml
name: VSS R2 Migration Tests

on: [push, pull_request]

jobs:
  migration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Build project
        run: pnpm build
      
      - name: Run migration tests
        run: pnpm test:migration
      
      - name: Upload test reports
        uses: actions/upload-artifact@v3
        if: always()
        with:
          name: migration-test-reports
          path: test-scenarios/*-report.json
```

## 進階配置

### 自定義測試情境

要建立自定義測試情境，修改 `src/tools/test-scenario-generator.ts` 中的 `TEST_SCENARIOS` 陣列：

```typescript
export const TEST_SCENARIOS: TestScenario[] = [
  // ... 現有情境
  {
    name: 'my-custom',
    description: '我的自定義測試情境',
    entityCount: 100,
    observationCount: 500,
    relationCount: 50,
    specialFeatures: ['custom_feature']
  }
];
```

### 擴展驗證規則

在驗證工具中添加自定義檢查：

```typescript
// 在 validateScenario 方法中添加
if (expectedConfig.specialFeatures.includes('custom_feature')) {
  // 執行自定義驗證邏輯
  const customCheck = db.prepare('SELECT ... FROM ...').get();
  if (customCheck.condition) {
    report.issues.push('自定義驗證失敗');
  }
}
```

## 總結

這個測試框架提供了完整的 VSS R2 遷移驗證能力：

- ✅ **全面的測試覆蓋**：5種不同情境，涵蓋各種使用場景
- ✅ **自動化測試流程**：從生成到驗證到遷移的完整自動化
- ✅ **詳細的報告系統**：JSON 格式的結構化測試報告
- ✅ **靈活的配置選項**：支援自定義情境和驗證規則
- ✅ **完整的故障排除**：詳細的錯誤訊息和除錯指南

透過這個系統，我們可以確信 VSS R2 遷移在各種生產環境條件下都能安全、可靠地執行。