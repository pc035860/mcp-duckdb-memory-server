# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

這是一個 MCP DuckDB Memory Server 專案，提供基於 DuckDB 的持久化知識圖譜記憶體服務。專案採用主/次服務器架構（Main/Secondary Server Architecture），支援多個 MCP 客戶端共享同一個知識圖譜。

## 常用開發命令

### 基本開發流程
```bash
# 安裝依賴（必須使用 pnpm）
pnpm install

# 開發模式（熱重載）
pnpm dev

# 構建專案
pnpm build

# 執行構建後的程式
pnpm start

# 啟用除錯模式（詳細日誌）
DEBUG=1 pnpm start

# 提高 FTS 使用門檻（大資料集才用 FTS）
ENTITY_COUNT_THRESHOLD=2000 pnpm start

# 總是使用 FTS 搜尋
ENTITY_COUNT_THRESHOLD=0 pnpm start

# 執行測試
pnpm test

# 執行特定測試（推薦寫法）
pnpm test tests/specific.test.ts

# 需要詳細輸出時
pnpm test tests/specific.test.ts -- --reporter=verbose

# 測試覆蓋率
pnpm test:coverage

# 程式碼格式化
pnpm format

# 檢查格式
pnpm format:check

# 類型檢查
pnpm typecheck
```

### Docker 相關
```bash
# 構建 Docker 映像
docker build -t mcp-duckdb-memory-server .

# 執行 Docker Compose（多服務器部署）
docker-compose up -d

# 查看服務日誌
docker-compose logs -f
```

## 架構說明

### 主/次服務器架構
- **Main Server**: 擁有 DuckDB 實例，透過 Unix Domain Socket 提供 IPC 服務
- **Secondary Server**: 提供 MCP 介面，將請求轉發給 Main Server
- 這種架構允許多個 MCP 客戶端（如 Claude Desktop）共享同一個知識圖譜

### 核心模組結構
```
src/
├── config/         # ServerConfig 類別，管理服務器配置
├── managers/       
│   ├── DuckDBManager.ts    # 主服務器的資料庫管理器
│   └── ProxyManager.ts     # 次服務器的代理管理器
├── queue/          # RequestQueue 實作請求序列化
├── servers/
│   ├── MainServer.ts       # 主服務器實作
│   ├── SecondaryServer.ts  # 次服務器實作
│   └── ipc/               # IPC 通訊協議定義
└── index.ts       # 入口點，根據配置啟動對應服務器
```

### 關鍵設計決策
1. **請求序列化**: 使用 RequestQueue 確保 DuckDB 操作的原子性
2. **IPC 通訊**: 使用 Unix Domain Socket 進行高效的本地通訊
3. **自動重連**: Secondary Server 會自動重試連接 Main Server
4. **環境配置**: 透過環境變數靈活配置服務器模式和參數

## 開發注意事項

### TypeScript 配置
- 使用 ES2022 目標
- 啟用嚴格模式
- 模組系統：ESM (type: "module")
- 路徑別名：使用 `@/` 對應 `src/`

### 測試策略
- 使用 Vitest 進行單元測試
- 測試檔案位於 `tests/` 目錄
- Mock DuckDB 連線以避免測試間干擾
- 測試 IPC 通訊時使用臨時 socket 路徑

### 資料庫操作
- 所有資料庫操作都必須透過 RequestQueue
- 使用 prepared statements 提升效能
- 實體名稱使用小寫以確保一致性

### 向量搜尋（VSS）與 Embeddings（Strategy C）
- 實體向量的單一真相（SoT）改為 `entity_embeddings` 外掛表。
- 系統會自動偵測該表是否存在；若存在則：
  - 搜尋來源：JOIN `entity_embeddings` → `entities`
  - HNSW 索引：`entity_embeddings_embedding_idx`
  - 統計/健康檢查：基於 `entity_embeddings`
  - 寫入/清理：優先操作 `entity_embeddings`
- 新增實體時，會 upsert 佔位列到 `entity_embeddings`（embedding 可稍後補齊）。

#### Backfill 工具使用
```bash
# 建議以 Strategy C 執行 entities backfill
BACKFILL_TARGET=entities \
BACKFILL_ENTITIES_WORKAROUND=strategyC \
OPENAI_API_KEY=$OPENAI_API_KEY \
node dist/tools/backfill-embeddings.mjs
```

