## Context-Aware Output Compaction & Progressive Disclosure（分階段計畫）

**問題**: MCP 回應有時過大（例如 `search_nodes`、`search_multi_keywords`），包含完整 `observations` 與美化 JSON，導致 Claude context 快速耗盡。

**目標**:
- **降低單次回應字元/Token**，預期常態下降 80%↑。
- **維持資訊完整性**：以漸進式揭露（compact 索引 → `open_nodes` 展開）確保可達完整資訊。
- **無破壞性預設**、可設定（ENV/Options）、可觀測（回應大小、截斷標記）。

**不在範圍**: 不變更 DuckDB 資料路徑/交易/併發模型；嚴守佇列與安全守則。

---

### 依賴與原則
- 併發/佇列：維持 `src/queue/request-queue.ts`、`src/utils/concurrency-controller.ts` 流程；縮小臨界區，不另開連線。
- 安全：固定語句模板、參數化查詢；路徑白名單；禁任意 SQL。
- 查詢策略：延用 LIKE/FTS/BM25 與時間範圍過濾；只在輸出層做壓縮與分頁。

---

### Phase 1 — 快速收益（安全、低風險）
- 最小化 JSON：`secondary-server` 取消 `JSON.stringify(..., null, 2)` 縮排，改最小化字串。
- 統一較低 LIMIT：
  - `searchWithLike` LIMIT 500 → 100（與 `searchWithLikeFallback` 的 LIMIT 100 對齊）。
  - `searchWithMultiKeywordFTS` LIMIT 500 → 100。
  - BM25 最終 `slice(0, 100)` 維持。
- 關聯邊上限：`searchNodes` 聚合邊（`relations`）加上限（例如 200），若超過回傳 `omittedRelations` 計數。
- 觀測：記錄每次 MCP 回應的字元數與是否觸發截斷（log 級別 debug/info）。

修改熱點：
- `src/servers/secondary-server.ts`（序列化）
- `src/managers/duckdb-manager.ts`（LIKE/MultiKeyword LIMIT、relations 上限處理）

驗收標準：
- 回應字元量在常見查詢下降 ≥ 80%。
- 現有測試全部通過（含 `tests/hybrid-search.test.ts` 的 result limit 斷言）。
- 無破壞性：回傳結構不變。

---

### Phase 2 — Compact 預設與觀察片段（非破壞式）
- Options（僅規劃接口）：在 `SearchNodesOptions`/`MultiKeywordSearchOptions` 新增 `output?: OutputLimitOptions`，伺服器提供預設。

```ts
// 僅規劃
type OutputLimitOptions = {
  compact?: boolean;                 // 預設 true：只回傳索引級資料
  includeObservations?: boolean;     // 預設 false
  maxEntities?: number;              // 預設 20 或 50
  maxObservationsPerEntity?: number; // 預設 3
  snippetChars?: number;             // 預設 280
  includeRelations?: 'none' | 'subset' | 'all'; // 預設 'subset'
  maxRelations?: number;             // 預設 200
  maxResponseChars?: number;         // 預設 50_000
};
```

- Compact 行為：
  - 預設 `compact=true` 並 `includeObservations=false`。
  - 每個 `Entity` 回傳 `observationsCount`、`observationsPreview?: string[]`（依 `maxObservationsPerEntity`、`snippetChars` 截取）。
  - 回傳 `omittedObservations`、`omittedEntities`、`omittedRelations` 計數。

- 環境變數（server-config 新增）：
  - `OUTPUT_MAX_ENTITIES=20`
  - `OUTPUT_MAX_OBS_PER_ENTITY=3`
  - `OUTPUT_SNIPPET_CHARS=280`
  - `OUTPUT_INCLUDE_RELATIONS=subset`
  - `OUTPUT_MAX_RELATIONS=200`
  - `RESPONSE_MAX_CHARS=50000`

修改熱點：
- `src/managers/duckdb-manager.ts`（查詢後的輸出整形與截斷）
- `src/types.ts`（為 `Entity`/`KnowledgeGraph` 增加可選欄位，向後相容）
- `src/config/server-config.ts`（output 預設與 ENV）
- `src/servers/secondary-server.ts`（若呼叫端未傳 options，套用伺服器預設）

驗收標準：
- 預設回應不含全量 `observations`，但提供可用的 `observationsPreview` 與計數。
- 在 `RESPONSE_MAX_CHARS` 內自動收斂（優先減少 preview → relations → entities），並標示 `truncated: true`。

---

