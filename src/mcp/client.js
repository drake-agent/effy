/**
 * client.js — MCP (Model Context Protocol) Client for Effy.
 *
 * MCP 서버와의 연결 관리, 도구 발견, 도구 호출을 담당하는 메인 클라이언트.
 *
 * 지원 트랜스포트:
 *   - http: HTTP+SSE (원격 서버, 방화벽 우호)
 *   - sse: HTTP+SSE (동일)
 *   - stdio: StdIO (자식 프로세스, 로컬 바이너리)
 *
 * 아키텍처:
 *   1. effy.config.yaml에서 MCP 서버 설정 로드
 *   2. 연결 수립 (transport 기반)
 *   3. tools/list 요청으로 도구 발견
 *   4. Registry에 등록 → Effy 도구 시스템에 노출
 *   5. 도구 호출 시 MCP 프로토콜로 실행
 */

const config = require('../config');
const { createLogger } = require('../shared/logger');
const { HTTPSSETransport, StdIOTransport } = require('./transport');
const { MCPToolRegistry } = require('./registry');

const logger = createLogger('mcp-client');

/**
 * 단일 MCP 서버 연결을 나타내는 클래스.
 *
 * @class MCPServerConnection
 */
class MCPServerConnection {
  constructor(serverConfig) {
    this.id = serverConfig.id;
    this.transport = serverConfig.transport || 'sse';
    this.url = serverConfig.url;
    this.command = serverConfig.command;
    this.args = serverConfig.args;
    this.enabled = serverConfig.enabled !== false;
    this.timeout = serverConfig.timeout || 30000;
    this.transportInstance = null;
    this.isConnected = false;
  }

