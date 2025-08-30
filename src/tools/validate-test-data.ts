/**
 * VSS R2 測試資料驗證工具
 * 
 * 快速驗證生成的測試資料庫是否符合預期
 */

// better-sqlite3 型別在執行工具時才需要，建置期無需提供型別檔
// 以 any 接受以避免在未安裝對應型別時的編譯錯誤
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BetterSqlite3: any = require('better-sqlite3');
import path from 'path';
import fs from 'fs';

interface ValidationReport {
  scenario: string;
  status: 'pass' | 'fail';
  issues: string[];
  statistics: {
    entities: number;
    observations: number;
    relations: number;
    uniqueEntityTypes: number;
    avgObservationsPerEntity: number;
  };
  sampleData: {
    entities: Array<{ name: string; entityType: string; createdAt: string }>;
    observations: Array<{ entityName: string; content: string; createdAt: string }>;
    relations: Array<{ fromEntity: string; toEntity: string; relationType: string }>;
  };
}

export class TestDataValidator {
  private testDir: string;

  constructor(testDir: string = './test-scenarios') {
    this.testDir = testDir;
  }

  /**
   * 驗證所有測試資料庫
   */
  async validateAllScenarios(): Promise<ValidationReport[]> {
    const reports: ValidationReport[] = [];
    
    if (!fs.existsSync(this.testDir)) {
      console.error(`❌ 測試目錄不存在: ${this.testDir}`);
      return reports;
    }

    const dbFiles = fs.readdirSync(this.testDir)
      .filter(file => file.startsWith('test-migration-') && file.endsWith('.db'));

    console.log(`🔍 找到 ${dbFiles.length} 個測試資料庫檔案\n`);

    for (const dbFile of dbFiles) {
      const scenarioName = dbFile.replace('test-migration-', '').replace('.db', '');
      const report = await this.validateScenario(scenarioName);
      reports.push(report);
    }

    this.generateValidationSummary(reports);
    return reports;
  }

