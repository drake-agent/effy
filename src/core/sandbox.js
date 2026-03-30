/**
 * sandbox.js — OS-Level 코드 실행 격리.
 * OS-Level Kernel Isolation.
 * bubblewrap(Linux) / sandbox-exec(macOS) 커널 격리.
 * Fallback: vm2 JavaScript 격리 (기존).
 */

const { createLogger } = require('../shared/logger');
const { execSync, spawn } = require('child_process');
const { config } = require('../config');
const path = require('path');
const fs = require('fs');
const os = require('os');

const log = createLogger('core:sandbox');

/**
 * 위험 환경변수 블랙리스트 — 코드 인젝션/권한 상승 가능
 * Dangerous env vars that can enable code injection or privilege escalation
 * @type {Set<string>}
 */
const DANGEROUS_ENV_VARS = new Set([
  // Node.js 인젝션 벡터
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_REDIRECT_WARNINGS',
  'NODE_REPL_HISTORY',
  // 동적 링커 인젝션 (Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_PROFILE',
  'LD_BIND_NOW',
  // macOS dylib 인젝션
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  // Python 인젝션 벡터
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  // Ruby/Perl 인젝션
  'RUBYLIB',
  'RUBYOPT',
  'PERL5LIB',
  'PERL5OPT',
  // 셸/프로세스 위험 변수
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'GLOBIGNORE',
  'IFS',
  // 커널/보안
  'LD_USE_LOAD_BIAS',
  'HOSTALIASES',
  'LOCALDOMAIN',
  'RES_OPTIONS',
  // Git hook 인젝션
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
]);

/**
 * @typedef {Object} SandboxConfig
 * @property {'kernel'|'vm2'|'none'} mode - 샌드박스 모드
 * @property {string[]} [writablePaths] - 쓰기 가능 경로
 * @property {string[]} [passthroughEnv] - 전달할 환경변수명
 * @property {string[]} [projectPaths] - 프로젝트 경로 (자동 allowlist)
 * @property {number} [timeoutMs=30000] - 타임아웃 (ms)
 * @property {number} [memoryLimitMb=512] - 메모리 제한 (MB)
 */

class OSSandbox {
  /**
   * OS-Level 샌드박스 초기화.
   * @param {SandboxConfig} [opts={}]
   */
  constructor(opts = {}) {
    this.mode = opts.mode || 'kernel';
    this.writablePaths = opts.writablePaths || ['/tmp', path.join(os.homedir(), '.effy', 'sandbox')];
    this.passthroughEnv = opts.passthroughEnv || ['PATH', 'HOME', 'USER', 'LANG'];
    this.projectPaths = opts.projectPaths || [];
    this.timeoutMs = opts.timeoutMs || 30000;
    this.memoryLimitMb = opts.memoryLimitMb || 512;
    this.secretManager = opts.secretManager || null;

    this._backend = null; // 'bwrap' | 'sandbox-exec' | 'vm2' | 'restricted'
    this._vm2 = null;

    this._detectBackendSync();
    log.info('OSSandbox initialized', {
      mode: this.mode,
      backend: this._backend,
      timeoutMs: this.timeoutMs,
      memoryLimitMb: this.memoryLimitMb
    });
  }

  /**
   * 사용 가능한 샌드박스 백엔드 자동 감지.
   * 우선순위: bwrap (Linux) > sandbox-exec (macOS) > vm2 > restricted
   * @private
   */
  _detectBackendSync() {
    if (this.mode === 'none') {
      this._backend = 'none';
      return;
    }

    const platform = os.platform();

    // Linux: bubblewrap 확인
    if (platform === 'linux') {
      try {
        execSync('which bwrap', { stdio: 'pipe' });
        this._backend = 'bwrap';
        log.info('Backend detected: bubblewrap (Linux kernel isolation)');
        return;
      } catch {}
    }

    // macOS: sandbox-exec 확인
    if (platform === 'darwin') {
      try {
        execSync('which sandbox-exec', { stdio: 'pipe' });
        this._backend = 'sandbox-exec';
        log.info('Backend detected: sandbox-exec (macOS sandbox)');
        return;
      } catch {}
    }

    // vm2 모드 시도
    if (this.mode === 'vm2') {
      try {
        this._vm2 = require('vm2');
        this._backend = 'vm2';
        log.info('Backend detected: vm2 (JavaScript isolation)');
        return;
      } catch {
        log.warn('vm2 not installed, falling back to restricted');
      }
    }

    // 폴백: restricted (child_process 제한)
    // v3.9 fix: CRITICAL WARNING — restricted backend offers NO real isolation.
    // Any caller expecting sandbox isolation gets plain sh -c instead.
    this._backend = 'restricted';
    log.warn('SECURITY: No sandbox backend available! Running in restricted mode (NO kernel isolation). ' +
      'Install bubblewrap (Linux) or use macOS for sandbox-exec. ' +
      'Commands will execute with full host permissions.');
  }

