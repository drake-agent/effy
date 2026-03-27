# MCP Client Integration Guide for Effy

## Overview

The MCP (Model Context Protocol) client module integrates external MCP servers into Effy's tool system. This enables agents to dynamically access tools from remote servers (HTTP+SSE) or local processes (StdIO).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Effy Agent                                                   │
│  - Calls tools via agent API                                 │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│ Tool Registry (tool-registry.js)                             │
│  - Unified tool definitions (Effy native + MCP)              │
│  - Dispatch via tool dispatcher                              │
└────────────────┬────────────────────────────────────────────┘
                 │
         ┌───────▼────────────┐
         │ MCP Tool Dispatcher │
         │  (new mcp_call)     │
         └───────┬────────────┘
                 │
    ┌────────────┴────────────┐
    │                         │
┌───▼──────────────┐  ┌──────▼─────────────┐
│ MCP Registry     │  │ MCP Client         │
│ (registry.js)    │◄─┤ (client.js)        │
│                  │  │                    │
│ - Tool mapping   │  │ - Server mgmt      │
│ - Conversion     │  │ - Transport layer  │
│ - Routing        │  │ - Tool discovery   │
└──────────────────┘  └──────┬─────────────┘
                             │
                   ┌─────────┴──────────┐
                   │                    │
            ┌──────▼────────┐  ┌────────▼──────┐
            │ HTTP+SSE      │  │ StdIO         │
            │ Transport     │  │ Transport     │
            │ (transport.js)│  │ (transport.js)│
            └──────┬────────┘  └────────┬──────┘
                   │                    │
         ┌─────────▼────────┐  ┌────────▼──────┐
         │ HTTP+SSE Server  │  │ Local Binary  │
         │ (e.g., mcp-gh)   │  │ (e.g., mcp-fs)│
         └──────────────────┘  └───────────────┘
```

## Files Created

### 1. **transport.js** (373 lines)
Transport layer supporting two MCP connection modes:

- **HTTPSSETransport**: HTTP POST + Server-Sent Events
  - URL-based (remote servers)
  - Request-response pattern with pending queue
  - Suitable for web servers, load balancers

- **StdIOTransport**: Stdin/Stdout with child process
  - Command-based (local binaries)
  - JSONL message format
  - Low latency, no network overhead

### 2. **registry.js** (218 lines)
MCP Tool Registry bridges MCP tools to Effy's tool system:

- **Tool Conversion**: MCP tool definitions → Effy TOOL_DEFINITIONS format
- **Server Management**: Register/unregister MCP servers
- **Tool Routing**: Map tool calls to correct MCP server
- **Discovery**: Maintains tool → server ID mapping

Key methods:
- `registerServer(serverId, mcpClient, tools)` - Register tools from server
- `getTool(toolName)` - Get tool definition
- `callTool(toolName, input)` - Route and execute tool
- `getAllTools()` - Get all registered MCP tools

### 3. **client.js** (340 lines)
Main MCP Client managing all server connections:

- **MCPServerConnection**: Single server connection wrapper
  - Handles transport instantiation
  - Implements tools/list and tools/call MCP methods
  - Error handling and graceful degradation

- **MCPClient**: Orchestrates all servers
  - Loads config from effy.config.yaml (mcp section)
  - Initializes all servers in parallel
  - Exposes tool definitions to Effy
  - Provides singleton pattern

Key methods:
- `initialize()` - Load config and connect all servers
- `getToolDefinitions()` - Export tools for Effy
- `callTool(toolName, input)` - Execute MCP tool
- `getServerInfo()` - Debug info
- `shutdown()` - Cleanup

## Configuration

Add MCP configuration to `effy.config.yaml`:

```yaml
# ─── MCP Servers ───
mcp:
  timeout: 30000  # Global timeout (ms)

  servers:
    # HTTP+SSE based server
    - id: github
      transport: sse              # or 'http'
      url: http://localhost:3001/sse
      enabled: true

    # StdIO based server (local binary)
    - id: filesystem
      transport: stdio
      command: npx
      args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/workspace']
      enabled: true

    # Another remote server
    - id: custom-api
      transport: http
      url: https://mcp.mycompany.com/stream
      enabled: false              # Disabled for testing
```

## Integration Steps

### 1. Initialize MCP Client on Startup

In `src/app.js` or main entry:

```javascript
const { getMCPClient } = require('./mcp/client');

async function startup() {
  // Initialize MCP client
  const mcpClient = getMCPClient();
  await mcpClient.initialize();

  // Continue with other initialization...
}
```

### 2. Register MCP Tools in Tool Registry

Modify `src/agents/tool-registry.js`:

```javascript
const { getMCPToolDefinitions } = require('../mcp/client');

// Add MCP tools to TOOL_DEFINITIONS
const MCP_TOOLS = getMCPToolDefinitions();
const TOOL_DEFINITIONS = {
  // ... existing Effy tools ...
  ...MCP_TOOLS,
};
```

### 3. Create mcp_call Tool (Optional)

To allow agents to dynamically call MCP tools:

```javascript
// In TOOL_DEFINITIONS
mcp_call: {
  name: 'mcp_call',
  category: 'integration',
  description: 'Call any registered MCP tool. Use when you need external capabilities (GitHub, filesystem, custom APIs).',
  agents: ['*'],
  input_schema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'MCP tool name (e.g., "github_create_pull_request")' },
      input: {
        type: 'object',
        description: 'Tool input parameters',
      },
    },
    required: ['tool_name', 'input'],
  },
},