### Phase 3 — 分頁/游標與逐步展開（`open_nodes`）
- Options（僅規劃接口）：新增 `paging?: { page?: number; pageSize?: number; cursor?: string }`。
- Entities 分頁：`search_nodes` 只回傳本頁，回傳 `paging.nextCursor` 供續請求。
- `open_nodes` 擴充：接受 `maxObservations?: number`, `offset?: number`，支援單一實體的觀察內容分頁。

修改熱點：
- `src/managers/duckdb-manager.ts`（分頁查詢/游標生成、`open_nodes` 分頁）
- `src/servers/ipc/protocol.ts`（Options/schema 擴充，保持相容）
- `src/servers/secondary-server.ts`（將游標/頁碼透傳）

驗收標準：
- 多頁請求無重複/不遺漏；順序穩定（FTS/LIKE 排序一致）。
- `open_nodes` 可逐步載入所有觀察內容，不超出回應上限。

---

### Phase 4 — 片段抽取與回應守門員
- Snippet 策略：以關鍵詞命中附近的前後文截取（純規則，非 LLM 摘要），避免成本與語義漂移。
- 守門員：在輸出序列化前估算回應字元數/近似 Token；若超標依層級收斂，並標記 `truncated: true` 與 `nextCursor`。
- 觀測：記錄截斷層級、收斂次序、最終大小，以便調參。

驗收標準：
- 任意極端查詢不會超過 `RESPONSE_MAX_CHARS`。
- 截斷時提供可追蹤的續傳線索（`nextCursor`/`page`）。

---

### Phase 5 — 預設時間範圍（可覆寫）
- 預設：未指定 `timeRange` 時以 `DEFAULT_TIME_RANGE_DAYS`（例如 180 天）限制，顯著減少結果集。
- 可覆寫：明確傳入 `timeRange` 則使用使用者指定。

驗收標準：
- 在未帶 `timeRange` 的場合，結果數明顯降低且最相關性保持。
- 現有時間範圍測試（`tests/ipc-time-range.test.ts`、`tests/time-filtering.test.ts`）仍通過。

---

### 測試計畫
- 新增 `tests/output-compaction.test.ts`：
  - respects `maxEntities`/`maxRelations`/`maxObservationsPerEntity`/`snippetChars`。
  - 超過 `RESPONSE_MAX_CHARS` 會觸發 `truncated: true` 與收斂階梯。
  - `open_nodes` 分頁可以完整拿到所有觀察內容。
- 既有測試覆核：`tests/hybrid-search.test.ts`、`tests/ipc-time-range.test.ts`、`tests/search-scope.test.ts` 等。

---

### 觀測與指標
- 每次回應紀錄：`responseChars`、`truncated`、`entitiesCount`、`relationsCount`、`omitted*`、`buildStrategy`（LIKE/FTS/BM25）。
- 追蹤第 90 百分位 `responseChars` 與平均值，驗證優化成效。

---

### 風險與回滾
- 相容性：既有客戶端若仰賴全量 `observations`，可透過 `output.includeObservations=true` 或 `open_nodes` 遷移。
- 性能：片段/計數查詢需注意 N+1；優先使用彙總查詢與聚合視圖。
- 回滾：保留舊 LIMIT 與序列化行為旗標（ENV）以便快速回退。

---

### 推出順序與時程（建議）
- Phase 1：0.5 天（改序列化＋LIMIT＋relations 上限＋基礎觀測）
- Phase 2：1.5 天（compact/default、預設 ENV、型別可選欄位）
- Phase 3：2 天（分頁/游標、`open_nodes` 分頁）
- Phase 4：1 天（snippet 與守門員、觀測）
- Phase 5：0.5 天（預設時間範圍）

---

### 參考檔案（對齊現狀）
- `src/managers/duckdb-manager.ts`：LIKE/FTS/BM25、`searchNodes`、`openNodes` 實作與當前 LIMIT。
- `src/servers/secondary-server.ts`：MCP 工具輸出（目前使用 `JSON.stringify(..., null, 2)`）。
- `src/types.ts`：`SearchNodesOptions`/`MultiKeywordSearchOptions`/`KnowledgeGraph` 型別。
- `src/servers/ipc/protocol.ts`：IPC 請求/回應與驗證。
- 測試：`tests/hybrid-search.test.ts`、`tests/ipc-time-range.test.ts` 等。

---

### 成功定義
- 預設 compact 下，常見查詢回應字元量下降 ≥ 80%，同時保持可達完整性（透過 `open_nodes`）。
- 在任意資料量下，`RESPONSE_MAX_CHARS` 守門員保證不溢出 Claude context。
- 全測試綠燈，且新增測試覆蓋分頁/截斷/compact。
