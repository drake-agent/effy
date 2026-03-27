# MCP Client Module for Effy - File Index

## Navigation Guide

Start here based on your needs:

### For Quick Integration (5-10 minutes)
1. Read: [README.md](README.md) - Quick start guide
2. Copy config from: [EXAMPLE_CONFIG.yaml](EXAMPLE_CONFIG.yaml) - Lines 1-30
3. Follow integration steps in [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) - "Integration Steps" section

### For Complete Understanding (30 minutes)
1. Start with: [README.md](README.md) - Architecture overview
2. Deep dive: [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) - Complete documentation
3. Reference: [EXAMPLE_CONFIG.yaml](EXAMPLE_CONFIG.yaml) - All configuration examples

### For Implementation Details
1. Client logic: [client.js](client.js)
2. Transport layer: [transport.js](transport.js)
3. Tool registry: [registry.js](registry.js)

### For Troubleshooting
1. Check: [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md#troubleshooting) - Debugging tips
2. Reference: [EXAMPLE_CONFIG.yaml](EXAMPLE_CONFIG.yaml#troubleshooting) - Troubleshooting section
3. Debug: Enable `LOG_LEVEL=debug` to see detailed logs

### For Code Review
1. [CHECKLIST.md](CHECKLIST.md) - All requirements verification
2. [IMPLEMENTATION_SUMMARY.txt](IMPLEMENTATION_SUMMARY.txt) - Architecture and features
3. Code files: [client.js](client.js), [transport.js](transport.js), [registry.js](registry.js)

---

## File Descriptions

### Production Code

#### client.js (340 lines)
**Purpose**: Main MCP client orchestrator

**Classes**:
- `MCPClient` - Singleton managing all servers
- `MCPServerConnection` - Wrapper for individual server connections

**Key Methods**:
- `initialize()` - Load config and connect all servers
- `getToolDefinitions()` - Export MCP tools to Effy
- `callTool()` - Execute an MCP tool
- `getServerInfo()` - Debug information
- `shutdown()` - Cleanup and close connections

**Exports**:
- `getMCPClient()` - Get singleton instance
- `getMCPToolDefinitions()` - Export tools for Effy integration

**Dependencies**:
- `../config` - Configuration loader
- `../shared/logger` - Logging
- `./transport` - Transport implementations
- `./registry` - Tool registry

---

#### transport.js (373 lines)
**Purpose**: Transport layer for two MCP communication modes

**Classes**:
- `HTTPSSETransport` - HTTP POST + Server-Sent Events
  - For remote servers, web APIs, firewall-friendly
  - Request-response with message ID tracking
  
- `StdIOTransport` - Child process stdin/stdout
  - For local binaries, low latency
  - JSONL format (one JSON object per line)

**Common Interface**:
- `connect()` - Establish connection
- `send(message)` - Send message and wait for response
- `close()` - Close connection and cleanup

**Features**:
- Automatic message ID tracking
- Built-in timeout management (global + per-request)
- Proper resource cleanup
- Event-driven message handling

**Dependencies**:
- Node.js built-ins: `http`, `child_process`, `events`

---

#### registry.js (218 lines)
**Purpose**: Bridge between MCP tool definitions and Effy's tool system

**Classes**:
- `MCPToolRegistry` - Tool registry and conversion

**Key Methods**:
- `registerServer()` - Register tools from an MCP server
- `getTool()` - Get individual tool definition
- `callTool()` - Execute an MCP tool (routed via client)
- `getAllTools()` - Export all MCP tools
- `listServers()` - Debug: list all registered servers
- `unregisterServer()` - Remove a server
- `clear()` - Full cleanup

**Features**:
- Converts MCP format to Effy TOOL_DEFINITIONS format
- Maintains server → tools mapping
- Tool category inference from MCP tool names

**Dependencies**:
- `../shared/logger` - Logging

---

### Documentation

#### README.md (7.6 KB, ~300 lines)
**Purpose**: Quick reference and getting started guide

**Sections**:
- Quick Start (3 steps)
- Transport Modes (comparison)
- Architecture Diagram
- Key Classes Reference
- Configuration Reference
- Error Handling Patterns
- Logging and Debugging
- Testing Instructions
- Security Notes
- Performance Characteristics

**Best for**: Developers who need a quick overview

---

#### INTEGRATION_GUIDE.md (12 KB, ~250 lines)
**Purpose**: Complete technical documentation

**Sections**:
- Architecture Overview with Diagram
- File-by-File Documentation
- Configuration Guide with Examples
- Integration Steps (Startup, Registry, Dispatch, Shutdown)
- Tool Discovery Flow (with steps)
- Tool Call Flow (with steps)
- Error Handling Strategy
- Logging Examples
- Testing Instructions
- Debugging Tips
- Performance Considerations
- Security Best Practices
- Known Limitations
- Future Enhancements

**Best for**: System architects and deep technical review

---

#### EXAMPLE_CONFIG.yaml (9.3 KB, ~200 lines)
**Purpose**: Real-world configuration examples and best practices

**Sections**:
- Example 1: HTTP+SSE Remote Servers
- Example 2: StdIO Local Binaries
- Example 3: Mixed Setup (Recommended)
- Example 4: Development Environment Override
- Tool Usage Examples
- Typical Agent Capabilities
- Environment Variables Guide
- Security Best Practices
- Troubleshooting Guide

**Best for**: Operations teams and configuration setup

---

#### IMPLEMENTATION_SUMMARY.txt (14 KB, ~400 lines)
**Purpose**: Executive summary of the entire project

**Sections**:
- Project Scope
- Requirements Checklist (all met)
- Files Overview with Details
- Architecture Highlights
- Integration Points
- Code Quality Features
- Configuration Examples
- Testing Checklist
- Deployment Checklist
- Statistics
- Future Enhancements

**Best for**: Project managers and stakeholders

---

#### CHECKLIST.md (~200 lines)
**Purpose**: Comprehensive delivery verification

**Sections**:
- Production Code Files (with verification)
- Documentation Files (with verification)
- Code Quality Requirements (all checked)
- Architecture Requirements (all met)
- Integration Points (all documented)
- Test Readiness (all covered)
- Documentation Completeness (100%)
- Security Checklist (all verified)
- Performance Considerations (all addressed)
- Delivery Status

**Best for**: Quality assurance and project completion verification

---

## Quick Reference

### Configuration (effy.config.yaml)

```yaml
mcp:
  timeout: 30000
  servers:
    - id: github
      transport: sse
      url: http://localhost:3001/sse
      enabled: true

    - id: filesystem
      transport: stdio
      command: npx
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/workspace']
      enabled: true
```

### Startup (app.js)

```javascript
const { getMCPClient } = require('./mcp/client');
const mcpClient = getMCPClient();
await mcpClient.initialize();
```

### Integration (tool-registry.js)

```javascript
const { getMCPToolDefinitions } = require('../mcp/client');
const TOOL_DEFINITIONS = {
  ...existingTools,
  ...getMCPToolDefinitions()
};
```

### Usage (agent code)

```javascript
// Direct call
await callTool('github_create_pull_request', {...});

// Dynamic call
await callTool('mcp_call', {
  tool_name: 'github_create_pull_request',
  input: {...}
});
```

---

## Statistics

| Metric | Value |
|--------|-------|
| Production Code Files | 3 |
| Production Code Lines | 931 |
| Documentation Files | 5 |
| Documentation Lines | 1,475 |
| **Total Lines** | **2,406** |
| Classes | 5 |
| Methods | 30+ |
| All Syntax Validated | ✓ |

---

## Getting Help

1. **Quick questions?** → See [README.md](README.md)
2. **How do I configure?** → See [EXAMPLE_CONFIG.yaml](EXAMPLE_CONFIG.yaml)
3. **How do I integrate?** → See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md#integration-steps)
4. **Something's broken?** → See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md#debugging)
5. **What's not working?** → Check [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md#error-handling)

---

## Deployment Checklist

Before deploying to production:

- [ ] Read [README.md](README.md) - Understand the architecture
- [ ] Copy config from [EXAMPLE_CONFIG.yaml](EXAMPLE_CONFIG.yaml)
- [ ] Call `getMCPClient().initialize()` on startup
- [ ] Include `getMCPToolDefinitions()` in TOOL_DEFINITIONS
- [ ] Test with at least one MCP server
- [ ] Enable proper logging: `LOG_LEVEL=info`
- [ ] Set up graceful shutdown hook
- [ ] Review security section in [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md#security)
- [ ] Create runbook for MCP server issues
- [ ] Document available MCP tools for your team

---

**Status**: ✓ Production Ready | **Updated**: 2026-03-27 | **Version**: 1.0
