# MCP DuckDB Memory Server 專案概述

## 專案目的
這是一個 MCP (Model Context Protocol) DuckDB Memory Server 專案，提供基於 DuckDB 的持久化知識圖譜記憶體服務。支援多 MCP 客戶端共享同一個知識圖譜。

## 技術堆疊
- **資料庫**: DuckDB (嵌入式列儲存資料庫)
- **程式語言**: TypeScript/Node.js
- **架構**: 主/次服務器架構 (Main/Secondary Server)
- **打包工具**: tsup
- **測試框架**: Vitest
- **包管理器**: pnpm

## 核心架構
- **Main Server**: 擁有 DuckDB 實例，透過 Unix Domain Socket 提供 IPC 服務
- **Secondary Server**: 提供 MCP 介面，將請求轉發給 Main Server
- **知識圖譜**: 包含 entities, observations, relations 三張表

## 主要模組
- `src/managers/`: DuckDBManager 和 ProxyManager
- `src/servers/`: MainServer 和 SecondaryServer
- `src/tools/`: merge-duckdb.ts (資料庫合併工具)
- `src/types.ts`: 核心型別定義