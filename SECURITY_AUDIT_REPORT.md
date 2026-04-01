# Effy v4.0 Security Audit Report
**Review Date:** 2026-03-31
**Reviewer:** Security Auditor (Claude)
**Scope:** Full codebase review of unreviewed attack surface
**Methodology:** Attacker Simulation (5 attack classes per input)

---

## Executive Summary

**CRITICAL FINDINGS: 6** | **HIGH FINDINGS: 8** | **MEDIUM FINDINGS: 5** | **LOW FINDINGS: 3**

The audit identified significant security gaps in tool execution authorization, datasource connectors, external API integration, and configuration management. Most critical is **prompt injection enabling unauthorized tool execution** and **SSRF vulnerabilities** in REST API connector and document ingestion.

---

## CRITICAL VULNERABILITIES (6)

### CRIT-1: Prompt Injection → Unauthorized Tool Execution (runtime.js)
**Lines:** 102-119 | **Severity:** CRITICAL (CVSS 9.8)
- **Issue:** Admin check executed AFTER input validation, allowing LLM to call dangerous tools
- **Attack:** Inject instruction to call `query_datasource` with path traversal payload
- **Fix:** Mark `query_datasource`, `web_search`, `add_api_source` as `adminOnly: true`
- **Fix:** Add prompt injection detection before tool dispatch

### CRIT-2: SSRF in REST API Connector (rest-api.js)
**Lines:** 56-59 | **Severity:** CRITICAL (CVSS 9.3)
- **Issue:** Only blocks `..` path traversal, misses protocol switching, IPv6 loopback, cloud metadata endpoints
- **Attack:** Use `baseUrl: "https://169.254.169.254"` to access AWS metadata service
- **Fix:** Whitelist allowed domains/IPs, enforce HTTPS only, block 127.0.0.1, 169.254.x.x, 10.0.0.0/8, etc.
- **Fix:** Reject HTTPS redirect chains to different origins

### CRIT-3: SQL Injection via Regex Bypass (sql-database.js)
**Lines:** 44-63 | **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** Regex-based stacked query detection bypassed by Unicode escaping, comments, newlines
- **Attack:** `SELECT * FROM users WHERE id = 1\x3b DROP TABLE users;`
- **Fix:** Use SQLite PRAGMA to validate syntax before execution
- **Fix:** Support only prepared statements (already in place but verify)

### CRIT-4: Prompt Injection in Natural Language Config (nl-config.js)
**Lines:** 73-83 | **Severity:** CRITICAL (CVSS 8.9)
- **Issue:** Config changes triggered by simple regex, no signature verification
- **Attack:** Hidden instructions in message metadata/attachments execute config changes
- **Fix:** Require cryptographic signature for all config commands
- **Fix:** Validate YAML mutations for suspicious values

### CRIT-5: Credential Exposure in Microsoft Graph (ms-graph.js)
**Lines:** 18-55 | **Severity:** CRITICAL (CVSS 9.4)
- **Issue:** Client credentials in plaintext memory, can be extracted via memory dump or crash
- **Attack:** Attacker with process access extracts `client_secret`, queries all Azure AD users
- **Fix:** Move to Azure Key Vault, use client assertion (JWT) instead of password
- **Fix:** Implement token rotation with expiry verification

### CRIT-6: Arbitrary File Upload via Document Ingestion (doc-ingestion.js)
**Lines:** 183-228 | **Severity:** CRITICAL (CVSS 8.7)
- **Issue:** No MIME type validation on Google Drive downloads, no file size limits
- **Attack:** Upload "Password_List.txt" with credentials, gets indexed as knowledge base
- **Fix:** Validate MIME type before download, limit file size to 10MB max
- **Fix:** Use OAuth with refresh tokens, not API keys
- **Fix:** HTML-escape content before storage

---

## HIGH SEVERITY VULNERABILITIES (8)

