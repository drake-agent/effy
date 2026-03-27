/**
 * a11y-browser.js — 접근성 트리 기반 브라우저 자동화.
 * DOM 대신 접근성 트리로 요소 참조 (CSS 셀렉터 불필요).
 * Puppeteer/Playwright의 접근성 API 활용.
 * 접근성 트리 스냅샷 중심 자동화.
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('tools:a11y-browser');

class A11yBrowser {
  /**
   * 접근성 기반 브라우저 초기화.
   * @param {Object} [opts={}]
   * @param {boolean} [opts.headless=true]
   * @param {number} [opts.navigationTimeout=30000]
   * @param {string} [opts.puppeteerPath] - Puppeteer 경로 (기본: 'puppeteer')
   */
  constructor(opts = {}) {
    this.headless = opts.headless ?? true;
    this.navigationTimeout = opts.navigationTimeout || 30000;
    this.puppeteerPath = opts.puppeteerPath || 'puppeteer';

    this._browser = null;
    this._page = null;
    this._initialized = false;
    this._refCounter = 0;
    this._refMap = new Map(); // ref_id -> element handle
  }

  /**
   * 브라우저 시작 (lazy require puppeteer).
   * @returns {Promise<void>}
   */
  async launch() {
    if (this._initialized) {
      log.debug('Browser already initialized');
      return;
    }

    try {
      let puppeteer;
      try {
        puppeteer = require(this.puppeteerPath);
      } catch (err) {
        throw new Error(
          `puppeteer not installed. Install with: npm install puppeteer\n` +
          `Error: ${err.message}`
        );
      }

      this._browser = await puppeteer.launch({
        headless: this.headless ? 'new' : false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      this._page = await this._browser.newPage();
      this._page.setDefaultNavigationTimeout(this.navigationTimeout);
      this._initialized = true;

      log.info('A11y browser launched', { headless: this.headless });
    } catch (err) {
      log.error('Browser launch failed', { error: err.message });
      throw err;
    }
  }

  /**
   * 페이지의 전체 접근성 트리를 스냅샷으로 획득.
   * @param {Object} [page] - Puppeteer page 객체 (기본: this._page)
   * @returns {Promise<Object>} 접근성 트리 JSON
   * @example
   * {
   *   ref_id: "a11y_0",
   *   role: "document",
   *   name: "Page Title",
   *   value: "",
   *   description: "",
   *   focused: false,
   *   children: [
   *     {
   *       ref_id: "a11y_1",
   *       role: "button",
   *       name: "Submit",
   *       value: "",
   *       description: "Submit the form",
   *       focused: false,
   *       children: []
   *     }
   *   ]
   * }
   */
  async getAccessibilityTree(page) {
    this._ensureInitialized();

    try {
      const tree = await (page || this._page).evaluate(() => {
        // Puppeteer 컨텍스트에서 접근성 트리 생성
        let refId = 0;
        const refMap = {};

        function buildA11yTree(node, parentRef = null) {
          if (!node) return null;

          const ref = `a11y_${refId++}`;
          refMap[ref] = node;

          // v3.9 fix: Inject data-a11y-ref attribute into DOM so clickByRef/typeByRef
          // can locate elements. Without this, the tree generates refs that are never
          // findable by [data-a11y-ref] selectors in click/type operations.
          try { node.setAttribute('data-a11y-ref', ref); } catch (e) { /* text nodes etc */ }

          // 접근성 정보 추출
          const ariaLabel = node.getAttribute('aria-label') || '';
          const ariaDescribedBy = node.getAttribute('aria-describedby') || '';
          const ariaValue = node.getAttribute('aria-valuenow') || node.getAttribute('aria-value') || '';
          const role = node.getAttribute('role') || node.tagName.toLowerCase();
          const name = ariaLabel || node.textContent?.slice(0, 100) || '';
          const description = ariaDescribedBy ? document.getElementById(ariaDescribedBy)?.textContent || '' : '';

          const item = {
            ref_id: ref,
            role: role,
            name: name.trim(),
            value: ariaValue,
            description: description.trim(),
            focused: document.activeElement === node,
            children: []
          };

          // 자식 노드 재귀 처리 (interactive 요소만)
          const interactiveRoles = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'menuitem', 'tab', 'checkbox', 'radio'];
          const isInteractive = interactiveRoles.includes(role.toLowerCase()) ||
            role.toLowerCase().includes('button') ||
            role.toLowerCase().includes('input') ||
            ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(node.tagName);

          if (isInteractive || node.tagName === 'MAIN' || node.tagName === 'SECTION' || node.tagName === 'NAV') {
            for (let i = 0; i < node.children.length; i++) {
              const child = buildA11yTree(node.children[i], ref);
              if (child) item.children.push(child);
            }
          }

          return item;
        }

        // 루트부터 시작
        const root = document.documentElement;
        const tree = buildA11yTree(root);

        return {
          tree,
          refMap: Object.keys(refMap)
        };
      });

      log.debug('Accessibility tree captured', { refCount: tree.refMap.length });
      return tree.tree;
    } catch (err) {
      log.error('Error capturing accessibility tree', { error: err.message });
      throw err;
    }
  }

  /**
   * 접근성 트리에서 역할과 이름으로 요소 검색.
   * @param {Object} tree - getAccessibilityTree() 결과
   * @param {string} role - ARIA role (예: 'button', 'link')
   * @param {string} [name] - 요소 이름/텍스트 (선택사항)
   * @returns {Array<Object>} 매칭된 노드 배열
   */
  findByRole(tree, role, name) {
    const results = [];

    function traverse(node) {
      if (node.role.toLowerCase() === role.toLowerCase()) {
        if (!name || node.name.toLowerCase().includes(name.toLowerCase())) {
          results.push(node);
        }
      }
      for (const child of node.children || []) {
        traverse(child);
      }
    }

    traverse(tree);
    return results;
  }

  /**
   * 접근성 트리에서 텍스트로 요소 검색.
   * @param {Object} tree - getAccessibilityTree() 결과
   * @param {string} text - 검색할 텍스트
   * @returns {Array<Object>} 매칭된 노드 배열
   */
  findByText(tree, text) {
    const results = [];

    function traverse(node) {
      if (node.name.toLowerCase().includes(text.toLowerCase())) {
        results.push(node);
      }
      for (const child of node.children || []) {
        traverse(child);
      }
    }

    traverse(tree);
    return results;
  }

  /**
   * 접근성 ref_id로 요소 클릭.
   * @param {Object} page - Puppeteer page 객체 (기본: this._page)
   * @param {string} refId - 접근성 ref_id (예: 'a11y_1')
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async clickByRef(page, refId) {
    this._ensureInitialized();

    try {
      const result = await (page || this._page).evaluate((ref) => {
        // 페이지에서 ref에 해당하는 요소 찾기
        const treeJson = JSON.stringify(window.__a11yTree || {});

        // 간단한 구현: ref_id로 요소 식별
        const elements = document.querySelectorAll('[data-a11y-ref]');
        for (const el of elements) {
          if (el.getAttribute('data-a11y-ref') === ref) {
            el.click();
            return { success: true };
          }
        }

        // 대체: 텍스트 기반 검색으로 매칭된 요소 클릭
        const buttons = document.querySelectorAll('button, [role="button"], a');
        for (const btn of buttons) {
          if (btn.textContent.includes(ref)) {
            btn.click();
            return { success: true };
          }
        }

        return { success: false, error: `Element ${ref} not found` };
      }, refId);

      if (!result.success) {
        log.warn('Click by ref failed', { refId, error: result.error });
      }

      return result;
    } catch (err) {
      log.error('Error clicking element', { refId, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * 접근성 ref_id의 입력 필드에 텍스트 입력.
   * @param {Object} page - Puppeteer page 객체 (기본: this._page)
   * @param {string} refId - 접근성 ref_id
   * @param {string} text - 입력할 텍스트
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async typeByRef(page, refId, text) {
    this._ensureInitialized();

    try {
      const result = await (page || this._page).evaluate(({ ref, txt }) => {
        // ref_id의 입력 요소 찾기
        const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
        for (const input of inputs) {
          if (input.getAttribute('data-a11y-ref') === ref) {
            input.focus();
            input.value = txt;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          }
        }

        return { success: false, error: `Input ${ref} not found` };
      }, { ref: refId, txt: text });

      if (!result.success) {
        log.warn('Type by ref failed', { refId, error: result.error });
      }

      return result;
    } catch (err) {
      log.error('Error typing text', { refId, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * 접근성 트리에서 interactive 요소만 필터링.
   * @param {Object} tree - getAccessibilityTree() 결과
   * @returns {Array<Object>} interactive 요소 배열
   */
  getInteractiveElements(tree) {
    const interactiveRoles = [
      'button', 'link', 'textbox', 'searchbox', 'combobox',
      'listbox', 'menuitem', 'tab', 'checkbox', 'radio',
      'slider', 'spinbutton', 'switch'
    ];

    const results = [];

    function traverse(node) {
      if (interactiveRoles.includes(node.role.toLowerCase())) {
        results.push(node);
      }
      for (const child of node.children || []) {
        traverse(child);
      }
    }

    traverse(tree);
    return results;
  }

  /**
   * 접근성 트리를 LLM-friendly 문자열로 변환.
   * @param {Object} tree - getAccessibilityTree() 결과
   * @param {number} [maxDepth=5] - 최대 깊이
   * @returns {string} 인간이 읽을 수 있는 페이지 상태 설명
   */
  describePageState(tree, maxDepth = 5) {
    const lines = [];

    function traverse(node, depth = 0) {
      if (depth > maxDepth) return;

      const indent = '  '.repeat(depth);
      const interactive = node.role.toLowerCase().match(/button|link|input|textbox|checkbox|radio/) ? '[interactive]' : '';

      lines.push(`${indent}${node.role}: "${node.name}" ${interactive}`);

      if (node.description) {
        lines.push(`${indent}  → ${node.description}`);
      }

      for (const child of (node.children || []).slice(0, 10)) {
        traverse(child, depth + 1);
      }
    }

    traverse(tree);

    return `Page Structure:\n${lines.join('\n')}`;
  }

  /**
   * 현재 페이지 URL로 이동.
   * @param {string} url
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async navigate(url) {
    this._ensureInitialized();

    try {
      await this._page.goto(url, { waitUntil: 'networkidle2' });
      log.info('Navigated to URL', { url });
      return { success: true };
    } catch (err) {
      log.error('Navigation failed', { url, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * 브라우저 종료 및 리소스 정리.
   * @returns {Promise<void>}
   */
  async close() {
    if (this._browser) {
      try {
        await this._browser.close();
        this._browser = null;
        this._page = null;
        this._initialized = false;
        this._refMap.clear();
        log.info('A11y browser closed');
      } catch (err) {
        log.error('Error closing browser', { error: err.message });
      }
    }
  }

  /**
   * 초기화 확인 헬퍼.
   * @private
   */
  _ensureInitialized() {
    if (!this._initialized) {
      throw new Error('A11y browser not initialized. Call launch() first.');
    }
  }

  /**
   * 현재 페이지 스크린샷 저장.
   * @param {string} [filePath] - 저장 경로
   * @returns {Promise<string>} 저장된 파일 경로
   */
  async screenshot(filePath = null) {
    this._ensureInitialized();

    try {
      const path = filePath || `./a11y_screenshot_${Date.now()}.png`;
      await this._page.screenshot({ path, fullPage: true });
      log.info('Screenshot saved', { path });
      return path;
    } catch (err) {
      log.error('Screenshot failed', { error: err.message });
      throw err;
    }
  }

  /**
   * 현재 페이지 DOM에서 접근성 ref 주입.
   * 내부 사용: clickByRef, typeByRef가 요소를 식별하도록 지원.
   * @private
   */
  async _injectA11yRefs() {
    try {
      await this._page.evaluate(() => {
        let refId = 0;
        const interactiveSelectors = 'button, [role="button"], a, input, select, textarea, [contenteditable="true"]';
        document.querySelectorAll(interactiveSelectors).forEach(el => {
          if (!el.getAttribute('data-a11y-ref')) {
            el.setAttribute('data-a11y-ref', `a11y_${refId++}`);
          }
        });
      });
    } catch (err) {
      log.warn('Error injecting a11y refs', { error: err.message });
    }
  }

  /**
   * 도구 스키마 목록 (tool-registry.js 통합용).
   * @static
   * @returns {Array<Object>} 도구 스키마 배열
   */
  static getToolSchemas() {
    return [
      {
        name: 'a11y_navigate',
        description: '접근성 기반 브라우저로 URL 이동.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL' }
          },
          required: ['url']
        }
      },
      {
        name: 'a11y_get_tree',
        description: '현재 페이지의 접근성 트리 스냅샷 획득.',
        input_schema: { type: 'object', properties: {} }
      },
      {
        name: 'a11y_find_by_role',
        description: 'ARIA role로 요소 검색.',
        input_schema: {
          type: 'object',
          properties: {
            role: { type: 'string', description: '요소 역할 (button, link 등)' },
            name: { type: 'string', description: '요소 이름 (선택사항)' }
          },
          required: ['role']
        }
      },
      {
        name: 'a11y_find_by_text',
        description: '텍스트로 요소 검색.',
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '검색 텍스트' }
          },
          required: ['text']
        }
      },
      {
        name: 'a11y_click',
        description: '접근성 ref_id로 요소 클릭.',
        input_schema: {
          type: 'object',
          properties: {
            ref_id: { type: 'string', description: 'a11y_0 형식의 요소 참조' }
          },
          required: ['ref_id']
        }
      },
      {
        name: 'a11y_type',
        description: '접근성 ref_id의 입력 필드에 텍스트 입력.',
        input_schema: {
          type: 'object',
          properties: {
            ref_id: { type: 'string', description: 'a11y_N 형식의 입력 필드 참조' },
            text: { type: 'string', description: '입력할 텍스트' }
          },
          required: ['ref_id', 'text']
        }
      },
      {
        name: 'a11y_describe',
        description: '현재 페이지 상태를 인간이 읽을 수 있는 형식으로 설명.',
        input_schema: { type: 'object', properties: {} }
      }
    ];
  }
}

module.exports = { A11yBrowser };