  /**
   * 셸 명령을 샌드박스 환경에서 실행.
   * @param {string} command - 실행할 셸 명령
   * @param {Object} [opts={}]
   * @param {string} [opts.cwd] - 작업 디렉토리
   * @param {Object} [opts.env] - 추가 환경변수
   * @param {string} [opts.projectRoot] - 프로젝트 루트 (allowlist 자동 갱신)
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, backend: string }>}
   */
  async executeInSandbox(command, opts = {}) {
    const cwd = opts.cwd || '/tmp';

    // v3.9 fix: Refuse execution when kernel isolation was requested but unavailable.
    // This prevents silent downgrade to unrestricted sh -c execution.
    if (this.mode === 'kernel' && this._backend === 'restricted') {
      log.error('Kernel sandbox requested but no backend available — refusing execution');
      return {
        stdout: '',
        stderr: 'Sandbox backend unavailable: kernel isolation was requested but no sandbox runtime (bwrap/sandbox-exec) is installed. Refusing to execute without isolation.',
        exitCode: 126,
        backend: 'none',
      };
    }

    try {
      if (this._backend === 'bwrap') {
        return await this._executeBwrap(command, cwd, opts);
      } else if (this._backend === 'sandbox-exec') {
        return await this._executeSandboxExec(command, cwd, opts);
      } else if (this._backend === 'vm2') {
        // vm2는 JavaScript 전용이므로 여기서는 지원하지 않음
        return await this._executeRestricted(command, cwd, opts);
      } else if (this._backend === 'none') {
        return { stdout: '', stderr: 'Sandbox disabled (mode=none)', exitCode: 0, backend: 'none' };
      } else {
        // restricted 폴백 — mode가 'kernel'이 아닐 때만 도달
        log.warn('Executing in restricted mode (no kernel isolation)');
        return await this._executeRestricted(command, cwd, opts);
      }
    } catch (err) {
      log.error('Error executing sandboxed command', { error: err.message });
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        backend: this._backend
      };
    }
  }

  /**
   * JavaScript 코드를 VM2 또는 제한된 환경에서 실행.
   * @param {string} code - 실행할 JavaScript 코드
   * @param {Object} [context={}] - 실행 컨텍스트
   * @param {Object} [opts={}]
   * @param {number} [opts.timeoutMs] - 타임아웃 (ms)
   * @param {string} [opts.agentId] - Agent ID for secret access tracking
   * @returns {Promise<*>} 실행 결과
   */
  async runInVM(code, context = {}, opts = {}) {
    const timeout = opts.timeoutMs || this.timeoutMs;

    if (this._vm2) {
      try {
        const { VM } = this._vm2;

        // Create execution context with optional getSecret function
        const vmContext = { ...context };

        // Inject getSecret function if secretManager is available
        if (this.secretManager && opts.agentId) {
          vmContext.getSecret = this.secretManager.createSecretGetter(opts.agentId);
        }

        const vm = new VM({
          timeout,
          sandbox: vmContext
        });
        return vm.run(code);
      } catch (err) {
        log.error('VM2 execution error', { error: err.message });
        throw err;
      }
    }

    log.warn('vm2 not available, returning null');
    return null;
  }

  /**
   * 프로젝트 경로를 샌드박스 allowlist에 추가.
   * @param {string[]} projectRoots - 프로젝트 루트 경로 배열
   */
  refreshProjectPaths(projectRoots = []) {
    this.projectPaths = projectRoots.filter(p => fs.existsSync(p));
    log.debug('Project paths updated', { count: this.projectPaths.length });
  }

  /**
   * bubblewrap 인자 생성.
   * @param {string} command - 실행 명령
   * @param {SandboxConfig} config - 샌드박스 설정
   * @returns {string[]} bwrap 인자 배열
   * @private
   */
  _buildBwrapArgs(command, config = {}) {
    const args = [
      // 새로운 UTS 네임스페이스 (호스트명 격리)
      '--bind', '/', '/',
      // 루트 파일시스템 읽기 전용으로 바인드
      '--ro-bind', '/', '/',
      // 쓰기 가능 경로를 쓰기 가능으로 바인드
      ...this._buildBwrapBinds(config.writablePaths || this.writablePaths),
      // PID 네임스페이스 (프로세스 격리)
      '--new-pid',
      // 네트워크는 호스트와 공유 (필요시 --unshare-net 추가)
      // 메모리 제한은 cgroup으로 구현 (여기서는 생략)
      '--setenv', 'SANDBOXED', 'true'
    ];

    return ['bwrap', ...args, '/bin/sh', '-c', command];
  }

  /**
   * bwrap 바인드 마운트 인자 생성.
   * @param {string[]} writablePaths
   * @returns {string[]}
   * @private
   */
  _buildBwrapBinds(writablePaths = []) {
    const binds = [];
    for (const wp of writablePaths) {
      if (fs.existsSync(wp)) {
        binds.push('--bind', wp, wp);
      }
    }
    // 프로젝트 경로도 추가
    for (const pp of this.projectPaths) {
      if (fs.existsSync(pp) && !writablePaths.includes(pp)) {
        binds.push('--ro-bind', pp, pp);
      }
    }
    return binds;
  }

  /**
   * macOS sandbox 프로필 문자열 생성.
   * @param {SandboxConfig} config
   * @returns {string} SBPL 프로필
   * @private
   */
  _buildSbplProfile(config = {}) {
    const writablePaths = config.writablePaths || this.writablePaths;
    const readOnlyPaths = ['/usr', '/lib', '/bin', '/System', '/Library'];

    // v3.9 fix: Deny-default sandbox profile. Previous allow-default profile
    // only denied file-write and network, leaving full read-side access to the
    // entire filesystem — a complete read-side sandbox bypass on Darwin.
    let profile = '(version 1)\n';
    profile += '(deny default)\n'; // deny everything by default
    profile += '(allow process-exec)\n'; // allow executing processes
    profile += '(allow process-fork)\n'; // allow fork
    profile += '(allow signal)\n'; // allow signals
    profile += '(allow sysctl-read)\n'; // allow sysctl reads
    profile += '(allow mach-lookup)\n'; // allow mach IPC (needed for basic operations)

    // Explicitly allow read-only paths
    for (const rp of readOnlyPaths) {
      profile += `(allow file-read* (subpath "${rp}"))\n`;
    }

    // 쓰기 가능 경로 허용 — SEC-2 fix: use subpath literal instead of regex interpolation
    for (const wp of writablePaths) {
      if (fs.existsSync(wp)) {
        const safePath = OSSandbox._sanitizeSbplPath(wp);
        profile += `(allow file-write* (subpath "${safePath}"))\n`;
        profile += `(allow file-read* (subpath "${safePath}"))\n`;
      }
    }

    // 프로젝트 경로 허용 — SEC-2 fix: use subpath literal instead of regex interpolation
    for (const pp of this.projectPaths) {
      if (fs.existsSync(pp)) {
        const safePath = OSSandbox._sanitizeSbplPath(pp);
        profile += `(allow file-read* (subpath "${safePath}"))\n`;
      }
    }

    // 임시 파일 접근 — use subpath for tmpdir
    const safeTmpDir = OSSandbox._sanitizeSbplPath(os.tmpdir());
    profile += `(allow file-write* (subpath "${safeTmpDir}"))\n`;
    profile += `(allow file-read* (subpath "${safeTmpDir}"))\n`;

    return profile;
  }

  /**
   * bubblewrap를 사용한 명령 실행.
   * @private
   */
  async _executeBwrap(command, cwd, opts = {}) {
    return new Promise((resolve) => {
      try {
        const args = this._buildBwrapArgs(command, this);

        log.debug('Executing with bwrap', { cmdLen: command.length });

        const proc = spawn(args[0], args.slice(1), {
          cwd,
          timeout: this.timeoutMs,
          env: this._buildEnv(opts.env)
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
        }, this.timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            backend: 'bwrap'
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 1,
            backend: 'bwrap'
          });
        });
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          backend: 'bwrap'
        });
      }
    });
  }

  /**
   * macOS sandbox-exec를 사용한 명령 실행.
   * @private
   */
  async _executeSandboxExec(command, cwd, opts = {}) {
    return new Promise((resolve) => {
      try {
        const profile = this._buildSbplProfile(this);
        const profileFile = path.join(os.tmpdir(), `sbpl_${Date.now()}.sbpl`);

        fs.writeFileSync(profileFile, profile);

        log.debug('Executing with sandbox-exec', { cmdLen: command.length });

        const proc = spawn('sandbox-exec', ['-f', profileFile, '/bin/sh', '-c', command], {
          cwd,
          timeout: this.timeoutMs,
          env: this._buildEnv(opts.env)
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
        }, this.timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          try { fs.unlinkSync(profileFile); } catch {}
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            backend: 'sandbox-exec'
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          try { fs.unlinkSync(profileFile); } catch {}
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 1,
            backend: 'sandbox-exec'
          });
        });
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          backend: 'sandbox-exec'
        });
      }
    });
  }

  /**
   * 제한된 프로세스 격리로 명령 실행 (폴백).
   * @private
   */
  async _executeRestricted(command, cwd, opts = {}) {
    return new Promise((resolve) => {
      try {
        const proc = spawn('sh', ['-c', command], {
          cwd,
          timeout: this.timeoutMs,
          env: this._buildEnv(opts.env)
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
        }, this.timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            backend: 'restricted'
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 1,
            backend: 'restricted'
          });
        });
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          backend: 'restricted'
        });
      }
    });
  }

  /**
   * 환경변수 구성 (passthrough + 추가).
   * @private
   */
  _buildEnv(additionalEnv = {}) {
    const env = {};
    const blocked = [];

    for (const key of this.passthroughEnv) {
      if (DANGEROUS_ENV_VARS.has(key)) {
        blocked.push(key);
        continue;
      }
      if (key in process.env) {
        env[key] = process.env[key];
      }
    }

    // 추가 환경변수에서도 위험 변수 필터링
    for (const [key, val] of Object.entries(additionalEnv)) {
      if (DANGEROUS_ENV_VARS.has(key)) {
        blocked.push(key);
        continue;
      }
      env[key] = val;
    }

    if (blocked.length > 0) {
      log.warn('Sandbox: blocked dangerous env vars', { blocked });
    }

    return env;
  }

  /**
   * 환경변수 안전성 검증 (외부 호출용).
   * Validate environment variables against the dangerous blocklist.
   *
   * @param {Object} envMap - 검증할 환경변수 맵
   * @returns {{ safe: boolean, blocked: string[] }}
   */
  static validateEnv(envMap = {}) {
    const blocked = Object.keys(envMap).filter((k) => DANGEROUS_ENV_VARS.has(k));
    return { safe: blocked.length === 0, blocked };
  }

  /**
   * SEC-2 fix: Sanitize a path for safe use in SBPL profile strings.
   * Rejects paths containing characters that could break SBPL syntax.
   * @param {string} p - File path
   * @returns {string} Sanitized path (or throws on invalid)
   * @static
   */
  static _sanitizeSbplPath(p) {
    // Resolve to absolute canonical path
    const resolved = path.resolve(p);
    // Reject any path containing SBPL-breaking characters: ", ), newline, null byte
    if (/["\)\n\r\0]/.test(resolved)) {
      throw new Error(`Unsafe SBPL path rejected: contains special characters`);
    }
    return resolved;
  }

  /**
   * 현재 샌드박스 상태 정보.
   * @returns {Object}
   */
  getStatus() {
    return {
      mode: this.mode,
      backend: this._backend,
      timeoutMs: this.timeoutMs,
      memoryLimitMb: this.memoryLimitMb,
      writablePaths: this.writablePaths,
      projectPaths: this.projectPaths
    };
  }
}

module.exports = { OSSandbox, DANGEROUS_ENV_VARS };
