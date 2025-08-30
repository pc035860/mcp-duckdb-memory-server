/**
 * VSS R2 Migration Test Scenario Generator
 * 
 * 為 VSS R2 遷移驗證建立各種測試資料庫情境
 * 支援空資料庫、小型、大型、特殊字元、邊界條件等不同情境
 */

// better-sqlite3 僅於執行工具時需要，為避免編譯期型別缺失，使用 require any
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BetterSqlite3: any = require('better-sqlite3');
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 測試情境定義
export interface TestScenario {
  name: string;
  description: string;
  entityCount: number;
  observationCount: number;
  relationCount: number;
  specialFeatures: string[];
}

export const TEST_SCENARIOS: TestScenario[] = [
  {
    name: 'empty',
    description: '空資料庫情境 - 測試全新安裝的遷移執行',
    entityCount: 0,
    observationCount: 0,
    relationCount: 0,
    specialFeatures: ['fresh_install', 'no_existing_data']
  },
  {
    name: 'small',
    description: '小型資料庫情境 - 測試有少量資料的遷移安全性',
    entityCount: 15,
    observationCount: 75,
    relationCount: 8,
    specialFeatures: ['minimal_data', 'basic_relations']
  },
  {
    name: 'large',
    description: '大型資料庫情境 - 測試生產規模資料的遷移效能',
    entityCount: 1200,
    observationCount: 6000,
    relationCount: 2500,
    specialFeatures: ['production_scale', 'performance_test', 'memory_intensive']
  },
  {
    name: 'special-chars',
    description: '特殊字元資料情境 - 測試多語言和特殊字元的相容性',
    entityCount: 50,
    observationCount: 200,
    relationCount: 20,
    specialFeatures: ['unicode', 'multilingual', 'emoji', 'sql_injection_safe']
  },
  {
    name: 'edge-cases',
    description: '邊界條件情境 - 測試系統邊界和錯誤處理',
    entityCount: 25,
    observationCount: 100,
    relationCount: 15,
    specialFeatures: ['empty_strings', 'null_values', 'extreme_lengths', 'special_timestamps']
  }
];

// 多語言測試資料
const MULTILINGUAL_DATA = {
  entities: [
    'user_authentication', 'session_管理', 'データベース接続', '사용자인증',
    'محتوى_المقال', 'контроль_доступа', '🔐_security_module', '💾_database'
  ],
  observations: [
    'User login functionality with JWT tokens 用戶登入功能包含JWT令牌',
    'セッション管理システムは30分でタイムアウトします Session management system times out in 30 minutes',
    '데이터베이스 연결은 풀링을 사용합니다 Database connection uses pooling',
    'نظام المصادقة يدعم OAuth 2.0 Authentication system supports OAuth 2.0',
    'Система контроля доступа работает круглосуточно Access control system works 24/7',
    '🚀 Performance optimization completed with 95% improvement',
    '✨ Feature enhancement: Added real-time notifications 實時通知功能已添加'
  ],
  relations: ['manages', 'depends_on', 'implements', 'uses', 'contains']
};

// 邊界條件測試資料
const EDGE_CASE_DATA = {
  emptyStrings: ['', ' ', '   '],
  extremeLengths: {
    short: 'a',
    medium: 'A'.repeat(255),
    long: 'Very long observation content that exceeds normal limits. '.repeat(50),
    extreme: 'X'.repeat(10000)
  },
  specialTimestamps: [
    '1970-01-01T00:00:00.000Z', // Unix epoch
    '2038-01-19T03:14:07.000Z', // Y2038 problem
    '9999-12-31T23:59:59.999Z', // Far future
    '2000-02-29T12:00:00.000Z'  // Leap year
  ]
};

export class TestScenarioGenerator {
  private testDir: string;
  
  constructor(testDir: string = './test-scenarios') {
    this.testDir = testDir;
    
    // 確保測試目錄存在
    if (!fs.existsSync(this.testDir)) {
      fs.mkdirSync(this.testDir, { recursive: true });
    }
  }

  /**
   * 生成所有測試情境
   */
  async generateAllScenarios(): Promise<void> {
    console.log('🔧 開始生成 VSS R2 遷移測試資料庫情境...\n');
    
    for (const scenario of TEST_SCENARIOS) {
      await this.generateScenario(scenario);
    }
    
    console.log('✅ 所有測試情境生成完成！');
    this.generateValidationScript();
  }