  /**
   * 驗證單個測試情境
   */
  async validateScenario(scenarioName: string): Promise<ValidationReport> {
    const dbPath = path.join(this.testDir, `test-migration-${scenarioName}.db`);
    const validationPath = path.join(this.testDir, `${scenarioName}-validation.json`);

    const report: ValidationReport = {
      scenario: scenarioName,
      status: 'pass',
      issues: [],
      statistics: {
        entities: 0,
        observations: 0,
        relations: 0,
        uniqueEntityTypes: 0,
        avgObservationsPerEntity: 0
      },
      sampleData: {
        entities: [],
        observations: [],
        relations: []
      }
    };

    console.log(`📊 驗證情境: ${scenarioName}`);

    try {
      // 檢查檔案是否存在
      if (!fs.existsSync(dbPath)) {
        report.issues.push(`資料庫檔案不存在: ${dbPath}`);
        report.status = 'fail';
        return report;
      }

      if (!fs.existsSync(validationPath)) {
        report.issues.push(`驗證配置檔案不存在: ${validationPath}`);
        report.status = 'fail';
        return report;
      }

      // 載入期望配置
      const expectedConfig = JSON.parse(fs.readFileSync(validationPath, 'utf-8'));

      // 連接資料庫並驗證
      const db = new BetterSqlite3(dbPath, { readonly: true });

      try {
        // 1. 驗證基本表結構
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const tableNames = tables.map((t: any) => t.name);

        const requiredTables = ['entities', 'observations', 'relations', 'schema_migrations'];
        for (const table of requiredTables) {
          if (!tableNames.includes(table)) {
            report.issues.push(`缺少必要的表: ${table}`);
          }
        }

        // 2. 收集統計資料
        report.statistics.entities = db.prepare('SELECT COUNT(*) as count FROM entities').get()?.count || 0;
        report.statistics.observations = db.prepare('SELECT COUNT(*) as count FROM observations').get()?.count || 0;
        report.statistics.relations = db.prepare('SELECT COUNT(*) as count FROM relations').get()?.count || 0;

        const uniqueTypes = db.prepare('SELECT COUNT(DISTINCT entityType) as count FROM entities').get()?.count || 0;
        report.statistics.uniqueEntityTypes = uniqueTypes;

        if (report.statistics.entities > 0) {
          report.statistics.avgObservationsPerEntity = Math.round(
            (report.statistics.observations / report.statistics.entities) * 100
          ) / 100;
        }

        // 3. 驗證資料數量是否符合預期
        const tolerance = 0.1; // 10% 容差

        if (Math.abs(report.statistics.entities - expectedConfig.expectedCounts.entities) > 
            expectedConfig.expectedCounts.entities * tolerance) {
          report.issues.push(
            `實體數量與預期不符: 實際 ${report.statistics.entities}, 預期 ${expectedConfig.expectedCounts.entities}`
          );
        }

        if (Math.abs(report.statistics.observations - expectedConfig.expectedCounts.observations) > 
            expectedConfig.expectedCounts.observations * tolerance) {
          report.issues.push(
            `觀察數量與預期不符: 實際 ${report.statistics.observations}, 預期 ${expectedConfig.expectedCounts.observations}`
          );
        }

        if (Math.abs(report.statistics.relations - expectedConfig.expectedCounts.relations) > 
            expectedConfig.expectedCounts.relations * tolerance) {
          report.issues.push(
            `關係數量與預期不符: 實際 ${report.statistics.relations}, 預期 ${expectedConfig.expectedCounts.relations}`
          );
        }

        // 4. 收集樣本資料
        report.sampleData.entities = db.prepare(
          'SELECT name, entityType, createdAt FROM entities LIMIT 3'
        ).all();

        report.sampleData.observations = db.prepare(
          'SELECT entityName, substr(content, 1, 100) as content, createdAt FROM observations LIMIT 3'
        ).all();

        report.sampleData.relations = db.prepare(
          'SELECT fromEntity, toEntity, relationType FROM relations LIMIT 3'
        ).all();

        // 5. 特殊功能驗證
        if (expectedConfig.specialFeatures.includes('unicode')) {
          const unicodeCount = db.prepare(`
            SELECT COUNT(*) as count FROM entities 
            WHERE name LIKE '%中%' OR name LIKE '%日%' OR name LIKE '%한%' 
               OR name LIKE '%ü%' OR name LIKE '%😀%' OR name LIKE '%العربية%'
          `).get()?.count || 0;

          if (unicodeCount === 0) {
            report.issues.push('Unicode 特殊功能：未找到多語言字元');
          }
        }

        if (expectedConfig.specialFeatures.includes('empty_strings')) {
          const emptyCount = db.prepare(`
            SELECT COUNT(*) as count FROM observations 
            WHERE content = '' OR content IS NULL OR trim(content) = ''
          `).get()?.count || 0;

          if (emptyCount === 0) {
            report.issues.push('邊界條件測試：未找到空字串或NULL值');
          }
        }

        // 6. 資料完整性檢查
        const orphanObservations = db.prepare(`
          SELECT COUNT(*) as count FROM observations o
          LEFT JOIN entities e ON o.entityName = e.name
          WHERE e.name IS NULL
        `).get()?.count || 0;

        if (orphanObservations > 0) {
          report.issues.push(`發現 ${orphanObservations} 個孤立的觀察記錄`);
        }

        const orphanFromRelations = db.prepare(`
          SELECT COUNT(*) as count FROM relations r
          LEFT JOIN entities e ON r.fromEntity = e.name
          WHERE e.name IS NULL
        `).get()?.count || 0;

        const orphanToRelations = db.prepare(`
          SELECT COUNT(*) as count FROM relations r
          LEFT JOIN entities e ON r.toEntity = e.name
          WHERE e.name IS NULL
        `).get()?.count || 0;

        if (orphanFromRelations > 0 || orphanToRelations > 0) {
          report.issues.push(`發現孤立的關係記錄: from=${orphanFromRelations}, to=${orphanToRelations}`);
        }

        // 7. 時間戳驗證
        const invalidTimestamps = db.prepare(`
          SELECT COUNT(*) as count FROM (
            SELECT createdAt FROM entities WHERE createdAt NOT LIKE '%-%-%T%:%:%Z'
            UNION ALL
            SELECT createdAt FROM observations WHERE createdAt NOT LIKE '%-%-%T%:%:%Z'
            UNION ALL 
            SELECT createdAt FROM relations WHERE createdAt NOT LIKE '%-%-%T%:%:%Z'
          )
        `).get()?.count || 0;

        if (invalidTimestamps > 0) {
          report.issues.push(`發現 ${invalidTimestamps} 個無效的時間戳格式`);
        }

      } finally {
        db.close();
      }

      // 設定最終狀態
      report.status = report.issues.length === 0 ? 'pass' : 'fail';

      // 輸出結果
      const statusIcon = report.status === 'pass' ? '✅' : '❌';
      console.log(`   ${statusIcon} ${scenarioName}: ${report.statistics.entities} 實體, ${report.statistics.observations} 觀察, ${report.statistics.relations} 關係`);
      
      if (report.issues.length > 0) {
        report.issues.forEach(issue => console.log(`      ⚠️  ${issue}`));
      }

    } catch (error) {
      const message = (error instanceof Error) ? error.message : String(error);
      report.issues.push(`驗證過程發生錯誤: ${message}`);
      report.status = 'fail';
      console.log(`   💥 驗證失敗: ${message}`);
    }

    return report;
  }