  /**
   * Transport 인스턴스 생성 및 연결 수립.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (!this.enabled) {
      logger.info(`[MCP] 서버 비활성화 (스킵): ${this.id}`);
      return;
    }

    try {
      if (this.transport === 'sse' || this.transport === 'http') {
        // HTTP+SSE Transport
        this.transportInstance = new HTTPSSETransport(this.url, {
          timeout: this.timeout,
          logger,
        });
      } else if (this.transport === 'stdio') {
        // StdIO Transport
        this.transportInstance = new StdIOTransport(this.command, this.args, {
          timeout: this.timeout,
          logger,
        });
      } else {
        throw new Error(`지원하지 않는 트랜스포트: ${this.transport}`);
      }

      await this.transportInstance.connect();
      this.isConnected = true;

      logger.info(`[MCP] 서버 연결 성공: ${this.id}`, {
        transport: this.transport,
      });
    } catch (err) {
      logger.error(`[MCP] 서버 연결 실패: ${this.id}`, {
        transport: this.transport,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * 도구 목록 요청 (MCP protocol: tools/list).
   *
   * @returns {Promise<array>} 도구 배열
   */
  async listTools() {
    if (!this.isConnected) {
      throw new Error(`연결되지 않은 서버: ${this.id}`);
    }

    try {
      const response = await this.transportInstance.send({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
      });

      // MCP 응답 형식: { result: { tools: [...] } }
      if (response.result && Array.isArray(response.result.tools)) {
        return response.result.tools;
      }

      return [];
    } catch (err) {
      logger.error(`[MCP] 도구 목록 조회 실패: ${this.id}`, {
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * 도구 실행 (MCP protocol: tools/call).
   *
   * @param {string} toolName - 도구명
   * @param {object} input - 입력값
   * @returns {Promise<object>} 도구 실행 결과
   */
  async callTool(toolName, input) {
    if (!this.isConnected) {
      throw new Error(`연결되지 않은 서버: ${this.id}`);
    }

    try {
      const response = await this.transportInstance.send({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: input,
        },
      });

      // MCP 응답 형식: { result: { content: [...] } }
      if (response.result) {
        return response.result;
      }

      return response;
    } catch (err) {
      logger.error(`[MCP] 도구 호출 실패: ${toolName}@${this.id}`, {
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * 연결 종료.
   */
  close() {
    if (this.transportInstance) {
      this.transportInstance.close();
      this.transportInstance = null;
    }
    this.isConnected = false;
    logger.info(`[MCP] 서버 연결 종료: ${this.id}`);
  }
}

/**
 * MCP Client — 모든 MCP 서버를 관리하고 도구를 Effy에 노출.
 *
 * @class MCPClient
 */
class MCPClient {
  constructor() {
    this.connections = new Map(); // serverId → MCPServerConnection
    this.registry = new MCPToolRegistry();
    this.isInitialized = false;
  }

  /**
   * 설정 로드 및 모든 MCP 서버 초기화.
   * 에러가 발생해도 계속 진행 (graceful degradation).
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    const mcpConfig = config.mcp || {};

    // MCP 설정이 없으면 조용히 종료
    if (!mcpConfig.servers || mcpConfig.servers.length === 0) {
      logger.info('[MCP] MCP 서버 설정 없음 (비활성화)');
      this.isInitialized = true;
      return;
    }

    logger.info('[MCP] 초기화 시작', {
      serverCount: mcpConfig.servers.length,
    });

    const timeout = mcpConfig.timeout || 30000;

    // 각 서버에 대해 연결 시도 (병렬)
    const promises = mcpConfig.servers.map(async (serverConfig) => {
      const serverConfig_ = {
        ...serverConfig,
        timeout,
      };

      try {
        const connection = new MCPServerConnection(serverConfig_);
        await connection.connect();

        // 도구 발견
        const tools = await connection.listTools();
        logger.info(`[MCP] 도구 발견: ${connection.id}`, {
          toolCount: tools.length,
        });

        // Registry에 등록
        this.registry.registerServer(connection.id, connection, tools);
        this.connections.set(connection.id, connection);
      } catch (err) {
        // 에러 로깅하되 다른 서버는 계속 처리
        logger.warn(`[MCP] 서버 초기화 실패 (계속): ${serverConfig.id}`, {
          error: err.message,
        });
      }
    });

    await Promise.all(promises);

    this.isInitialized = true;

    const totalTools = Object.keys(this.registry.getAllTools()).length;
    logger.info('[MCP] 초기화 완료', {
      connectedServers: this.connections.size,
      totalTools,
    });
  }

  /**
   * 모든 MCP 도구를 Effy의 TOOL_DEFINITIONS 포맷으로 반환.
   *
   * @returns {object} { toolName: toolDef, ... }
   */
  getToolDefinitions() {
    return this.registry.getAllTools();
  }

  /**
   * 특정 도구명이 MCP에 존재하는지 확인.
   *
   * @param {string} toolName
   * @returns {boolean}
   */
  hasTool(toolName) {
    return this.registry.getTool(toolName) !== null;
  }

  /**
   * MCP 도구 호출 (Registry를 통해 라우팅).
   *
   * @param {string} toolName
   * @param {object} input
   * @returns {Promise<object>} 실행 결과
   */
  async callTool(toolName, input) {
    if (!this.isInitialized) {
      throw new Error('MCP Client 초기화되지 않음');
    }

    return this.registry.callTool(toolName, input);
  }

  /**
   * 모든 MCP 서버 정보 조회 (디버깅용).
   *
   * @returns {array} 서버 정보 배열
   */
  getServerInfo() {
    return this.registry.listServers();
  }

  /**
   * 모든 연결 종료 및 정리.
   */
  async shutdown() {
    logger.info('[MCP] 종료 시작');

    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch (err) {
        logger.error('[MCP] 연결 종료 실패', { error: err.message });
      }
    }

    this.connections.clear();
    this.registry.clear();
    this.isInitialized = false;

    logger.info('[MCP] 종료 완료');
  }
}

// 싱글톤 인스턴스
let mcpClient = null;

/**
 * MCP Client 싱글톤 인스턴스 획득.
 *
 * @returns {MCPClient}
 */
function getMCPClient() {
  if (!mcpClient) {
    mcpClient = new MCPClient();
  }
  return mcpClient;
}

/**
 * Effy에 MCP 도구를 등록하기 위한 함수.
 *
 * tool-registry.js 패턴에 맞추어 호출되는 함수.
 * MCP에서 등록된 모든 도구를 반환.
 *
 * @returns {object} { toolName: toolDef, ... }
 */
function getMCPToolDefinitions() {
  if (!mcpClient || !mcpClient.isInitialized) {
    return {};
  }
  return mcpClient.getToolDefinitions();
}

module.exports = {
  MCPClient,
  MCPServerConnection,
  getMCPClient,
  getMCPToolDefinitions,
};