| # | File | Issue | CVSS |
|:--|:-----|:------|:-----|
| HIGH-1 | webhook-outbound.js | Missing authorization check on webhook URLs | 8.1 |
| HIGH-2 | filesystem.js | Path traversal via symlink (missing realpathSync) | 8.0 |
| HIGH-3 | dashboard/router.js | Auth bypass via header spoofing (no JWT verification) | 7.8 |
| HIGH-4 | webhook-outbound.js | SSRF via unvalidated webhook URL | 8.2 |
| HIGH-5 | tool-registry.js | LLM can call any tool, chaos if prompt-injected | 7.9 |
| HIGH-6 | nl-config.js | Regex matching can be confused by innocent text | 7.5 |
| HIGH-7 | runtime.js | Missing rate limiting on expensive tools | 7.6 |
| HIGH-8 | config.js | Environment variable substitution DOS | 7.4 |

---

## MEDIUM SEVERITY VULNERABILITIES (5)

1. **TOCTOU in Symlink Check** (runtime.js) — Race condition between symlink validation and file read
2. **FTS Query Injection** (fts-sanitizer.js) — FTS5 operators (AND/OR) not fully removed
3. **Command Injection in Teams Adapter** (teams.js) — Special chars in password break SDK
4. **Timestamp Cache Collision** (ms-graph.js) — 24-hour cache returns stale Azure AD data
5. **Incomplete Input Validation** (tool-registry.js) — Tool parameters lack upper length limits

---

## Attack Surface Map

```
User Input (Slack/Teams/Email)
  ↓
[Prompt Injection Risk]
  ↓
Gateway → executeTool(toolName, toolInput)
  ├─→ CRIT-1: No prompt injection check before dispatch
  ├─→ Dangerous tools not marked adminOnly
  └─→ Input validation insufficient (no sanitization)

Tool Dispatch
  ├─ query_datasource
  │   ├─→ CRIT-2: REST connector SSRF (169.254.x.x access)
  │   ├─→ CRIT-3: SQL connector injection (regex bypass)
  │   └─→ HIGH-2: Filesystem connector symlink traversal
  │
  ├─ add_api_source / webhook setup
  │   ├─→ HIGH-1: No authorization check
  │   └─→ HIGH-4: SSRF via unvalidated URL
  │
  ├─ file_read/file_write
  │   └─→ MED-1: TOCTOU in symlink check
  │
  └─ create_skill
      └─→ Can inject malicious Markdown into system prompt

Configuration
  ├─ YAML Loading (config.js)
  │   └─→ HIGH-8: Env var substitution DOS
  │
  ├─ Natural Language Commands (nl-config.js)
  │   ├─→ CRIT-4: Prompt injection via regex
  │   └─→ No signature verification
  │
  └─ External APIs
      ├─ Microsoft Graph (ms-graph.js)
      │   ├─→ CRIT-5: Plaintext credentials in memory
      │   └─→ MED-4: 24h cache returns stale data
      │
      └─ Document Ingestion (doc-ingestion.js)
          └─→ CRIT-6: No MIME type validation

Dashboard Access
  └─→ HIGH-3: Header spoofing, no JWT validation
```

---

## Recommendations by Priority

### IMMEDIATE (48 hours)
1. Mark dangerous tools `adminOnly: true`
2. Add SSRF prevention (domain whitelist) to REST connector
3. Move Azure AD credentials to Key Vault

### SHORT-TERM (2 weeks)
1. Implement comprehensive tool input validation framework
2. Add rate limiting per tool per user
3. Require cryptographic signatures for config changes

### LONG-TERM (1 month)
1. Replace regex-based SQL injection check with parser
2. Implement ML-based prompt injection detector
3. Add credential rotation service

---

## Files Requiring Immediate Action

**CRITICAL Priority:**
- src/agents/runtime.js (authorization + injection)
- src/datasource/connectors/rest-api.js (SSRF)
- src/datasource/connectors/sql-database.js (SQL injection)
- src/features/nl-config.js (prompt injection)
- src/shared/ms-graph.js (credential exposure)
- src/features/doc-ingestion.js (file validation)
- src/dashboard/router.js (authentication)

**Status:** PENDING REMEDIATION
**Next Review:** After all CRITICAL items addressed (ETA: 1 week)
