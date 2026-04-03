/**
 * ssrf-guard.js — HTTP 도구의 SSRF 보호
 * SSRF Protection for HTTP Tools
 *
 * 클라우드 메타데이터, 프라이빗 IP, 루프백, 링크-로컬 주소로의 요청 차단.
 */

const { createLogger } = require('../shared/logger');
const dns = require('dns');
const { promisify } = require('util');

const log = createLogger('tools/ssrf-guard');
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/**
 * SSRF 보호 및 검증 클래스
 * SSRFGuard — URL 및 IP 검증
 */
class SSRFGuard {
  /**
   * @param {Object} [opts]
   * @param {string[]} [opts.blockedCIDRs] - 차단 CIDR 범위
   * @param {string[]} [opts.blockedHosts] - 차단 호스트명
   * @param {string[]} [opts.allowedProtocols] - 허용 프로토콜
   */
  constructor(opts = {}) {
    this.blockedCIDRs = opts.blockedCIDRs ?? [
      '127.0.0.0/8',        // loopback
      '10.0.0.0/8',         // private class A
      '172.16.0.0/12',      // private class B
      '192.168.0.0/16',     // private class C
      '169.254.0.0/16',     // link-local / AWS metadata
      '0.0.0.0/8',          // current network
      '100.64.0.0/10',      // shared address space (CGN)
    ];

    this.blockedIPv6CIDRs = opts.blockedIPv6CIDRs ?? [
      'fc00::/7',           // IPv6 private
      '::1/128',            // IPv6 loopback
      'fe80::/10',          // IPv6 link-local
    ];

    this.blockedHosts = opts.blockedHosts ?? [
      'metadata.google.internal',
      'metadata.google.com',
      '169.254.169.254',    // AWS/GCP metadata
      '169.254.170.2',      // ECS metadata
    ];

    this.allowedProtocols = opts.allowedProtocols ?? ['http:', 'https:'];
  }

  /**
   * HTTP 요청 전에 URL 검증 (synchronous, URL-only checks).
   *
   * WARNING: This method only performs synchronous URL/IP pattern checks.
   * It does NOT resolve DNS, so it cannot detect DNS rebinding or TOCTOU attacks
   * where a hostname resolves to a private/blocked IP at request time.
   * Callers MUST use resolveAndValidate() for full SSRF protection against
   * DNS-based attacks. This method alone is NOT sufficient for safe HTTP requests.
   *
   * @param {string} url
   * @returns {{ safe: boolean, reason: string, parsedUrl: URL|null }}
   */
  validate(url) {
    try {
      const parsedUrl = new URL(url);

      // 프로토콜 검증
      if (!this.allowedProtocols.includes(parsedUrl.protocol)) {
        return {
          safe: false,
          reason: `Protocol '${parsedUrl.protocol}' not allowed`,
          parsedUrl: null,
        };
      }

      // 호스트명 검증
      const hostname = parsedUrl.hostname;
      if (!hostname) {
        return { safe: false, reason: 'Missing hostname', parsedUrl: null };
      }

      // 차단된 호스트명 확인
      if (this.blockedHosts.some((h) => hostname.toLowerCase() === h.toLowerCase())) {
        return {
          safe: false,
          reason: `Blocked host: ${hostname}`,
          parsedUrl: null,
        };
      }

      // IPv4 검증 (간단한 패턴 체크)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        if (this.isBlockedIP(hostname)) {
          return {
            safe: false,
            reason: `IP in blocked CIDR: ${hostname}`,
            parsedUrl: null,
          };
        }
      }

      // IPv6 검증
      if (hostname.includes(':') && hostname.startsWith('[')) {
        const ipv6 = hostname.slice(1, -1);
        if (this._isBlockedIPv6(ipv6)) {
          return {
            safe: false,
            reason: `IPv6 in blocked CIDR: ${ipv6}`,
            parsedUrl: null,
          };
        }
      }

