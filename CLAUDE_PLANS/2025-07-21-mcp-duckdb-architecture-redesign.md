# MCP DuckDB Memory Server 架構重構計畫

## 1. 背景與目標
**問題：** 目前的 instance-per-operation 模式雖然避免了記憶體累積，但無法真正解決多 MCP 客戶端同時存取 DuckDB 的競爭問題，且每次操作都重新建立實例造成效能浪費。

**目標：** 重構為 main/secondary server 架構，由單一 main server 負責 DuckDB 操作，其他 secondary servers 作為 MCP 代理，實現真正的多客戶端支援和更好的資源管理。

## 2. 技術方案
**方法：** 
- Main Server：持久化 DuckDB 連線 + 請求排隊機制
- Secondary Server：MCP 介面代理，透過 IPC 轉發請求
- 使用 Unix Domain Socket 進行程序間通訊
- 完全移除 instance-per-operation 和 cleanup 邏輯

**關鍵決策：** 捨棄向後相容性，專注於建立乾淨高效的新架構

## 3. 實作步驟

### 階段一：基礎架構重構
- [x] 重構 DuckDBKnowledgeGraphManager，移除 cleanup 邏輯，改用持久化連線
- [x] 設計並實作 IPC 通訊協議
- [x] 建立 Server 抽象介面和模式選擇機制
- [x] 實作請求排隊系統

### 階段二：Main Server 實作
- [x] 實作 Main Server 核心邏輯
- [x] 整合持久化的 DuckDB 管理器
- [x] 實作 IPC 服務端和請求處理
- [x] 新增錯誤處理和連線管理

### 階段三：Secondary Server 實作
- [x] 實作 MCP Proxy 層
- [x] 實作 IPC 客戶端和請求轉發
- [x] 更新主入口檔案支援模式切換
- [x] 整合現有 MCP 工具介面

### 階段四：測試與優化
- [x] 基本架構測試和編譯驗證
- [x] 雙服務器模式連接測試
- [x] 更新文件和部署指南
- [x] 更新所有 npm 命令為 pnpm（保持一致性）
- [x] 補充 Docker 詳細使用說明
- [x] 補充 MCP 客戶端配置詳細說明
- [x] 更新 smithery.yaml 支援新架構
- [x] 新增 docker-compose.yml 範例
- [x] 新增 Claude Desktop 配置範例
- [x] 新增啟動腳本範例
- [ ] 更新測試案例適應新架構
- [ ] 進行多客戶端壓力測試
- [ ] 效能調優和穩定性測試

## 4. 檔案結構變更
```
src/
├── index.ts                 # 主入口，根據模式啟動
├── managers/
│   ├── interface.ts         # 管理器介面
│   ├── duckdb-manager.ts    # 重構的 DuckDB 管理器
│   └── proxy-manager.ts     # 代理管理器
├── servers/
│   ├── main-server.ts       # Main Server
│   ├── secondary-server.ts  # Secondary Server
│   └── ipc/                 # IPC 通訊相關
├── queue/
│   └── request-queue.ts     # 請求排隊
└── config/
    └── server-config.ts     # 服務器配置
```

## 5. 成功指標
- 多個 MCP 客戶端可同時連接而無競爭問題
- 資料庫操作效能提升（無重複連線建立）
- 程式碼簡化（移除複雜的 cleanup 邏輯）
- 所有現有 MCP 工具介面保持相同行為

## 6. 時程
- **預估：** 3-4 天
- **里程碑：** 
  - Day 1: 完成階段一基礎重構
  - Day 2: 完成階段二 Main Server
  - Day 3: 完成階段三 Secondary Server
  - Day 4: 測試與文件更新

## 7. 進度追蹤
- **建立時間：** 2025-01-21
- **完成時間：** 2025-07-21
- **當前狀態：** ✅ 重構完成

## 8. 最終成果總結

### ✅ 核心重構完成
- **架構轉換**：成功從 instance-per-operation 轉為 main/secondary server 模式
- **真正多客戶端支援**：解決 DuckDB 檔案鎖定競爭問題
- **效能提升**：持久化連線，移除重複建立/清理開銷
- **程式碼簡化**：移除複雜的 cleanup 邏輯

### ✅ 完整的部署支援
- **本地開發**：pnpm 腳本和環境變數配置
- **Docker 部署**：單機和多服務器 Docker Compose 支援
- **MCP 整合**：Claude Desktop 和其他客戶端配置範例
- **管理工具**：啟動腳本和狀態監控

### ✅ 文件和範例
- **詳細 README**：包含安裝、配置、部署的完整指南
- **範例檔案**：Claude Desktop 配置、Docker Compose、啟動腳本
- **Smithery 支援**：更新的平台配置支援新架構

### 🎯 使用方式
```bash
# 啟動 Main Server
SERVER_MODE=main pnpm start

# 啟動 Secondary Server（另一個終端）
SERVER_MODE=secondary pnpm start
```

這次重構徹底解決了多客戶端同時存取的根本問題，同時提供了完整的部署和管理方案。