#### 檢查
```sql
SELECT COUNT(*) FROM entity_embeddings;
SELECT e.name FROM entities e JOIN entity_embeddings ee ON ee.name = e.name LIMIT 5;
```

### FTS（全文搜尋）功能
- **DuckDB FTS 擴展**：自動載入並啟用 BM25 搜尋算法
- **混合搜尋策略**：
  - 小資料集（< 1000 實體）：使用 SQL LIKE 搜尋
  - 大資料集（≥ 1000 實體）：使用 DuckDB FTS 搜尋
- **自動索引管理**：
  - FTS Debounce 自動重建機制（5 秒延遲）
  - 資料變更後自動觸發索引更新
  - 智慧跳過機制（FTS 未啟用或實體數量不足時）
- **FTS 清理機制**：
  - 啟動時自動清理孤立的 FTS 引用
  - 智慧檢測並移除遷移過程中產生的殘留索引
  - 支援手動修復功能（repair-database 工具）
  - 處理 DuckDB FTS 靜態表引用問題
- **API 支援**：
  - `rebuildFTSIndexes()`：手動重建 FTS 索引
  - `checkFTSIndexHealth()`：檢查索引健康狀態
  - `getFTSInfo()`：查詢 FTS 配置和統計資訊
  - `cleanupStaleFTSReferences()`：清理孤立的 FTS 引用

### 錯誤處理
- 使用 Zod 進行輸入驗證
- 自訂錯誤類型（如 MCPError）
- 適當的錯誤日誌記錄（使用 logger.ts）

### 資料庫遷移與 FTS 管理
- **遷移流程**：
  1. 啟動時檢查資料庫版本和結構
  2. 自動清理遷移殘留檔案（`*_new`, `*_backup`, `*_temp` 表）
  3. 清除孤立的 FTS 索引和 schemas
  4. 執行必要的結構更新
  5. 重建 FTS 索引確保正確引用
- **FTS 索引管理特點**：
  - DuckDB FTS 使用靜態表引用，不會自動跟隨表重命名
  - 索引存儲在獨立 schema 中（格式：`fts_{schema}_{table}`）
  - 遷移前必須刪除舊索引，遷移後重建新索引
  - 系統會自動檢測並清理 `observations_new` 等臨時表的 FTS 殘留

### 故障排除與修復
- **常見 FTS 錯誤**：
  - `Table with name observations_new does not exist`：遷移後 FTS 索引仍引用舊表
  - 解決方法：系統會自動在啟動時清理，或使用 repair-database 工具
- **手動修復工具**：
  ```bash
  # 執行資料庫修復（清理殘留資源）
  pnpm repair-database
  
  # 或透過程式碼直接呼叫
  node -e "require('./dist/tools/repair-database.js').main()"
  ```
- **除錯模式**：
  ```bash
  # 啟用詳細 FTS 除錯日誌
  DEBUG=1 pnpm start
  ```

## Git Commit 規範

本專案使用 Conventional Commits 格式：

### 格式
```
<type>(<scope>): <description>
```

### 類型 (type)
- `feat`: 新功能
- `fix`: 錯誤修復
- `docs`: 文件更新
- `style`: 程式碼風格調整（不影響功能）
- `refactor`: 重構（既不是修復錯誤也不是新增功能）
- `test`: 測試相關
- `chore`: 建構程序或輔助工具的變動
- `perf`: 效能改進
- `build`: 影響建構系統或外部依賴的變更
- `ci`: CI 配置檔案和腳本的變更

### 範圍 (scope)
- `architecture`: 架構相關變更
- `manager`: 管理器相關（DuckDBManager, ProxyManager）
- `types`: TypeScript 類型定義
- `search`: 搜尋功能（包含 FTS 和混合搜尋）
- `fts`: FTS 全文搜尋相關（索引、重建、debounce 機制）
- `queue`: 請求佇列
- `ipc`: IPC 通訊
- `config`: 配置相關
- `docker`: Docker 相關

