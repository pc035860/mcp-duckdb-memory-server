#!/usr/bin/env node

import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import pkg from '@duckdb/node-api';
const { Database } = pkg;

console.log('🧪 Testing DuckDB FLOAT[] parameter binding directly...');

const testDir = mkdtempSync(path.join(tmpdir(), 'float-test-'));
const testDbPath = path.join(testDir, 'test.db');

try {
  console.log(`📁 Test database: ${testDbPath}`);
  
  // 初始化 DuckDB
  const db = new Database(testDbPath);
  const connection = db;
  
  // 創建測試表
  const createResult = connection.runAndReadAll(`
    CREATE TABLE test_embeddings (
      name VARCHAR,
      embedding FLOAT[1536],
      embedding_model VARCHAR,
      embedding_updated_at TIMESTAMP
    )
  `);
  
  console.log('✅ Created test table');
  
  // 測試不同格式的向量
  const testVectors = [
    {
      name: 'JavaScript Array',
      vector: new Array(1536).fill(0.123456)
    },
    {
      name: 'Float32Array',  
      vector: new Float32Array(1536).fill(0.123456)
    },
    {
      name: 'Array.from conversion',
      vector: Array.from({ length: 1536 }, () => 0.123456)
    },
    {
      name: 'Explicit array notation',
      vector: [...new Array(1536).fill(0.123456)]
    }
  ];
  
  for (let i = 0; i < testVectors.length; i++) {
    const test = testVectors[i];
    console.log(`\n🧪 Testing ${test.name}...`);
    console.log(`Vector type: ${test.vector.constructor.name}`);
    console.log(`Vector length: ${test.vector.length}`);
    console.log(`Sample values: [${test.vector.slice(0, 5).join(', ')}...]`);
    
    try {
      // 測試不同的 SQL 參數綁定方式
      const sql = `
        INSERT INTO test_embeddings(name, embedding, embedding_model, embedding_updated_at)
        VALUES ($1, $2::FLOAT[], $3, CURRENT_TIMESTAMP)
      `;
      
      const result = connection.runAndReadAll(sql, [`test_entity_${i}`, test.vector, 'test-model']);
      console.log(`✅ ${test.name}: Success!`);
      
      // 驗證插入的數據
      const verifyResult = connection.runAndReadAll(`
        SELECT name, array_length(embedding) as length, embedding[1] as first_value 
        FROM test_embeddings WHERE name = $1
      `, [`test_entity_${i}`]);
      
      const rows = verifyResult.getRows();
      if (rows && rows.length > 0) {
        const row = rows[0];
        console.log(`   Verification - Length: ${row[1]}, First value: ${row[2]}`);
      }
      
    } catch (error) {
      console.log(`❌ ${test.name}: ${error.message}`);
      
      // 嘗試不同的類型轉換
      try {
        console.log(`   Retrying with Array.from conversion...`);
        const convertedVector = Array.from(test.vector);
        const retryResult = connection.runAndReadAll(sql, [`test_entity_${i}_retry`, convertedVector, 'test-model']);
        console.log(`   ✅ Array.from conversion worked!`);
      } catch (retryError) {
        console.log(`   ❌ Retry failed: ${retryError.message}`);
      }
    }
  }
  
  connection.close();
  
} catch (error) {
  console.error('❌ Error:', error);
} finally {
  rmSync(testDir, { recursive: true, force: true });
  console.log('🧹 Cleanup complete');
}