  /**
   * 生成驗證摘要報告
   */
  private generateValidationSummary(reports: ValidationReport[]): void {
    console.log('\n📋 驗證摘要報告\n');
    console.log('情境名稱\t\t狀態\t\t實體數\t\t觀察數\t\t關係數\t\t問題數');
    console.log(''.padEnd(80, '-'));

    let totalPass = 0;
    let totalIssues = 0;

    reports.forEach(report => {
      const statusIcon = report.status === 'pass' ? '✅ 通過' : '❌ 失敗';
      const issueCount = report.issues.length;
      
      console.log(
        `${report.scenario.padEnd(16)}\t${statusIcon}\t\t${report.statistics.entities}\t\t${report.statistics.observations}\t\t${report.statistics.relations}\t\t${issueCount}`
      );

      if (report.status === 'pass') totalPass++;
      totalIssues += issueCount;
    });

    console.log(''.padEnd(80, '-'));
    console.log(`總計: ${totalPass}/${reports.length} 個情境通過驗證，發現 ${totalIssues} 個問題\n`);

    // 保存詳細報告
    const reportPath = path.join(this.testDir, 'validation-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: reports.length,
        passed: totalPass,
        totalIssues
      },
      reports
    }, null, 2));

    console.log(`📄 詳細驗證報告已保存: ${reportPath}`);
  }
}

// 主程序
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    console.log(`
VSS R2 測試資料驗證工具

使用方式:
  npm run build && node dist/tools/validate-test-data.js [options]

選項:
  --help           顯示此幫助
  --scenario=NAME  只驗證特定情境
  --dir=PATH       指定測試目錄 (預設: ./test-scenarios)

範例:
  node dist/tools/validate-test-data.js --scenario=small
  node dist/tools/validate-test-data.js --dir=./my-tests
    `);
    return;
  }

  const dirArg = args.find(arg => arg.startsWith('--dir='));
  const testDir = dirArg ? dirArg.split('=')[1] : './test-scenarios';

  const scenarioArg = args.find(arg => arg.startsWith('--scenario='));
  const targetScenario = scenarioArg ? scenarioArg.split('=')[1] : null;

  const validator = new TestDataValidator(testDir);

  if (targetScenario) {
    const report = await validator.validateScenario(targetScenario);
    process.exit(report.status === 'pass' ? 0 : 1);
  } else {
    const reports = await validator.validateAllScenarios();
    const allPassed = reports.every(report => report.status === 'pass');
    process.exit(allPassed ? 0 : 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}