      log.debug('URL validated', { url: parsedUrl.toString() });
      return { safe: true, reason: '', parsedUrl };
    } catch (err) {
      return {
        safe: false,
        reason: `Invalid URL: ${err.message}`,
        parsedUrl: null,
      };
    }
  }

  /**
   * IP 주소가 차단 CIDR 범위에 있는지 확인
   * @param {string} ip
   * @returns {boolean}
   */
  isBlockedIP(ip) {
    return this.blockedCIDRs.some((cidr) => this._ipInCIDR(ip, cidr));
  }

  /**
   * 호스트명을 IP로 해석하고 검증
   * @param {string} hostname
   * @returns {Promise<{ safe: boolean, resolvedIp: string, reason: string }>}
   */
  async resolveAndValidate(hostname) {
    try {
      // 직접 IP인지 확인
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        if (this.isBlockedIP(hostname)) {
          return {
            safe: false,
            resolvedIp: hostname,
            reason: `IP in blocked CIDR: ${hostname}`,
          };
        }
        return { safe: true, resolvedIp: hostname, reason: '' };
      }

      // 차단된 호스트명 체크 (case-insensitive)
      const hostnameNorm = hostname.toLowerCase();
      if (this.blockedHosts.some(h => h.toLowerCase() === hostnameNorm)) {
        return {
          safe: false,
          resolvedIp: '',
          reason: `Blocked host: ${hostname}`,
        };
      }

      // DNS 해석 (타임아웃 설정)
      const resolvePromise = Promise.race([
        dnsResolve4(hostname),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
      ]);

      let ips = [];
      try {
        ips = await resolvePromise;
      } catch (dnsErr) {
        log.warn('DNS resolution failed', { hostname, error: dnsErr.message });
        return {
          safe: false,
          resolvedIp: '',
          reason: `DNS resolution failed: ${dnsErr.message}`,
        };
      }

      // Check ALL resolved IPs, not just the first (DNS rebinding defense)
      for (const ip of ips) {
        if (this.isBlockedIP(ip)) {
          return {
            safe: false,
            resolvedIp: ip,
            reason: `Resolved IP in blocked CIDR: ${ip}`,
          };
        }
        // Detect IPv4-mapped IPv6 addresses (::ffff:127.0.0.1)
        if (ip.startsWith('::ffff:')) {
          const mappedV4 = ip.slice(7);
          if (this.isBlockedIP(mappedV4)) {
            return {
              safe: false,
              resolvedIp: ip,
              reason: `IPv4-mapped IPv6 in blocked CIDR: ${ip}`,
            };
          }
        }
      }

      return { safe: true, resolvedIp: ips[0], reason: '' };
    } catch (err) {
      log.error('DNS resolution error', err);
      return {
        safe: false,
        resolvedIp: '',
        reason: `Resolution error: ${err.message}`,
      };
    }
  }

  /**
   * CIDR 매칭 유틸리티
   * @param {string} ip
   * @param {string} cidr
   * @returns {boolean}
   * @private
   */
  _ipInCIDR(ip, cidr) {
    try {
      const [network, bits] = cidr.split('/');
      const ipInt = this._ipToInt(ip);
      const netInt = this._ipToInt(network);
      const mask = -1 << (32 - parseInt(bits, 10));

      return (ipInt & mask) === (netInt & mask);
    } catch (e) {
      log.debug('CIDR matching failed', { error: e.message });
      return false;
    }
  }

  /**
   * IPv4를 정수로 변환
   * @param {string} ip
   * @returns {number}
   * @private
   */
  _ipToInt(ip) {
    // Handle hex notation (0x7f000001)
    if (/^0x[0-9a-fA-F]+$/.test(ip)) {
      return parseInt(ip, 16) >>> 0;
    }
    // Handle bare decimal notation (2130706433)
    if (/^\d+$/.test(ip) && !ip.includes('.')) {
      return parseInt(ip, 10) >>> 0;
    }
    const parts = ip.split('.');
    // Handle octal notation per-octet (0177.0.0.1)
    const parsed = parts.map(p => {
      if (p.startsWith('0') && p.length > 1 && !/[89]/.test(p)) {
        return parseInt(p, 8);
      }
      return parseInt(p, 10);
    });
    return (
      (parsed[0] << 24)
      + (parsed[1] << 16)
      + (parsed[2] << 8)
      + parsed[3]
    );
  }

  /**
   * IPv6이 차단 CIDR 범위에 있는지 확인
   * @param {string} ipv6
   * @returns {boolean}
   * @private
   */
  _isBlockedIPv6(ipv6) {
    try {
      const net = require('net');
      const normalized = ipv6.toLowerCase();

      // Verify it's actually IPv6
      if (!net.isIPv6(ipv6)) return false;

      // Blocked IPv6 ranges:
      // ::1 — loopback
      // fc00::/7 — unique local (fc and fd prefixes)
      // fe80::/10 — link-local
      // :: — unspecified
      // ff00::/8 — multicast
      if (
        normalized === '::1'
        || normalized === '::'
        || normalized.startsWith('fe80:')      // fe80::/10 link-local
        || normalized.startsWith('fc')          // fc00::/7 unique local
        || normalized.startsWith('fd')          // fc00::/7 unique local
        || normalized.startsWith('ff')          // ff00::/8 multicast
      ) {
        return true;
      }
      // ::ffff:0:0/96 — IPv4-mapped IPv6 addresses (defer to IPv4 check)
      if (normalized.startsWith('::ffff:')) {
        const mappedV4 = normalized.slice(7);
        return this.isBlockedIP(mappedV4);
      }
      return false;
    } catch (e) {
      log.debug('IPv6 check failed', { error: e.message });
      return false;
    }
  }
}

module.exports = { SSRFGuard };
