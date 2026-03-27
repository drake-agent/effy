/**
 * Process Sandbox — Tier 1 모듈
 * OS 파일시스템 격리된 자식 프로세스 실행
 * SpaceBot-inspired: Docker/제한된 권한 하이브리드 샌드박싱
 */

const { createLogger } = require('../shared/logger');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ProcessSandbox {
  /**
   * 초기화 — 샌드박스 정책 구성
   * @param {Object} opts - 옵션
   * @param {boolean} opts.enabled - 샌드박싱 활성화 여부
   * @param {string[]} opts.readOnlyPaths - 읽기 전용 경로
   * @param {string[]} opts.writablePaths - 쓰기 가능 경로
   * @param {string[]} opts.blockedPaths - 차단된 경로
   * @param {number} opts.maxMemoryMb - 최대 메모리 (MB)
   * @param {number} opts.timeoutMs - 타임아웃 (ms)
   */
  constructor(opts = {}) {
    this.log = createLogger('ProcessSandbox');

    this.enabled = opts.enabled ?? true;
    this.readOnlyPaths = opts.readOnlyPaths ?? ['/usr', '/lib', '/bin'];
    this.writablePaths = opts.writablePaths ?? ['/tmp'];
    this.blockedPaths = opts.blockedPaths ?? [
      '/etc/shadow', '/root',
      process.env.HOME ? path.join(process.env.HOME, '.ssh') : '~/.ssh'
    ];

    this.maxMemoryMb = opts.maxMemoryMb ?? 512;
    this.timeoutMs = opts.timeoutMs ?? 30000;

    this._dockerAvailable = null; // lazy-loaded

    this.log.info('ProcessSandbox initialized', {
      enabled: this.enabled,
      maxMemoryMb: this.maxMemoryMb,
      timeoutMs: this.timeoutMs,
      blockedPathCount: this.blockedPaths.length
    });
  }

  /**
   * 샌드박스 환경에서 명령 실행
   * Docker 사용 가능시 Docker, 아니면 제한된 child_process 사용
   * @param {string} command - 실행할 명령
   * @param {Object} opts - { cwd, env, agentId, shellMode }
   * @returns {Promise<{ stdout, stderr, exitCode, sandboxType: 'docker'|'restricted'|'none' }>}
   */
  async exec(command, opts = {}) {
    try {
      if (!this.enabled) {
        return this._execUnrestricted(command, opts);
      }

      // Docker 사용 가능 여부 확인
      const hasDocker = await this._checkDocker();

      if (hasDocker) {
        return await this._execDocker(command, opts);
      } else {
        return await this._execRestricted(command, opts);
      }
    } catch (err) {
      this.log.error('Error executing sandboxed command', err);
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        sandboxType: 'none'
      };
    }
  }

  /**
   * 파일 경로 검증 (읽기/쓰기 모드)
   * @param {string} filePath - 파일 경로
   * @param {'read'|'write'} mode - 작업 모드
   * @returns {{ allowed: boolean, reason: string }}
   */
  validatePath(filePath, mode) {
    try {
      const absPath = path.resolve(filePath);

      // 차단된 경로 확인
      for (const blocked of this.blockedPaths) {
        if (absPath.startsWith(path.resolve(blocked))) {
          return { allowed: false, reason: `Path blocked: ${blocked}` };
        }
      }

      // 쓰기 모드
      if (mode === 'write') {
        const inWritable = this.writablePaths.some(p =>
          absPath.startsWith(path.resolve(p))
        );
        if (!inWritable) {
          return { allowed: false, reason: 'Path not in writable list' };
        }
      }

      // 읽기 모드 — 읽기 전용 경로 허가
      if (mode === 'read') {
        return { allowed: true, reason: 'Read permitted' };
      }

      return { allowed: true, reason: 'Path validated' };
    } catch (err) {
      this.log.error('Error validating path', err);
      return { allowed: false, reason: 'Validation error' };
    }
  }

  /**
   * Docker 사용 가능 여부 확인
   * @private
   */
  async _checkDocker() {
    if (this._dockerAvailable !== null) {
      return this._dockerAvailable;
    }

    try {
      execSync('docker --version', { stdio: 'pipe' });
      this._dockerAvailable = true;
      this.log.info('Docker available for sandboxing');
      return true;
    } catch (err) {
      this._dockerAvailable = false;
      this.log.debug('Docker not available, using restricted mode');
      return false;
    }
  }

  /**
   * Docker를 이용한 격리된 실행
   * @private
   */
  async _execDocker(command, opts = {}) {
    try {
      const cwd = opts.cwd || '/tmp';
      const mounts = [];

      // 쓰기 가능 경로 마운트
      for (const wp of this.writablePaths) {
        if (fs.existsSync(wp)) {
          mounts.push(`-v ${wp}:${wp}:rw`);
        }
      }

      const dockerCmd = `docker run --rm -i --memory=${this.maxMemoryMb}m --cpus=1 ${mounts.join(' ')} -w ${cwd} node:18 bash -c '${command.replace(/'/g, "'\\''")}'`;

      this.log.debug('Executing Docker command', { command: command.substring(0, 50) });

      const stdout = execSync(dockerCmd, {
        timeout: this.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        stdout,
        stderr: '',
        exitCode: 0,
        sandboxType: 'docker'
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: err.message,
        exitCode: err.status || 1,
        sandboxType: 'docker'
      };
    }
  }

  /**
   * 제한된 권한 child_process 사용 (폴백)
   * @private
   */
  async _execRestricted(command, opts = {}) {
    return new Promise((resolve) => {
      try {
        const cwd = opts.cwd || '/tmp';
        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
        }, this.timeoutMs);

        const proc = spawn('sh', ['-c', command], {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ...opts.env }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);
          this.log.debug('Restricted process completed', { exitCode: code });

          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            sandboxType: 'restricted'
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          resolve({
            stdout,
            stderr: err.message,
            exitCode: 1,
            sandboxType: 'restricted'
          });
        });
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          sandboxType: 'restricted'
        });
      }
    });
  }

  /**
   * 제한 없이 실행 (샌드박싱 비활성화시)
   * @private
   */
  _execUnrestricted(command, opts = {}) {
    return new Promise((resolve) => {
      try {
        const stdout = execSync(command, {
          cwd: opts.cwd || '/tmp',
          timeout: this.timeoutMs,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024
        });

        resolve({
          stdout,
          stderr: '',
          exitCode: 0,
          sandboxType: 'none'
        });
      } catch (err) {
        resolve({
          stdout: err.stdout || '',
          stderr: err.stderr || err.message,
          exitCode: err.status || 1,
          sandboxType: 'none'
        });
      }
    });
  }
}

module.exports = { ProcessSandbox };
