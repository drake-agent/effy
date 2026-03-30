# MCP (Model Context Protocol) Client for Effy

Production-quality MCP client module that integrates external MCP servers into Effy's unified tool system.

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `client.js` | 340 | Main MCP client, server orchestration, singleton |
| `transport.js` | 373 | HTTP+SSE and StdIO transport implementations |
| `registry.js` | 218 | Tool registry, MCP→Effy conversion, routing |
| `INTEGRATION_GUIDE.md` | - | Complete integration documentation |
| `EXAMPLE_CONFIG.yaml` | - | Configuration examples and best practices |

## Quick Start

### 1. Configuration (effy.config.yaml)

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

### 2. Initialize (app.js)

```javascript
const { getMCPClient } = require('./mcp/client');

async function startup() {
  const mcpClient = getMCPClient();
  await mcpClient.initialize();
  // Handles errors gracefully, continues if servers unavailable
}
```

### 3. Integrate with Tool Registry (tool-registry.js)

```javascript
const { getMCPToolDefinitions } = require('../mcp/client');

const TOOL_DEFINITIONS = {
  // ... existing Effy tools ...
  ...getMCPToolDefinitions(),
};
```

### 4. Use in Agents

```javascript
// Option A: Direct MCP tool call (if tool name is valid)
await callTool('github_create_pull_request', {
  owner: 'myorg',
  repo: 'myrepo',
  title: 'Feature: ...', // ...
});

// Option B: Dynamic mcp_call tool (for any tool)
await callTool('mcp_call', {
  tool_name: 'github_create_pull_request',
  input: { owner: '...', repo: '...', title: '...' }
});
```

## Transport Modes

### HTTP+SSE
- **Use case**: Remote servers, web APIs
- **URL**: `http://localhost:3001/sse`
- **Pros**: Firewall-friendly, no local dependencies
- **Cons**: Network latency, requires HTTP server

```yaml
servers:
  - id: github
    transport: sse
    url: http://api.mcp.local:3001/sse
    enabled: true
```

### StdIO
- **Use case**: Local binaries, Node.js/Python packages
- **Command**: `npx @anthropic-ai/mcp-server-filesystem`
- **Pros**: Low latency, no network overhead
- **Cons**: Must be locally installed

```yaml
servers:
  - id: filesystem
    transport: stdio
    command: npx
    args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/app/data']
    enabled: true
```

## Architecture Diagram

```
Agent Request
     ↓
Tool Registry (Effy + MCP tools)
     ↓
MCP Client (Orchestrator)
     ↓
┌─────────────────┬─────────────────┐
│                 │                 │
↓                 ↓                 ↓
HTTP+SSE        StdIO            ...
Transport       Transport
     ↓                 ↓
Remote Server   Local Binary
(GitHub MCP)    (filesystem)
```

## Key Classes

### MCPClient
Main client managing all servers.

```javascript
const { getMCPClient } = require('./mcp/client');
const client = getMCPClient();

await client.initialize();           // Load & connect all servers
const tools = client.getToolDefinitions();  // Get all tools
await client.callTool(name, input);  // Execute tool
const info = client.getServerInfo(); // Debug info
await client.shutdown();             // Cleanup
```

### MCPToolRegistry
Maps MCP tools to Effy format and routes calls.

```javascript
const { MCPToolRegistry } = require('./mcp/registry');
const registry = new MCPToolRegistry();

registry.registerServer(id, client, tools);
registry.getTool(name);
registry.callTool(name, input);
registry.getAllTools();
registry.listServers();
```

### HTTPSSETransport
HTTP+SSE transport implementation.

```javascript
const { HTTPSSETransport } = require('./mcp/transport');
const transport = new HTTPSSETransport('http://localhost:3001/sse');

await transport.connect();
const response = await transport.send(message);
transport.close();
```

### StdIOTransport
StdIO transport for child processes.

```javascript
const { StdIOTransport } = require('./mcp/transport');
const transport = new StdIOTransport('npx', ['@mcp/pkg']);

await transport.connect();
const response = await transport.send(message);
transport.close();
```

## Error Handling

### Graceful Degradation
- If MCP config missing → no error, just skip
- If server connection fails → logged as warning, others continue
- If tool execution fails → error message with details

```javascript
// Safe even if MCP is unconfigured
const client = getMCPClient();
await client.initialize(); // Returns silently if no servers
const tools = client.getToolDefinitions(); // Returns {} if not initialized
```

### Timeouts
- Global timeout: `mcp.timeout` config (default 30s)
- Per-request timeout: Automatic cleanup if no response
- Pending requests: Tracked and cleaned up on close

## Configuration Reference

```yaml
mcp:
  timeout: 30000                    # Global request timeout (ms)

  servers:
    - id: string                    # Server identifier
      transport: sse|http|stdio     # Connection mode

      # For SSE/HTTP:
      url: string                   # Endpoint URL

      # For StdIO:
      command: string               # Executable (npx, python3, etc)
      args: [string]                # Command arguments

      enabled: true|false           # Enable/disable this server
      timeout: 30000                # (Optional) Override global timeout
```

## Logging

All MCP operations log to `[mcp-client]` and `[mcp-registry]` components:

```bash
LOG_LEVEL=debug node app.js

# Sample output:
# [2026-03-27T13:48:00Z] [INFO ] [mcp-client] 초기화 시작 {"serverCount":2}
# [2026-03-27T13:48:01Z] [INFO ] [mcp-client] 도구 발견: github {"toolCount":15}
# [2026-03-27T13:48:01Z] [INFO ] [mcp-registry] 서버 등록: github {"toolCount":15}
# [2026-03-27T13:48:02Z] [INFO ] [mcp-client] 초기화 완료 {"connectedServers":2,"totalTools":25}
```

## Testing

### Mock Server
```javascript
// Start a simple MCP test server
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","result":{"tools":[]}}\n\n');
  }
});
server.listen(3001);
```

### Direct Test
```javascript
const { getMCPClient } = require('./src/mcp/client');

(async () => {
  const client = getMCPClient();
  await client.initialize();
  console.log(client.getServerInfo());
  const tools = client.getToolDefinitions();
  console.log(Object.keys(tools));
  await client.shutdown();
})();
```

## Security Notes

- **No Secrets in Config**: Use environment variables `${VAR_NAME}`
- **Process Isolation**: StdIO servers run in child processes
- **Input Validation**: Tool inputs validated against inputSchema
- **Timeout Protection**: Prevents hanging requests/processes

## Performance

- **Memory**: ~1-5KB per tool definition
- **Latency**: HTTP+SSE ~50-200ms, StdIO ~5-50ms
- **Throughput**: Sequential per connection (implement pooling if needed)

## Known Limitations

- No built-in authentication for HTTP+SSE
- Large payloads (~65KB+) may fail on StdIO
- Tool names must be valid identifiers (use `mcp_call` for special names)

## See Also

- `INTEGRATION_GUIDE.md` - Complete integration documentation
- `EXAMPLE_CONFIG.yaml` - Configuration examples and best practices
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Anthropic MCP Servers](https://github.com/anthropics/mcp-servers)

---

**Created**: 2026-03-27
**Status**: Production Ready
**Effy Version**: 4.0+