  /**
   * 生成單個測試情境
   */
  async generateScenario(scenario: TestScenario): Promise<void> {
    const dbPath = path.join(this.testDir, `test-migration-${scenario.name}.db`);
    
    console.log(`📝 生成情境: ${scenario.name}`);
    console.log(`   描述: ${scenario.description}`);
    console.log(`   目標: ${scenario.entityCount} 實體, ${scenario.observationCount} 觀察, ${scenario.relationCount} 關係`);
    
    // 移除舊檔案
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    
    const db = new BetterSqlite3(dbPath);
    
    try {
      // 建立基本 schema（遷移前狀態）
      this.createBaseSchema(db);
      
      if (scenario.name === 'empty') {
        // 空資料庫情境 - 只建立基本 schema，不插入資料
        console.log('   ✅ 空資料庫情境建立完成');
      } else {
        // 生成測試資料
        await this.generateTestData(db, scenario);
        console.log('   ✅ 測試資料生成完成');
      }
      
      // 建立情境驗證資料
      this.generateScenarioValidation(scenario, dbPath);
      
    } finally {
      db.close();
    }
    
    console.log(`   💾 資料庫檔案: ${dbPath}\n`);
  }

  /**
   * 建立基本資料庫 schema（遷移前狀態）
   */
  private createBaseSchema(db: any): void {
    // 建立 schema_migrations 表（如果不存在）
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 建立基本的 entities 表（遷移前狀態，沒有 embedding_vector 欄位）
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        name TEXT PRIMARY KEY,
        entityType TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 建立 observations 表
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entityName TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entityName) REFERENCES entities(name) ON DELETE CASCADE
      )
    `);

    // 建立 relations 表
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromEntity TEXT NOT NULL,
        toEntity TEXT NOT NULL,
        relationType TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(fromEntity, toEntity, relationType),
        FOREIGN KEY (fromEntity) REFERENCES entities(name) ON DELETE CASCADE,
        FOREIGN KEY (toEntity) REFERENCES entities(name) ON DELETE CASCADE
      )
    `);

    // 建立索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entityName);
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(fromEntity);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(toEntity);
    `);
  }

  /**
   * 生成測試資料
   */
  private async generateTestData(db: any, scenario: TestScenario): Promise<void> {
    const isSpecialChars = scenario.specialFeatures.includes('unicode');
    const isEdgeCases = scenario.specialFeatures.includes('empty_strings');
    
    // 準備語句
    const insertEntity = db.prepare(`
      INSERT INTO entities (name, entityType, createdAt) 
      VALUES (?, ?, ?)
    `);
    
    const insertObservation = db.prepare(`
      INSERT INTO observations (entityName, content, createdAt) 
      VALUES (?, ?, ?)
    `);
    
    const insertRelation = db.prepare(`
      INSERT INTO relations (fromEntity, toEntity, relationType, createdAt) 
      VALUES (?, ?, ?, ?)
    `);

    // 開始事務
    const insertAll = db.transaction(() => {
      const entities: string[] = [];
      
      // 生成實體
      for (let i = 0; i < scenario.entityCount; i++) {
        const entityName = this.generateEntityName(i, isSpecialChars, isEdgeCases);
        const entityType = this.generateEntityType(i, isSpecialChars);
        const createdAt = this.generateTimestamp(i, isEdgeCases);
        
        entities.push(entityName);
        insertEntity.run(entityName, entityType, createdAt);
      }

      // 生成觀察
      for (let i = 0; i < scenario.observationCount; i++) {
        const entityName = entities[i % entities.length];
        const content = this.generateObservationContent(i, isSpecialChars, isEdgeCases);
        const createdAt = this.generateTimestamp(i + 1000, isEdgeCases);
        
        insertObservation.run(entityName, content, createdAt);
      }

      // 生成關係
      for (let i = 0; i < scenario.relationCount; i++) {
        const fromEntity = entities[i % entities.length];
        const toEntity = entities[(i + 1) % entities.length];
        const relationType = this.generateRelationType(i, isSpecialChars);
        const createdAt = this.generateTimestamp(i + 2000, isEdgeCases);
        
        // 避免重複關係
        try {
          insertRelation.run(fromEntity, toEntity, relationType, createdAt);
        } catch (e) {
          // 忽略重複關係錯誤
        }
      }
    });

    insertAll();
  }

  /**
   * 生成實體名稱
   */
  private generateEntityName(index: number, isSpecialChars: boolean, isEdgeCases: boolean): string {
    if (isEdgeCases && index < EDGE_CASE_DATA.emptyStrings.length) {
      return `entity_${index}_${EDGE_CASE_DATA.emptyStrings[index] || 'empty'}`;
    }
    
    if (isSpecialChars) {
      const names = MULTILINGUAL_DATA.entities;
      return names[index % names.length] + `_${index}`;
    }
    
    const prefixes = ['user', 'system', 'service', 'component', 'module', 'manager', 'handler', 'processor'];
    const prefix = prefixes[index % prefixes.length];
    return `${prefix}_${String(index).padStart(4, '0')}`;
  }

  /**
   * 生成實體類型
   */
  private generateEntityType(index: number, isSpecialChars: boolean): string {
    const types = isSpecialChars 
      ? ['component', 'service', 'モジュール', '컴포넌트', 'خدمة', 'модуль']
      : ['component', 'service', 'module', 'handler', 'manager', 'processor', 'controller', 'repository'];
    
    return types[index % types.length];
  }

  /**
   * 生成觀察內容
   */
  private generateObservationContent(index: number, isSpecialChars: boolean, isEdgeCases: boolean): string {
    if (isEdgeCases) {
      if (index < EDGE_CASE_DATA.emptyStrings.length) {
        return EDGE_CASE_DATA.emptyStrings[index];
      }
      
      const lengths = Object.values(EDGE_CASE_DATA.extremeLengths);
      if (index < lengths.length + EDGE_CASE_DATA.emptyStrings.length) {
        return lengths[index - EDGE_CASE_DATA.emptyStrings.length];
      }
    }
    
    if (isSpecialChars) {
      const observations = MULTILINGUAL_DATA.observations;
      return observations[index % observations.length];
    }
    
    const templates = [
      `Implements authentication logic for user session management - iteration ${index}`,
      `Handles database connection pooling with retry mechanism - version ${index}`,
      `Provides caching functionality with TTL expiration - build ${index}`,
      `Manages configuration settings with environment variables - release ${index}`,
      `Processes API requests with rate limiting and validation - update ${index}`,
      `Controls access permissions with role-based authorization - patch ${index}`,
      `Monitors system health with metrics and alerting - revision ${index}`,
      `Orchestrates service communication with message queuing - deployment ${index}`
    ];
    
    return templates[index % templates.length];
  }

  /**
   * 生成關係類型
   */
  private generateRelationType(index: number, isSpecialChars: boolean): string {
    const types = isSpecialChars
      ? MULTILINGUAL_DATA.relations
      : ['depends_on', 'implements', 'uses', 'manages', 'contains', 'extends', 'provides', 'consumes'];
    
    return types[index % types.length];
  }

  /**
   * 生成時間戳
   */
  private generateTimestamp(index: number, isEdgeCases: boolean): string {
    if (isEdgeCases && index < EDGE_CASE_DATA.specialTimestamps.length) {
      return EDGE_CASE_DATA.specialTimestamps[index];
    }
    
    // 生成近期的時間戳，分散在過去30天內
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    const randomTime = thirtyDaysAgo + (Math.random() * (now - thirtyDaysAgo));
    
    return new Date(randomTime).toISOString();
  }

  /**
   * 生成情境驗證檔案
   */
  private generateScenarioValidation(scenario: TestScenario, dbPath: string): void {
    const validationPath = path.join(this.testDir, `${scenario.name}-validation.json`);
    
    const validation = {
      scenario: scenario.name,
      description: scenario.description,
      databasePath: path.basename(dbPath),
      expectedCounts: {
        entities: scenario.entityCount,
        observations: scenario.observationCount,
        relations: scenario.relationCount
      },
      specialFeatures: scenario.specialFeatures,
      validationQueries: this.generateValidationQueries(scenario),
      migrationChecks: [
        'verify_schema_migrations_table_exists',
        'verify_entities_table_has_embedding_vector_column',
        'verify_vss_index_created',
        'verify_data_integrity_maintained',
        'verify_no_data_loss'
      ],
      createdAt: new Date().toISOString()
    };
    
    fs.writeFileSync(validationPath, JSON.stringify(validation, null, 2));
  }

  /**
   * 生成驗證查詢
   */
  private generateValidationQueries(scenario: TestScenario): Record<string, string> {
    const queries: Record<string, string> = {
      count_entities: 'SELECT COUNT(*) as count FROM entities',
      count_observations: 'SELECT COUNT(*) as count FROM observations',
      count_relations: 'SELECT COUNT(*) as count FROM relations',
      check_schema_migrations: 'SELECT version FROM schema_migrations ORDER BY version',
      sample_entities: 'SELECT name, entityType FROM entities LIMIT 5',
      sample_observations: 'SELECT entityName, substr(content, 1, 50) as preview FROM observations LIMIT 5'
    };

    if (scenario.specialFeatures.includes('unicode')) {
      queries.unicode_test = `SELECT name FROM entities WHERE name LIKE '%😀%' OR name LIKE '%中%' OR name LIKE '%ü%'`;
    }

    if (scenario.specialFeatures.includes('empty_strings')) {
      queries.empty_content_test = `SELECT COUNT(*) as count FROM observations WHERE content = '' OR content IS NULL`;
    }

    return queries;
  }

  /**
   * 生成主驗證腳本
   */
  private generateValidationScript(): void {
    const scriptPath = path.join(this.testDir, 'run-migration-tests.ts');
    
    const script = `/**
 * VSS R2 遷移測試執行腳本
 * 
 * 執行所有測試情境的遷移驗證
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ValidationResult {
  scenario: string;
  success: boolean;
  errors: string[];
  timings: {
    migrationTime: number;
    validationTime: number;
  };
  counts: {
    before: Record<string, number>;
    after: Record<string, number>;
  };
}

async function runMigrationTest(scenarioName: string): Promise<ValidationResult> {
  console.log(\`\\n🧪 測試情境: \${scenarioName}\`);
  
  const dbPath = path.join(__dirname, \`test-migration-\${scenarioName}.db\`);
  const validationPath = path.join(__dirname, \`\${scenarioName}-validation.json\`);
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(\`測試資料庫不存在: \${dbPath}\`);
  }
  
  const validation = JSON.parse(fs.readFileSync(validationPath, 'utf-8'));
  const result: ValidationResult = {
    scenario: scenarioName,
    success: false,
    errors: [],
    timings: { migrationTime: 0, validationTime: 0 },
    counts: { before: {}, after: {} }
  };

  try {
    // 1. 記錄遷移前狀態
    console.log('   📊 記錄遷移前狀態...');
    const beforeDb = new Database(dbPath, { readonly: true });
    
    try {
      result.counts.before = {
        entities: beforeDb.prepare('SELECT COUNT(*) as count FROM entities').get().count,
        observations: beforeDb.prepare('SELECT COUNT(*) as count FROM observations').get().count,
        relations: beforeDb.prepare('SELECT COUNT(*) as count FROM relations').get().count
      };
    } finally {
      beforeDb.close();
    }

    // 2. 執行遷移
    console.log('   ⚡ 執行資料庫遷移...');
    const migrationStart = Date.now();
    
    const { stdout, stderr } = await execAsync(\`npm run migrate-database \${dbPath}\`);
    
    result.timings.migrationTime = Date.now() - migrationStart;
    
    if (stderr && !stderr.includes('info:')) {
      result.errors.push(\`Migration stderr: \${stderr}\`);
    }

    // 3. 驗證遷移結果
    console.log('   ✅ 驗證遷移結果...');
    const validationStart = Date.now();
    
    const afterDb = new Database(dbPath);
    
    try {
      // 檢查 schema 遷移
      const migrations = afterDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      if (!migrations.some(m => m.version === 1)) {
        result.errors.push('VSS R2 遷移（版本 1）未執行');
      }

      // 檢查新欄位
      const tableInfo = afterDb.prepare("PRAGMA table_info(entities)").all();
      const hasEmbeddingVector = tableInfo.some(col => col.name === 'embedding_vector');
      if (!hasEmbeddingVector) {
        result.errors.push('entities 表缺少 embedding_vector 欄位');
      }

      // 記錄遷移後狀態
      result.counts.after = {
        entities: afterDb.prepare('SELECT COUNT(*) as count FROM entities').get().count,
        observations: afterDb.prepare('SELECT COUNT(*) as count FROM observations').get().count,
        relations: afterDb.prepare('SELECT COUNT(*) as count FROM relations').get().count
      };

      // 驗證資料完整性
      if (result.counts.before.entities !== result.counts.after.entities) {
        result.errors.push(\`實體數量不符: \${result.counts.before.entities} -> \${result.counts.after.entities}\`);
      }
      if (result.counts.before.observations !== result.counts.after.observations) {
        result.errors.push(\`觀察數量不符: \${result.counts.before.observations} -> \${result.counts.after.observations}\`);
      }
      if (result.counts.before.relations !== result.counts.after.relations) {
        result.errors.push(\`關係數量不符: \${result.counts.before.relations} -> \${result.counts.after.relations}\`);
      }

      // 執行自定義驗證查詢
      for (const [name, query] of Object.entries(validation.validationQueries)) {
        try {
          afterDb.prepare(query).all();
        } catch (e) {
          result.errors.push(\`驗證查詢失敗 (\${name}): \${e.message}\`);
        }
      }

    } finally {
      afterDb.close();
    }
    
    result.timings.validationTime = Date.now() - validationStart;
    result.success = result.errors.length === 0;
    
    if (result.success) {
      console.log(\`   ✅ 測試通過 (遷移: \${result.timings.migrationTime}ms, 驗證: \${result.timings.validationTime}ms)\`);
    } else {
      console.log(\`   ❌ 測試失敗 (\${result.errors.length} 個錯誤)\`);
      result.errors.forEach(error => console.log(\`      - \${error}\`));
    }

  } catch (error) {
    result.errors.push(\`執行異常: \${error.message}\`);
    console.log(\`   💥 執行異常: \${error.message}\`);
  }

  return result;
}

async function main() {
  console.log('🚀 開始執行 VSS R2 遷移測試套件\\n');
  
  const scenarios = ${JSON.stringify(TEST_SCENARIOS.map(s => s.name), null, 2)};
  const results: ValidationResult[] = [];
  
  for (const scenario of scenarios) {
    const result = await runMigrationTest(scenario);
    results.push(result);
  }
  
  // 生成測試報告
  console.log('\\n📋 測試結果報告\\n');
  console.log('情境名稱\\t\\t狀態\\t\\t遷移時間\\t驗證時間\\t錯誤數');
  console.log(''.padEnd(80, '-'));
  
  let totalSuccess = 0;
  
  results.forEach(result => {
    const status = result.success ? '✅ 通過' : '❌ 失敗';
    const migrationTime = \`\${result.timings.migrationTime}ms\`;
    const validationTime = \`\${result.timings.validationTime}ms\`;
    const errorCount = result.errors.length;
    
    console.log(\`\${result.scenario.padEnd(16)}\\t\${status}\\t\\t\${migrationTime.padEnd(8)}\\t\${validationTime.padEnd(8)}\\t\${errorCount}\`);
    
    if (result.success) totalSuccess++;
  });
  
  console.log(''.padEnd(80, '-'));
  console.log(\`總計: \${totalSuccess}/\${results.length} 個測試通過\\n\`);
  
  // 保存詳細報告
  const reportPath = path.join(__dirname, 'migration-test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: totalSuccess,
      failed: results.length - totalSuccess
    },
    results
  }, null, 2));
  
  console.log(\`📄 詳細報告已保存: \${reportPath}\`);
  
  process.exit(totalSuccess === results.length ? 0 : 1);
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  main().catch(console.error);
}
`;

    fs.writeFileSync(scriptPath, script);
    
    // 生成 package.json 腳本
    const packageJsonPath = path.join(this.testDir, 'package.json');
    const packageConfig = {
      name: 'vss-r2-migration-test-scenarios',
      version: '1.0.0',
      description: 'VSS R2 遷移驗證測試情境',
      scripts: {
        'generate': 'node ../dist/tools/test-scenario-generator.js',
        'test': 'tsx run-migration-tests.ts',
        'clean': 'rm -f *.db *.db-wal *.db-shm'
      },
      dependencies: {
        'better-sqlite3': '^8.7.0',
        'tsx': '^3.12.7'
      }
    };
    
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageConfig, null, 2));
    
    console.log(`📜 執行腳本已生成: ${scriptPath}`);
    console.log(`📦 Package.json 已生成: ${packageJsonPath}`);
  }
}

// 主程序
async function main() {
  if (process.argv.includes('--help')) {
    console.log(`
VSS R2 遷移測試情境生成器

使用方式:
  npm run build && node dist/tools/test-scenario-generator.js [options]

選項:
  --help          顯示此幫助
  --scenario=NAME 只生成特定情境 (${TEST_SCENARIOS.map(s => s.name).join(', ')})
  --output=DIR    指定輸出目錄 (預設: ./test-scenarios)

範例:
  node dist/tools/test-scenario-generator.js --scenario=small
  node dist/tools/test-scenario-generator.js --output=./my-tests
    `);
    return;
  }
  
  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  const outputDir = outputArg ? outputArg.split('=')[1] : './test-scenarios';
  
  const scenarioArg = process.argv.find(arg => arg.startsWith('--scenario='));
  const targetScenario = scenarioArg ? scenarioArg.split('=')[1] : null;
  
  const generator = new TestScenarioGenerator(outputDir);
  
  if (targetScenario) {
    const scenario = TEST_SCENARIOS.find(s => s.name === targetScenario);
    if (!scenario) {
      console.error(`❌ 找不到情境: ${targetScenario}`);
      console.error(`可用情境: ${TEST_SCENARIOS.map(s => s.name).join(', ')}`);
      process.exit(1);
    }
    
    await generator.generateScenario(scenario);
  } else {
    await generator.generateAllScenarios();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}