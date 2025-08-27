/**
 * 文字處理工具函數
 */

/**
 * 檢測字串是否包含中日韓（CJK）字元
 * 
 * 包含的 Unicode 範圍：
 * - \u4e00-\u9fff: CJK 統一表意文字（主要中文字元）
 * - \u3400-\u4dbf: CJK 擴展 A 區
 * - \uf900-\ufaff: CJK 相容表意文字
 * - \u3040-\u309f: 平假名（日文）
 * - \u30a0-\u30ff: 片假名（日文）
 * - \uac00-\ud7af: 韓文音節
 * 
 * @param text 要檢測的字串
 * @returns 如果包含 CJK 字元則返回 true，否則返回 false
 */
export function containsCJK(text: string): boolean {
  if (!text) {
    return false;
  }
  
  // CJK Unicode 範圍正規表達式
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
  
  return cjkPattern.test(text);
}

/**
 * 檢測字串是否包含中文字元（僅中文，不包含日韓文）
 * 
 * 包含的 Unicode 範圍：
 * - \u4e00-\u9fff: CJK 統一表意文字（主要中文字元）
 * - \u3400-\u4dbf: CJK 擴展 A 區
 * - \uf900-\ufaff: CJK 相容表意文字
 * 
 * @param text 要檢測的字串
 * @returns 如果包含中文字元則返回 true，否則返回 false
 */
export function containsChinese(text: string): boolean {
  if (!text) {
    return false;
  }
  
  // 中文 Unicode 範圍正規表達式
  const chinesePattern = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  
  return chinesePattern.test(text);
}

/**
 * 取得字串中的 CJK 字元數量
 * 
 * @param text 要計算的字串
 * @returns CJK 字元的數量
 */
export function getCJKCharCount(text: string): number {
  if (!text) {
    return 0;
  }
  
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
  return cjkMatches ? cjkMatches.length : 0;
}

/**
 * 檢測字串是否主要由 CJK 字元組成（CJK 字元佔比超過 50%）
 * 
 * @param text 要檢測的字串
 * @returns 如果 CJK 字元佔比超過 50% 則返回 true
 */
export function isPrimarilyCJK(text: string): boolean {
  if (!text) {
    return false;
  }
  
  const totalChars = text.length;
  const cjkChars = getCJKCharCount(text);
  
  return cjkChars / totalChars > 0.5;
}