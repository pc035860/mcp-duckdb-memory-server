import { describe, it, expect } from "vitest";
import {
  containsCJK,
  containsChinese,
  getCJKCharCount,
  isPrimarilyCJK,
} from "../src/utils/text-utils";

describe("Text Utils - CJK Detection", () => {
  describe("containsCJK", () => {
    it("should return false for empty or null/undefined strings", () => {
      expect(containsCJK("")).toBe(false);
      expect(containsCJK(null as any)).toBe(false);
      expect(containsCJK(undefined as any)).toBe(false);
    });

    it("should return false for pure English text", () => {
      expect(containsCJK("hello world")).toBe(false);
      expect(containsCJK("Hello World 123")).toBe(false);
      expect(containsCJK("user authentication system")).toBe(false);
      expect(containsCJK("API endpoints configuration")).toBe(false);
    });

    it("should return true for Chinese characters", () => {
      expect(containsCJK("你好")).toBe(true);
      expect(containsCJK("世界")).toBe(true);
      expect(containsCJK("用戶認證")).toBe(true);
      expect(containsCJK("搜尋功能")).toBe(true);
      expect(containsCJK("數據庫")).toBe(true);
    });

    it("should return true for mixed Chinese and English text", () => {
      expect(containsCJK("hello 你好")).toBe(true);
      expect(containsCJK("用戶 authentication")).toBe(true);
      expect(containsCJK("API 接口")).toBe(true);
      expect(containsCJK("search 搜尋 function")).toBe(true);
    });

    it("should return true for Japanese characters", () => {
      expect(containsCJK("こんにちは")).toBe(true); // Hiragana
      expect(containsCJK("カタカナ")).toBe(true); // Katakana
      expect(containsCJK("日本語")).toBe(true); // Kanji
    });

    it("should return true for Korean characters", () => {
      expect(containsCJK("안녕하세요")).toBe(true);
      expect(containsCJK("한국어")).toBe(true);
    });

    it("should handle special characters and numbers", () => {
      expect(containsCJK("123 !@# $%^")).toBe(false);
      expect(containsCJK("你好123")).toBe(true);
      expect(containsCJK("hello@世界.com")).toBe(true);
    });
  });

  describe("containsChinese", () => {
    it("should return false for empty or null/undefined strings", () => {
      expect(containsChinese("")).toBe(false);
      expect(containsChinese(null as any)).toBe(false);
      expect(containsChinese(undefined as any)).toBe(false);
    });

    it("should return false for pure English text", () => {
      expect(containsChinese("hello world")).toBe(false);
      expect(containsChinese("user management")).toBe(false);
      expect(containsChinese("database connection")).toBe(false);
    });

    it("should return true for simplified Chinese characters", () => {
      expect(containsChinese("你好")).toBe(true);
      expect(containsChinese("用户")).toBe(true);
      expect(containsChinese("数据库")).toBe(true);
      expect(containsChinese("搜索")).toBe(true);
    });

    it("should return true for traditional Chinese characters", () => {
      expect(containsChinese("您好")).toBe(true);
      expect(containsChinese("用戶")).toBe(true);
      expect(containsChinese("數據庫")).toBe(true);
      expect(containsChinese("搜尋")).toBe(true);
    });

    it("should return true for mixed Chinese and English text", () => {
      expect(containsChinese("hello 世界")).toBe(true);
      expect(containsChinese("API 接口")).toBe(true);
      expect(containsChinese("用户 authentication")).toBe(true);
    });

    it("should return false for Japanese-only characters (no Chinese)", () => {
      // Note: This might return true for some Kanji that are also used in Chinese
      // These tests focus on pure Hiragana/Katakana
      expect(containsChinese("こんにちは")).toBe(false); // Hiragana only
      expect(containsChinese("カタカナ")).toBe(false); // Katakana only
    });

    it("should return false for Korean-only characters", () => {
      expect(containsChinese("안녕하세요")).toBe(false);
      expect(containsChinese("한국어")).toBe(false);
    });
  });

  describe("getCJKCharCount", () => {
    it("should return 0 for empty or null/undefined strings", () => {
      expect(getCJKCharCount("")).toBe(0);
      expect(getCJKCharCount(null as any)).toBe(0);
      expect(getCJKCharCount(undefined as any)).toBe(0);
    });

    it("should return 0 for pure English text", () => {
      expect(getCJKCharCount("hello world")).toBe(0);
      expect(getCJKCharCount("123 ABC")).toBe(0);
    });

    it("should count Chinese characters correctly", () => {
      expect(getCJKCharCount("你好")).toBe(2);
      expect(getCJKCharCount("用戶認證")).toBe(4);
      expect(getCJKCharCount("數據庫管理系統")).toBe(7);
    });

    it("should count only CJK characters in mixed text", () => {
      expect(getCJKCharCount("hello 你好 world")).toBe(2);
      expect(getCJKCharCount("API 接口 123")).toBe(2);
      expect(getCJKCharCount("用戶 user 認證 auth")).toBe(4);
    });

    it("should count Japanese and Korean characters", () => {
      expect(getCJKCharCount("こんにちは")).toBe(5); // Hiragana
      expect(getCJKCharCount("카타카나")).toBe(4); // Korean
    });
  });

  describe("isPrimarilyCJK", () => {
    it("should return false for empty or null/undefined strings", () => {
      expect(isPrimarilyCJK("")).toBe(false);
      expect(isPrimarilyCJK(null as any)).toBe(false);
      expect(isPrimarilyCJK(undefined as any)).toBe(false);
    });

    it("should return false for pure English text", () => {
      expect(isPrimarilyCJK("hello world")).toBe(false);
      expect(isPrimarilyCJK("user authentication")).toBe(false);
    });

    it("should return true for pure CJK text", () => {
      expect(isPrimarilyCJK("你好世界")).toBe(true);
      expect(isPrimarilyCJK("用戶認證系統")).toBe(true);
      expect(isPrimarilyCJK("こんにちは")).toBe(true);
    });

    it("should return true when CJK characters are majority (>50%)", () => {
      expect(isPrimarilyCJK("你好a")).toBe(true); // 2 CJK, 1 English: 2/3 = 66%
      expect(isPrimarilyCJK("用戶認證API")).toBe(true); // 4 CJK, 3 English: 4/7 = 57%
    });

    it("should return false when CJK characters are minority (≤50%)", () => {
      expect(isPrimarilyCJK("hello你好")).toBe(false); // 2 CJK, 5 English: 2/7 = 28%
      expect(isPrimarilyCJK("authentication認證")).toBe(false); // 2 CJK, 12 English: 2/14 = 14%
      expect(isPrimarilyCJK("API接口")).toBe(false); // 2 CJK, 3 English: 2/5 = 40%
    });

    it("should handle edge case of exactly 50%", () => {
      expect(isPrimarilyCJK("你a")).toBe(false); // 1 CJK, 1 English: 1/2 = 50% (not >50%)
      expect(isPrimarilyCJK("你好ab")).toBe(false); // 2 CJK, 2 English: 2/4 = 50% (not >50%)
    });
  });

  describe("Edge Cases", () => {
    it("should handle common Chinese punctuation and symbols", () => {
      // Test with common Chinese characters that should be detected
      expect(containsChinese("中")).toBe(true); // Basic Chinese character
      expect(containsCJK("中")).toBe(true);
      // Note: Special Unicode blocks like Enclosed CJK Letters (㊣) are not included
      // in our basic Chinese detection ranges for search purposes
    });

    it("should handle mixed punctuation", () => {
      expect(containsChinese("你好，世界！")).toBe(true);
      expect(containsChinese("Hello, 世界!")).toBe(true);
      expect(getCJKCharCount("你好，世界！")).toBe(4); // Only characters, not punctuation
    });

    it("should handle whitespace", () => {
      expect(containsChinese("   你好   ")).toBe(true);
      expect(getCJKCharCount("   你好   ")).toBe(2);
      expect(isPrimarilyCJK("   你好   ")).toBe(false); // 2 CJK, 6 spaces: 2/8 = 25%
    });
  });
});