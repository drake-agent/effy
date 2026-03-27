/**
 * browser.js — 브라우저 자동화 도구 (SpaceBot CDP 패턴 차용).
 *
 * Chrome DevTools Protocol 기반 헤드리스 브라우저 제어.
 * Worker 재시작에도 세션 유지.
 *
 * 도구 목록:
 * 1. browser_navigate: URL 이동
 * 2. browser_get_text: 페이지 텍스트 추출
 * 3. browser_click: 요소 클릭
 * 4. browser_type: 텍스트 입력
 * 5. browser_screenshot: 스크린샷 캡처
 * 6. browser_evaluate: JavaScript 실행
 *
 * Phase 1: puppeteer/playwright 기반 (외부 의존성)
 * 현재: 인터페이스 정의 + 스텁 구현 (의존성 없이)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('tools:browser');

class BrowserTool {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.headless=true]
   * @param {string} [opts.screenshotDir='./data/screenshots']
   * @param {number} [opts.navigationTimeout=30000]
   * @param {boolean} [opts.enabled=false] - 기본 비활성화
   */
  constructor(opts = {}) {
    this.headless = opts.headless ?? true;
    this.screenshotDir = opts.screenshotDir || './data/screenshots';
    this.navigationTimeout = opts.navigationTimeout || 30000;
    this.enabled = opts.enabled ?? false;

    this._browser = null;
    this._page = null;
    this._initialized = false;
  }

  /**
   * 브라우저 초기화.
   */
  async initialize() {
    if (!this.enabled) {
      log.info('Browser tool disabled');
      return;
    }

    try {
      // Phase 2: puppeteer 연동
      // const puppeteer = require('puppeteer');
      // this._browser = await puppeteer.launch({ headless: this.headless ? 'new' : false });
      // this._page = await this._browser.newPage();
      this._initialized = true;
      log.info('Browser tool initialized', { headless: this.headless });
    } catch (err) {
      log.error('Browser initialization failed', { error: err.message });
    }
  }

  /**
   * URL 이동.
   * @param {string} url
   * @returns {Promise<{ success: boolean, title: string, url: string }>}
   */
  async navigate(url) {
    this._ensureInitialized();
    try {
      // Phase 2: await this._page.goto(url, { timeout: this.navigationTimeout });
      log.info('Browser navigate', { url });
      return { success: true, title: '', url, hint: 'Browser CDP not yet connected — install puppeteer for full support' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 페이지 텍스트 추출.
   * @returns {Promise<string>}
   */
  async getText() {
    this._ensureInitialized();
    // Phase 2: return this._page.evaluate(() => document.body.innerText);
    return '(Browser text extraction requires puppeteer — see browser.js Phase 2)';
  }

  /**
   * 요소 클릭 (CSS 셀렉터).
   * @param {string} selector
   */
  async click(selector) {
    this._ensureInitialized();
    log.info('Browser click', { selector });
    // Phase 2: await this._page.click(selector);
    return { success: true, selector, hint: 'Stub implementation' };
  }

  /**
   * 텍스트 입력.
   * @param {string} selector
   * @param {string} text
   */
  async type(selector, text) {
    this._ensureInitialized();
    log.info('Browser type', { selector, textLen: text.length });
    // Phase 2: await this._page.type(selector, text);
    return { success: true, selector, hint: 'Stub implementation' };
  }

  /**
   * 스크린샷 캡처.
   * @param {Object} [opts]
   * @param {string} [opts.path] - 저장 경로
   * @param {boolean} [opts.fullPage=false]
   * @returns {Promise<{ path: string }>}
   */
  async screenshot(opts = {}) {
    this._ensureInitialized();
    const screenshotPath = opts.path || `${this.screenshotDir}/screenshot_${Date.now()}.png`;
    log.info('Browser screenshot', { path: screenshotPath });
    // Phase 2: await this._page.screenshot({ path: screenshotPath, fullPage: opts.fullPage });
    return { path: screenshotPath, hint: 'Stub implementation' };
  }

  /**
   * JavaScript 실행.
   * @param {string} code
   * @returns {Promise<*>}
   */
  async evaluate(code) {
    this._ensureInitialized();
    log.info('Browser evaluate', { codeLen: code.length });
    // Phase 2: return this._page.evaluate(code);
    return { result: null, hint: 'Stub implementation — install puppeteer for JS evaluation' };
  }

  /**
   * 브라우저 종료.
   */
  async close() {
    if (this._browser) {
      // Phase 2: await this._browser.close();
      this._browser = null;
      this._page = null;
      this._initialized = false;
      log.info('Browser closed');
    }
  }

  /** @private */
  _ensureInitialized() {
    if (!this.enabled) throw new Error('Browser tool is disabled. Enable in config: tools.browser.enabled = true');
    // Phase 2: check this._initialized
  }

  /**
   * 도구 스키마 목록 (tool-registry.js 통합용).
   * @returns {Array}
   */
  static getToolSchemas() {
    return [
      {
        name: 'browser_navigate',
        description: '브라우저로 URL 이동.',
        input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL' } }, required: ['url'] },
      },
      {
        name: 'browser_get_text',
        description: '현재 페이지의 텍스트 콘텐츠 추출.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_click',
        description: 'CSS 셀렉터로 요소 클릭.',
        input_schema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
      },
      {
        name: 'browser_type',
        description: '입력 필드에 텍스트 타이핑.',
        input_schema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
      },
      {
        name: 'browser_screenshot',
        description: '현재 페이지 스크린샷 캡처.',
        input_schema: { type: 'object', properties: { fullPage: { type: 'boolean', default: false } } },
      },
      {
        name: 'browser_evaluate',
        description: '페이지에서 JavaScript 코드 실행.',
        input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      },
    ];
  }
}

module.exports = { BrowserTool };