### 範例
```bash
feat(architecture): implement multi-server mode with Docker support and IPC communication
fix(manager): improve database migration compatibility and ensure timestamp consistency
feat(types): expose createdAt timestamp in Entity interface
feat(fts): implement DuckDB hybrid search with LIKE and FTS strategies
feat(fts): add FTS debounce auto-rebuild mechanism with 5-second delay
docs(manager): add instance lifecycle management documentation
```

## 部署注意事項

### Docker 部署
- 基礎映像：node:22-slim
- 記憶體檔案掛載：`/app/memory`
- 健康檢查：透過 MCP 工具呼叫

### 環境變數
```bash
SERVER_MODE=main|secondary     # 服務器模式
MEMORY_FILE_PATH=./memory.db  # DuckDB 檔案路徑
IPC_SOCKET_PATH=/tmp/mcp.sock # Unix socket 路徑
QUEUE_MAX_SIZE=100            # 請求佇列大小
QUEUE_TIMEOUT_MS=30000        # 請求逾時（毫秒）
DEBUG=1|true                  # 除錯模式（啟用詳細日誌和配置顯示）

# FTS 搜尋相關配置
ENTITY_COUNT_THRESHOLD=1000   # 搜尋策略切換閾值（< 閾值用LIKE，≥ 閾值用FTS）
                             # 設為 0 則總是使用 FTS；設為很大值則偏好 LIKE

# Embedding 自動生成配置（non-blocking 即時 embedding）
EMBEDDING_AUTO_GENERATE=true      # 是否啟用自動 embedding 生成（預設：true）
EMBEDDING_DEBOUNCE_MS=3000         # embedding 生成去抖動延遲（毫秒，預設：3000）
EMBEDDING_BATCH_SIZE=10            # embedding 批次處理大小（預設：10）
EMBEDDING_MAX_RETRIES=3            # embedding 生成最大重試次數（預設：3）
OPENAI_API_KEY=your_api_key_here   # OpenAI API 金鑰（VSS 功能必需）

# Output Compaction 預設（Phase 2/2.5）
OUTPUT_COMPACT=true                    # 預設啟用 compact（僅索引級資料）
OUTPUT_INCLUDE_OBSERVATIONS=false      # 預設不回傳 observations 內容
OUTPUT_MAX_ENTITIES=20                 # 回傳的實體上限
OUTPUT_MAX_OBS_PER_ENTITY=3            # 每實體 observations 上限（產生 preview）
OUTPUT_SNIPPET_CHARS=280               # preview 每段的最大字元數
OUTPUT_INCLUDE_RELATIONS=subset        # relations 回傳策略：none|subset|all
OUTPUT_MAX_RELATIONS=200               # relations 上限（subset 時生效）
RESPONSE_MAX_CHARS=50000               # 回應最大字元數守門員（觸發漸進式截斷）
```

> 注意：上述 Output Compaction 相關環境變數僅影響「搜尋類工具」的輸出（`search_nodes`、`search_multi_keywords`）。`open_nodes` 不受這些環境變數影響，其 `includeObservations` 由工具參數控制，且為了向後相容預設值為 `true`。

### Claude Desktop 整合
配置檔案位於 `~/Library/Application Support/Claude/claude_desktop_config.json`
- Main Server 配置使用環境變數
- Secondary Server 配置需指定 IPC socket 路徑

## Output Compaction 與 open_nodes 說明（Phase 2/2.5）

- 預設 compact：`OUTPUT_COMPACT=true` 與 `OUTPUT_INCLUDE_OBSERVATIONS=false`，搜尋結果僅含索引級資料。
- 觀察片段（preview）：`OUTPUT_MAX_OBS_PER_ENTITY` 與 `OUTPUT_SNIPPET_CHARS` 控制預覽段數與長度。
- Relations 限縮：以 `OUTPUT_INCLUDE_RELATIONS` 與 `OUTPUT_MAX_RELATIONS` 控制返回的關聯數量。
- 回應守門員：超過 `RESPONSE_MAX_CHARS` 會進行漸進式截斷（先移除 observations 內容、再限縮 relations、最後限縮 entities），並標記 `truncated: true`。
- 開啟完整觀察：
  - 以工具 `open_nodes` 並設定 `includeObservations=true` 取得完整觀察內容（預設即為 true，相容舊版）。
  - 搜尋時也可透過 `options.output.includeObservations=true` 覆寫預設。
