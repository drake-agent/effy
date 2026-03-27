/**
 * transport.js — MCP 프로토콜 전송 레이어 (HTTP+SSE, StdIO).
 *
 * HTTP+SSE: 장폴링 기반 요청-응답 모델 (웹 브라우저, 로드밸런서 우호)
 * StdIO: 자식 프로세스 stdin/stdout 기반 (로컬 실행, 낮은 지연)
 *
 * 공통 인터페이스:
 *   - send(message): 메시지 전송
 *   - onMessage(callback): 수신 메시지 리스너
 *   - close(): 연결 종료
 */

const http = require('http');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

/**
 * HTTP+SSE 기반 MCP 트랜스포트.
 *
 * @class HTTPSSETransport
 * @extends EventEmitter
 */
class HTTPSSETransport extends EventEmitter {
  /**
   * @param {string} url - SSE 엔드포인트 URL (예: http://localhost:3001/sse)
   * @param {object} options - 옵션
   * @param {number} options.timeout - 요청 타임아웃 (기본 30000ms)
   * @param {object} options.logger - 로거 인스턴스
   */
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.timeout = options.timeout || 30000;
    this.logger = options.logger || console;
    this.messageId = 0;
    this.pendingRequests = new Map(); // messageId → { resolve, reject, timeout }
    this.sseConnection = null;
    this.isConnected = false;
  }

  /**
   * SSE 연결 수립 및 메시지 스트림 구독.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        // SSE 연결 (단방향 수신)
        const req = http.get(this.url, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`SSE 연결 실패: ${res.statusCode}`));
          }

          this.sseConnection = res;
          this.isConnected = true;
          this.logger.info(`[MCP] HTTP+SSE 연결 수립: ${this.url}`);

          let buffer = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 마지막 불완전한 줄 보관

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const data = JSON.parse(line.substring(5).trim());
                  this._handleSSEMessage(data);
                } catch (err) {
                  this.logger.error('[MCP] SSE 메시지 파싱 실패', { error: err.message });
                }
              }
            }
          });

          res.on('end', () => {
            this.isConnected = false;
            this.logger.warn('[MCP] SSE 연결 종료');
            this.emit('close');
          });

          res.on('error', (err) => {
            this.isConnected = false;
            this.logger.error('[MCP] SSE 오류', { error: err.message });
            this.emit('error', err);
          });

          resolve();
        });

        req.on('error', reject);
        req.setTimeout(this.timeout, () => {
          req.destroy();
          reject(new Error('SSE 연결 타임아웃'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * SSE를 통해 수신한 메시지 처리.
   * 응답(messageId 포함)이면 pending request 반환, 그 외 emit.
   *
   * @private
   */
  _handleSSEMessage(message) {
    const { id, ...data } = message;

    // Pending request 응답 확인
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id);
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(data);
    } else {
      // 서버 주도 메시지 (notification)
      this.emit('message', message);
    }
  }

  /**
   * HTTP POST로 메시지 전송 (요청-응답).
   *
   * @param {object} message - 전송할 메시지
   * @returns {Promise<object>} 응답
   */
  async send(message) {
    if (!this.isConnected) {
      throw new Error('MCP 연결이 수립되지 않음');
    }

    const messageId = ++this.messageId;
    const payload = JSON.stringify({ ...message, id: messageId });

    return new Promise((resolve, reject) => {
      // Pending request 등록 (타임아웃 설정)
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`메시지 타임아웃: ${this.timeout}ms`));
      }, this.timeout);

      this.pendingRequests.set(messageId, { resolve, reject, timeout: timeoutHandle });

      // HTTP POST로 전송
      const postUrl = new URL(this.url);
      const options = {
        hostname: postUrl.hostname,
        port: postUrl.port || 80,
        path: postUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const postReq = http.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP 오류: ${res.statusCode}`));
        }
        // 응답은 SSE로 수신하므로 여기서는 무시
      });

      postReq.on('error', reject);
      postReq.setTimeout(this.timeout, () => {
        postReq.destroy();
        reject(new Error('HTTP POST 타임아웃'));
      });

      postReq.write(payload);
      postReq.end();
    });
  }

  /**
   * 연결 종료.
   */
  close() {
    if (this.sseConnection) {
      this.sseConnection.destroy();
      this.sseConnection = null;
    }
    this.isConnected = false;
    // Pending requests 모두 실패 처리
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('연결 종료'));
    }
    this.pendingRequests.clear();
  }
}

/**
 * StdIO 기반 MCP 트랜스포트 (자식 프로세스).
 *
 * @class StdIOTransport
 * @extends EventEmitter
 */
class StdIOTransport extends EventEmitter {
  /**
   * @param {string} command - 실행할 명령어 (예: npx)
   * @param {string[]} args - 명령어 인자 배열
   * @param {object} options - 옵션
   * @param {string} options.cwd - 작업 디렉터리
   * @param {number} options.timeout - 요청 타임아웃 (기본 30000ms)
   * @param {object} options.logger - 로거 인스턴스
   */
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = options.cwd;
    this.timeout = options.timeout || 30000;
    this.logger = options.logger || console;
    this.process = null;
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.isConnected = false;
    this.buffer = '';
  }

  /**
   * 자식 프로세스 실행 및 stdio 설정.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
        });

        this.process.on('error', (err) => {
          this.isConnected = false;
          this.logger.error('[MCP] StdIO 프로세스 오류', { error: err.message });
          this.emit('error', err);
          if (!this.isConnected) {
            reject(err);
          }
        });

        this.process.on('exit', (code, signal) => {
          this.isConnected = false;
          this.logger.warn('[MCP] StdIO 프로세스 종료', { code, signal });
          this.emit('close');
        });

        // stdout 읽기 (JSONL 형식)
        this.process.stdout.on('data', (chunk) => {
          this.buffer += chunk.toString();
          this._processLines();
        });

        // stderr 로깅
        this.process.stderr.on('data', (chunk) => {
          this.logger.error('[MCP] StdIO stderr', { data: chunk.toString() });
        });

        this.isConnected = true;
        this.logger.info('[MCP] StdIO 프로세스 연결', {
          command: this.command,
          args: this.args.join(' '),
        });
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * stdout 버퍼에서 JSONL 라인 추출 및 처리.
   *
   * @private
   */
  _processLines() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // 마지막 불완전한 줄 보관

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this._handleMessage(message);
        } catch (err) {
          this.logger.error('[MCP] 메시지 파싱 실패', { error: err.message, line });
        }
      }
    }
  }

  /**
   * 수신 메시지 처리.
   *
   * @private
   */
  _handleMessage(message) {
    const { id, ...data } = message;

    // Pending request 응답 확인
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id);
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(data);
    } else {
      // 서버 주도 메시지
      this.emit('message', message);
    }
  }

  /**
   * stdin을 통해 메시지 전송 (JSONL 형식).
   *
   * @param {object} message - 전송할 메시지
   * @returns {Promise<object>} 응답
   */
  async send(message) {
    if (!this.isConnected || !this.process) {
      throw new Error('StdIO 연결이 수립되지 않음');
    }

    const messageId = ++this.messageId;
    const payload = JSON.stringify({ ...message, id: messageId }) + '\n';

    return new Promise((resolve, reject) => {
      // Pending request 등록
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`메시지 타임아웃: ${this.timeout}ms`));
      }, this.timeout);

      this.pendingRequests.set(messageId, { resolve, reject, timeout: timeoutHandle });

      // stdin으로 전송
      this.process.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(messageId);
          reject(err);
        }
      });
    });
  }

  /**
   * 프로세스 종료.
   */
  close() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.isConnected = false;
    // Pending requests 모두 실패 처리
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('연결 종료'));
    }
    this.pendingRequests.clear();
  }
}

module.exports = {
  HTTPSSETransport,
  StdIOTransport,
};