// Handler (in dispatcher)
async function dispatchMCPCall(toolName, input) {
  const { getMCPClient } = require('./mcp/client');
  const mcpClient = getMCPClient();

  if (!mcpClient.hasTool(input.tool_name)) {
    throw new Error(`Unknown MCP tool: ${input.tool_name}`);
  }

  return mcpClient.callTool(input.tool_name, input.input);
}
```

### 4. Shutdown on Process Exit

```javascript
process.on('SIGTERM', async () => {
  const { getMCPClient } = require('./mcp/client');
  const mcpClient = getMCPClient();
  await mcpClient.shutdown();
});
```

## Tool Discovery Flow

1. **Config Load**: Read MCP servers from `effy.config.yaml`
2. **Transport Instantiation**: Create HTTPSSETransport or StdIOTransport
3. **Connect**: Establish connection to server
4. **tools/list**: Request tool definitions from server
5. **Convert**: Transform MCP tool definitions to Effy format
6. **Register**: Add to MCPToolRegistry
7. **Expose**: Include in TOOL_DEFINITIONS for agents

## Tool Call Flow

1. **Agent Call**: Agent calls `mcp_call` or direct MCP tool
2. **Dispatch**: Tool dispatcher routes to appropriate handler
3. **Registry Lookup**: MCPToolRegistry maps tool name to server
4. **MCP Request**: Send `tools/call` to MCP server via transport
5. **Response**: Wait for result with timeout
6. **Return**: Pass result back to agent

## Error Handling

### Graceful Degradation
- If MCP config is missing or empty → silent initialization, no error
- If a server fails to connect → logged as warning, other servers continue
- If tool execution fails → error message with server info

### Connection Failures
- HTTPSSETransport: HTTP errors, SSE connection drops, timeouts
- StdIOTransport: Process spawn failures, pipe errors, exit codes

### Timeout Management
- Global timeout: `mcp.timeout` in config (default 30000ms)
- Per-request timeout on each send/receive
- Automatic cleanup of pending requests on timeout

## Logging

All MCP operations log to `[mcp-client]` and `[mcp-registry]` tags:

```
[2026-03-27T13:48:00Z] [INFO ] [mcp-client] 초기화 시작 {"serverCount":2}
[2026-03-27T13:48:01Z] [INFO ] [mcp-client] 도구 발견: github {"toolCount":15}
[2026-03-27T13:48:02Z] [INFO ] [mcp-client] 초기화 완료 {"connectedServers":2,"totalTools":25}
```

## Testing

### Test HTTP+SSE Connection

```bash
# Start a test MCP server
npx mcp-test-server --port 3001 --sse

# In Node REPL
const { getMCPClient } = require('./src/mcp/client');
const client = getMCPClient();
await client.initialize();
console.log(client.getServerInfo());
```

### Test StdIO Connection

```bash
# Config with stdio server
mcp:
  servers:
    - id: test-stdio
      transport: stdio
      command: node
      args: ['./test-mcp-server.js']
      enabled: true

# Check connection
const serverInfo = client.getServerInfo();
console.log(serverInfo[0].tools);
```

## Debugging

### Enable Debug Logging

```bash
LOG_LEVEL=debug node app.js
```

### Inspect Tool Definitions

```javascript
const client = getMCPClient();
const tools = client.getToolDefinitions();
console.log(Object.keys(tools)); // List all MCP tool names
```

### Monitor Server Status

```javascript
const serverInfo = client.getServerInfo();
console.log(JSON.stringify(serverInfo, null, 2));
// Output: [{ id, toolCount, tools: [...], discoveredAt }]
```

## Performance Considerations

### Concurrency
- HTTP+SSE: Sequential due to request queue per connection
- StdIO: One message at a time on pipe

### Memory
- Tool definitions cached in registry (~1-5KB per tool)
- Pending requests map bounded by timeout

### Latency
- HTTP+SSE: Network roundtrip + server processing
- StdIO: Process IPC only (faster locally)

## Security

### Input Validation
- Tool input validated against inputSchema (JSONSchema)
- Required fields enforced before calling server

### Process Isolation
- StdIO servers run in child processes (isolate from main thread)
- Timeouts prevent hanging processes

### URL Safety
- HTTP+SSE URLs hardcoded in config
- No dynamic URL construction from user input

## Known Limitations

1. **No Authentication**: HTTP+SSE doesn't support auth headers yet
   - Workaround: Use bearer tokens in URL or environment variables

2. **Large Payloads**: StdIO limited by pipe buffer (~65KB default)
   - Workaround: Stream large responses or use HTTP+SSE

3. **Tool Naming**: MCP tool names must be valid JS identifiers for direct use
   - Workaround: Use `mcp_call` tool for special names

## Future Enhancements

- [ ] Caching layer for tool definitions (avoid re-discovery)
- [ ] Connection pooling for HTTP+SSE
- [ ] Authentication support (OAuth, API keys)
- [ ] Retry policy with exponential backoff
- [ ] Server health checks / heartbeat
- [ ] Tool versioning support
- [ ] Resource usage monitoring
