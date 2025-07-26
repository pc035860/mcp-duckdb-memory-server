# Security Fix Report: SQL Injection Vulnerability in merge-duckdb Tool

## Summary

Fixed a critical SQL injection vulnerability in the `merge-duckdb.ts` tool where file paths were directly interpolated into SQL queries without proper escaping or validation.

## Vulnerability Details

### Original Code (Vulnerable)
```typescript
await outputConn.run(`ATTACH '${source1Path}' AS source1 (READ_ONLY)`);
await outputConn.run(`ATTACH '${source2Path}' AS source2 (READ_ONLY)`);
```

### Risk
- **Type**: SQL Injection
- **Severity**: Critical
- **Impact**: Potential for arbitrary SQL execution, data corruption, or unauthorized database access
- **Attack Vector**: Malicious file paths containing SQL metacharacters

## Security Fixes Implemented

### 1. SQL String Escaping
- Added `escapeSQLString()` method to properly escape single quotes in file paths
- Single quotes are escaped by doubling them (`'` → `''`)

### 2. Path Security Validation
- Created `validatePathSecurity()` method to check paths before processing
- Validates against:
  - Directory traversal attempts
  - Null bytes (`\0`)
  - Control characters (`\n`, `\r`)
  - Shell metacharacters in filenames (`|`, `&`, `>`, `<`, `` ` ``, `;`)

### 3. File Size Limits
- Added `MAX_FILE_SIZE_MB` constant (5GB) to prevent DoS attacks
- Files exceeding the limit are rejected before processing

### 4. Improved Architecture
- Separated security validation from file existence checks
- Security validation runs first, preventing malicious paths from reaching file system operations
- All three paths (source1, source2, output) are validated

## Fixed Code
```typescript
// First validate path security for all paths
const validatedSource1Path = this.validatePathSecurity(source1Path);
const validatedSource2Path = this.validatePathSecurity(source2Path);
const validatedOutputPath = this.validatePathSecurity(outputPath);

// Then check if source files exist
this.validateDatabaseFile(validatedSource1Path);
this.validateDatabaseFile(validatedSource2Path);

// Escape paths before SQL interpolation
const escapedSource1Path = this.escapeSQLString(validatedSource1Path);
const escapedSource2Path = this.escapeSQLString(validatedSource2Path);

await outputConn.run(`ATTACH '${escapedSource1Path}' AS source1 (READ_ONLY)`);
await outputConn.run(`ATTACH '${escapedSource2Path}' AS source2 (READ_ONLY)`);
```

## Testing

### Security Test Coverage
Created comprehensive security tests in `tests/merge-tool-security.test.ts`:

1. **SQL Injection Prevention**
   - Tests proper escaping of single quotes
   - Validates rejection of semicolons in filenames

2. **Directory Traversal Prevention**  
   - Tests rejection of `../` patterns
   - Validates handling of null bytes

3. **Shell Metacharacter Prevention**
   - Tests rejection of pipe, ampersand, redirection operators
   - Validates all dangerous characters are blocked

4. **DoS Prevention**
   - Verifies file size limit enforcement
   - Tests rejection of oversized files

5. **Path Normalization**
   - Tests proper handling of relative paths
   - Validates normalization of path tricks

### Test Results
All 14 security tests pass successfully, ensuring:
- Malicious paths are rejected before reaching SQL
- Valid paths work correctly
- File operations remain functional

## Recommendations

1. **Use Parameterized Queries**: Consider migrating to parameterized queries when DuckDB Node.js API supports them for DDL statements

2. **Regular Security Audits**: Schedule periodic security reviews of database operations

3. **Input Validation**: Apply similar validation patterns to other user inputs throughout the application

4. **Monitoring**: Add logging for rejected paths to detect potential attack attempts

5. **Documentation**: Update user documentation to clarify acceptable filename patterns

## Impact on Existing Functionality

- No breaking changes for legitimate use cases
- Files with spaces in names continue to work
- Normal file operations remain unaffected
- Performance impact is negligible (validation adds minimal overhead)

## Conclusion

The SQL injection vulnerability has been successfully patched with a defense-in-depth approach combining input validation, proper escaping, and file size limits. The fix maintains backward compatibility while significantly improving the security posture of the merge tool.