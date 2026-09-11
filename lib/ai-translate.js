'use strict';

/*
 * vscode-pdf-zh-translator —— Webview 侧 UI 与文本抽取
 *
 * 职责边界：
 *  - 本文件负责：从 pdf.js 文本层抽取段落、渲染中英对照面板、划词浮窗。
 *  - 翻译请求一律发给扩展宿主（Node 侧执行）：
 *      · Webview 内不接触 API Key；
 *      · 不需要放宽 CSP 的 connect-src。
 */

(function () {
  /*
   * 通信桥由 bootstrap.js 在**脚本加载时同步**建立。
   *
   * 这里刻意不在 IIFE 顶层捕获 window.__PDF_ZH__，而是在用到时再取：
   * 若顶层捕获，一旦脚本执行顺序变化或 bootstrap 初始化失败，
   * 就会永久拿到 undefined —— 表现是 UI 静默不出现、点「翻译」抛 TypeError，
   * 排查成本极高。延迟解析 + 显式报错能让这类问题立刻暴露。
   */
  function bridge() {
    return window.__PDF_ZH__ || {};
  }

  function api() {
    const state = bridge();
    if (state.vscode) {
      return state.vscode;
    }
    // bootstrap 在解析期若没能拿到（时序问题），这里按需重试；结果会被缓存。
    if (typeof state.acquireApi === 'function') {
      return state.acquireApi();
    }
    return null;
  }

  function bridgeErrorText() {
    return bridge().bridgeError || 'acquireVsCodeApi 不可用';
  }

  function post(message) {
    const target = api();
    if (!target) {
      const detail = bridgeErrorText();
      const notice = bridge().showNotice;
      if (typeof notice === 'function') {
        notice(
          '[pdf-zh] 翻译不可用：未取得 VS Code 通信桥（' + detail + '）。PDF 阅读不受影响。',
        );
      }
      throw new Error('未取得 VS Code 通信桥（' + detail + '）。');
    }
    target.postMessage(message);
  }

  const state = {
    panelOpen: false,
    showOriginal: false,
    /** pageNo -> { paragraphs: string[] | null, results: Map<index, {text, hit, error}> } */
    pages: new Map(),
    reqSeq: 0,
    inflight: new Map(),
    busy: false,
    aborted: false,
    currentPage: 1,
    viewerWired: false,
  };

  let els = null;

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function msg(error) {
    if (!error) {
      return '未知错误';
    }
    return error.message || String(error);
  }

  // ────────────────────────────── DOM ──────────────────────────────

  function ensureUi() {
    if (els) {
      return els;
    }

    const toolbarRight = document.getElementById('toolbarViewerRight');
    const button = document.createElement('div');
    button.id = 'pdfzh-translate-button';
    button.className = 'pdfzh-toolbarButton';
    button.textContent = '译';
    button.title = 'PDF中文：显示 / 隐藏中英对照面板';
    button.addEventListener('click', function () {
      setPanel(!state.panelOpen);
    });
    if (toolbarRight) {
      toolbarRight.insertBefore(button, toolbarRight.firstChild);
    }

    const panel = document.createElement('div');
    panel.id = 'pdfzh-panel';
    panel.innerHTML =
      '<header>' +
      '<span class="pdfzh-title" id="pdfzh-title">中英对照</span>' +
      '<span class="pdfzh-spacer"></span>' +
      '<button class="pdfzh-btn" data-act="close" title="关闭面板">×</button>' +
      '</header>' +
      '<div class="pdfzh-actions">' +
      '<button class="pdfzh-btn" data-act="page" title="只翻译当前页；已缓存的段落不会重复计费">译本页</button>' +
      '<button class="pdfzh-btn" data-act="doc" title="逐页翻译整篇；已缓存的段落会自动跳过">译整篇</button>' +
      '<button class="pdfzh-btn" data-act="stop" title="中止正在进行的翻译">停止</button>' +
      '<button class="pdfzh-btn" data-act="toggle-en" title="显示 / 隐藏英文原文">原文</button>' +
      '<button class="pdfzh-btn" data-act="export" title="复用本地缓存导出中英对照 Markdown（不消耗 token）">导出</button>' +
      '<button class="pdfzh-btn" data-act="stats" title="查看缓存命中与节省统计">统计</button>' +
      '</div>' +
      '<div id="pdfzh-status"></div>' +
      '<div id="pdfzh-body"></div>';
    document.body.appendChild(panel);

    const pop = document.createElement('div');
    pop.id = 'pdfzh-pop';
    document.body.appendChild(pop);

    panel.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const act = target.getAttribute('data-act');
      if (!act) {
        return;
      }
      if (act === 'page') {
        void translateCurrentPage();
      } else if (act === 'doc') {
        void translateWholeDocument();
      } else if (act === 'stop') {
        stopTranslation();
      } else if (act === 'toggle-en') {
        state.showOriginal = !state.showOriginal;
        document.body.classList.toggle('pdfzh-show-en', state.showOriginal);
      } else if (act === 'export') {
        post({ type: 'tr:export', format: 'dual' });
      } else if (act === 'stats') {
        post({ type: 'tr:stats' });
      } else if (act === 'close') {
        setPanel(false);
      }
    });

    els = {
      button: button,
      panel: panel,
      title: document.getElementById('pdfzh-title'),
      status: document.getElementById('pdfzh-status'),
      body: document.getElementById('pdfzh-body'),
      pop: pop,
    };
    return els;
  }

  function setStatus(text, kind) {
    const ui = ensureUi();
    // 防御：面板若因 DOM 异常未能建全，不应该让整个 UI 崩掉
    if (!ui.status) {
      return;
    }
    ui.status.textContent = text || '';
    ui.status.className = kind || '';
  }

  function setBusy(busy) {
    state.busy = busy;
    const ui = ensureUi();
    if (ui.button) {
      ui.button.setAttribute('data-busy', busy ? '1' : '0');
    }
    if (!ui.panel) {
      return;
    }
    const buttons = ui.panel.querySelectorAll('button.pdfzh-btn');
    for (const btn of buttons) {
      const act = btn.getAttribute('data-act');
      if (act === 'stop') {
        btn.disabled = !busy;
      } else if (act === 'page' || act === 'doc') {
        btn.disabled = busy;
      }
    }
  }

  function setPanel(open) {
    const ui = ensureUi();
    state.panelOpen = open;
    document.body.classList.toggle('pdfzh-open', open);
    ui.button.classList.toggle('active', open);
    if (open) {
      renderPanel();
    } else {
      hidePop();
    }
  }

  // ─────────────────────── 从 pdf.js 文本层抽段落 ───────────────────────

  /**
   * 把一页的 textContent.items 归并成“段落”。
   * 思路：先按 y 坐标聚成行，再按行间距合并成段。
   * 纯启发式，但只依赖 PDF 文本层本身，因此同一文件每次结果稳定 —— 这对缓存命中至关重要。
   */
  function groupParagraphs(items) {
    const glyphs = [];
    for (const item of items) {
      const str = item.str;
      if (!str || !str.trim()) {
        continue;
      }
      const tr = item.transform;
      const height = Math.abs(tr[3]) || item.height || 10;
      glyphs.push({
        str: str,
        x: tr[4],
        y: tr[5],
        h: height,
        w: item.width !== undefined && item.width !== null ? item.width : str.length * height * 0.5,
      });
    }
    if (glyphs.length === 0) {
      return [];
    }

    glyphs.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > 2) {
        return b.y - a.y;
      }
      return a.x - b.x;
    });

    // ① 聚成行
    const lines = [];
    let current = null;
    for (const glyph of glyphs) {
      const tol = Math.max(1.5, (current ? current.h : glyph.h) * 0.45);
      if (current && Math.abs(current.y - glyph.y) <= tol) {
        current.items.push(glyph);
        current.h = Math.max(current.h, glyph.h);
      } else {
        current = { y: glyph.y, h: glyph.h, items: [glyph] };
        lines.push(current);
      }
    }

    // ② 行内拼接（按字距决定是否补空格）
    const rows = [];
    for (const line of lines) {
      line.items.sort(function (a, b) {
        return a.x - b.x;
      });
      let text = '';
      let prevRight = null;
      for (const glyph of line.items) {
        if (prevRight !== null) {
          const gap = glyph.x - prevRight;
          const needSpace =
            gap > Math.max(1, glyph.h * 0.28) && !/\s$/.test(text) && !/^\s/.test(glyph.str);
          if (needSpace) {
            text += ' ';
          }
        }
        text += glyph.str;
        prevRight = glyph.x + glyph.w;
      }
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned) {
        rows.push({ text: cleaned, y: line.y, h: line.h });
      }
    }
    rows.sort(function (a, b) {
      return b.y - a.y;
    });

    // ③ 按行距合并成段
    const paragraphs = [];
    let para = null;
    for (const row of rows) {
      if (para) {
        const gap = para.y - row.y;
        const limit = Math.max(para.h, row.h) * 1.8;
        if (gap <= limit) {
          const dehyphen = /[-\u2010-\u2015]$/.test(para.text);
          para.text = (dehyphen ? para.text.replace(/[-\u2010-\u2015]$/, '') + row.text : para.text + ' ' + row.text)
            .replace(/\s+/g, ' ')
            .trim();
          para.y = row.y;
          para.h = row.h;
          continue;
        }
      }
      para = { text: row.text, y: row.y, h: row.h };
      paragraphs.push(para);
    }

    // ④ 过滤孤立页码
    return paragraphs
      .map(function (p) {
        return p.text;
      })
      .filter(function (t) {
        return t.length >= 2 && !/^\d{1,4}$/.test(t);
      });
  }

  async function extractPage(pageNo) {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      throw new Error('PDF 尚未加载完成');
    }
    const page = await app.pdfDocument.getPage(pageNo);
    const textContent = await page.getTextContent();
    return groupParagraphs(textContent.items);
  }

  function getPageState(pageNo) {
    let ps = state.pages.get(pageNo);
    if (!ps) {
      ps = { paragraphs: null, results: new Map() };
      state.pages.set(pageNo, ps);
    }
    return ps;
  }

  function request(payload) {
    return new Promise(function (resolve, reject) {
      const reqId = ++state.reqSeq;
      state.inflight.set(reqId, { resolve: resolve, reject: reject });
      post(Object.assign({ type: 'tr:request', reqId: reqId }, payload));
    });
  }

  // ────────────────────────── 翻译流程 ──────────────────────────

  function applyResults(previous, pending, response) {
    const byKey = new Map();
    for (const item of response.items || []) {
      byKey.set(item.k, item);
    }
    let hits = 0;
    for (const req of pending) {
      const got = byKey.get(req.k);
      if (!got) {
        continue;
      }
      if (got.hit && got.text) {
        hits += 1;
      }
      previous.results.set(req.k, { text: got.text, hit: !!got.hit, error: got.error });
    }
    return hits;
  }

  async function translatePageInternal(pageNo, kind) {
    const previous = getPageState(pageNo);

    if (!previous.paragraphs) {
      try {
        previous.paragraphs = await extractPage(pageNo);
      } catch (error) {
        setStatus('无法读取第 ' + pageNo + ' 页文本：' + msg(error), 'error');
        renderPanel();
        return;
      }
    }

    if (previous.paragraphs.length === 0) {
      setStatus('第 ' + pageNo + ' 页没有可抽取的文本（可能是扫描件，需要 OCR）。', 'error');
      renderPanel();
      return;
    }

    const pending = [];
    previous.paragraphs.forEach(function (text, index) {
      const got = previous.results.get(index);
      if (!got || got.error) {
        pending.push({ k: index, text: text });
      }
    });

    if (pending.length === 0) {
      setStatus('第 ' + pageNo + ' 页全部命中本地缓存，未消耗 token。', 'ok');
      renderPanel();
      return;
    }

    setBusy(true);
    setStatus('正在翻译第 ' + pageNo + ' 页（' + pending.length + ' 段待处理）…');

    try {
      const response = await request({ kind: kind, pageNo: pageNo, items: pending });
      const hits = applyResults(previous, pending, response);
      const usage = response.usage || {};
      setStatus(
        '第 ' + pageNo + ' 页完成：命中缓存 ' + hits + ' 段，实际请求 ' + (usage.requested || 0) + ' 段' +
          (usage.estTokensSaved ? '，约省 ' + usage.estTokensSaved + ' tokens' : ''),
        'ok',
      );
    } catch (error) {
      setStatus('翻译失败：' + msg(error), 'error');
    } finally {
      setBusy(false);
      renderPanel();
    }
  }

  async function translateCurrentPage() {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      setStatus('PDF 尚未加载完成', 'error');
      return;
    }
    if (state.busy) {
      setStatus('正在翻译中，请稍候或点击「停止」。');
      return;
    }
    await translatePageInternal(app.pdfViewer.currentPageNumber, 'page');
  }

  async function translateWholeDocument() {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      setStatus('PDF 尚未加载完成', 'error');
      return;
    }
    if (state.busy) {
      setStatus('正在翻译中，请稍候或点击「停止」。');
      return;
    }

    const total = app.pdfDocument.numPages;
    const confirmed = window.confirm(
      '将逐页翻译整篇（共 ' + total + ' 页）。\n' +
        '已翻译过的段落会直接命中本地磁盘缓存，不会重复消耗 token。\n\n继续吗？',
    );
    if (!confirmed) {
      return;
    }

    state.aborted = false;
    for (let pageNo = 1; pageNo <= total; pageNo += 1) {
      if (state.aborted) {
        setStatus('已中止：停在第 ' + pageNo + ' 页。', 'error');
        return;
      }
      await translatePageInternal(pageNo, 'doc');
    }
    setStatus('整篇翻译完成，共 ' + total + ' 页。', 'ok');
  }

  function stopTranslation() {
    state.aborted = true;
    post({ type: 'tr:abort' });
    setStatus('已请求中止…', 'error');
  }

  // ────────────────────────── 渲染 ──────────────────────────

  function renderPanel() {
    if (!state.panelOpen) {
      return;
    }
    const ui = ensureUi();
    if (!ui.body) {
      return;
    }
    const app = window.PDFViewerApplication;
    const pageNo = app && app.pdfViewer ? app.pdfViewer.currentPageNumber : 1;
    const total = app && app.pdfDocument ? app.pdfDocument.numPages : 0;
    state.currentPage = pageNo;
    if (ui.title) {
      ui.title.textContent = '中英对照 · 第 ' + pageNo + ' 页' + (total ? ' / ' + total : '');
    }

    const previous = state.pages.get(pageNo);
    if (!previous || !previous.paragraphs) {
      ui.body.innerHTML =
        '<div class="pdfzh-empty">第 ' + pageNo + ' 页尚未翻译。<br><br>' +
        '点击上方 <b>译本页</b> 开始；已缓存的段落不会重复计费。</div>';
      return;
    }
    if (previous.paragraphs.length === 0) {
      ui.body.innerHTML = '<div class="pdfzh-empty">本页没有可抽取的文本，可能是扫描件。</div>';
      return;
    }

    const blocks = previous.paragraphs.map(function (source, index) {
      const got = previous.results.get(index);
      const failed = !!(got && got.error);
      let zh;
      if (got && got.text) {
        zh = esc(got.text);
      } else if (failed) {
        zh = '⚠ ' + esc(got.error);
      } else {
        zh = '<span style="opacity:.5">（未翻译）</span>';
      }
      const badge = got && got.hit && got.text ? '<span class="pdfzh-badge">缓存</span>' : '';
      return (
        '<div class="pdfzh-para' +
        (failed ? ' pdfzh-failed' : '') +
        '"><div class="pdfzh-zh">' +
        zh +
        badge +
        '</div><div class="pdfzh-en">' +
        esc(source) +
        '</div></div>'
      );
    });

    ui.body.innerHTML =
      '<div class="pdfzh-hint">共 ' +
      previous.paragraphs.length +
      ' 段；点「原文」可显示英文对照。</div>' +
      blocks.join('');
  }

  function renderStats(payload) {
    const s = payload.stats || {};
    setStatus(
      '缓存段落 ' + (s.segments || 0) +
        ' · 文档 ' + (s.docs || 0) +
        ' · 命中 ' + (s.hits || 0) +
        ' · 未命中 ' + (s.misses || 0) +
        ' · 累计省约 ' + (s.estTokensSaved || 0) + ' tokens',
      'ok',
    );
  }

  // ────────────────────────── 划词浮窗 ──────────────────────────

  let popText = '';

  function hidePop() {
    if (!els) {
      return;
    }
    els.pop.style.display = 'none';
    popText = '';
  }

  function placePop(rect) {
    const ui = ensureUi();
    const width = 300;
    let left = rect.left;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - width - 12);
    }
    let top = (rect.bottom || rect.top) + 8;
    if (top > window.innerHeight - 160) {
      top = Math.max(12, rect.top - 140);
    }
    ui.pop.style.left = left + 'px';
    ui.pop.style.top = top + 'px';
    ui.pop.style.width = width + 'px';
    ui.pop.style.display = 'block';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch (inner) {
        return false;
      }
    }
  }

  document.addEventListener('mouseup', function (event) {
    const ui = ensureUi();
    if (ui.pop.contains(event.target)) {
      return;
    }
    if (ui.panel.contains(event.target)) {
      hidePop();
      return;
    }

    window.setTimeout(function () {
      const selection = window.getSelection();
      const raw = selection ? String(selection) : '';
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text.length < 2) {
        hidePop();
        return;
      }
      popText = text;
      ui.pop.innerHTML =
        '<div class="pdfzh-pop-text" id="pdfzh-pop-body">已选中 ' + text.length + ' 个字符</div>' +
        '<div class="pdfzh-pop-actions">' +
        '<button data-pop="go">翻译</button>' +
        '<button data-pop="copy">复制</button>' +
        '</div>';
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      const rect = range
        ? range.getBoundingClientRect()
        : { left: event.clientX, top: event.clientY, bottom: event.clientY };
      placePop(rect);
    }, 0);
  });

  document.addEventListener('mousedown', function (event) {
    if (!els) {
      return;
    }
    if (!els.pop.contains(event.target)) {
      hidePop();
    }
  });

  document.addEventListener('click', async function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const act = target.getAttribute('data-pop');
    if (!act) {
      return;
    }
    if (act === 'copy') {
      const ok = await copyText(popText);
      target.textContent = ok ? '已复制' : '复制失败';
      return;
    }
    if (act === 'go') {
      const body = document.getElementById('pdfzh-pop-body');
      if (!body || !popText) {
        return;
      }
      body.textContent = '翻译中…';
      try {
        const response = await request({ kind: 'selection', items: [{ k: 0, text: popText }] });
        const item = (response.items || [])[0];
        if (item && item.text) {
          body.textContent = item.text + (item.hit ? '　（缓存）' : '');
        } else {
          body.textContent = '翻译失败：' + ((item && item.error) || '未获得译文');
        }
      } catch (error) {
        body.textContent = '翻译失败：' + msg(error);
      }
    }
  });
  // ───────────────────── 宿主消息 与 启动 ─────────────────────

  async function handleCommand(cmd) {
    if (cmd === 'translate-page') {
      setPanel(true);
      await translateCurrentPage();
    } else if (cmd === 'translate-doc') {
      setPanel(true);
      await translateWholeDocument();
    } else if (cmd === 'show-original') {
      state.showOriginal = !state.showOriginal;
      document.body.classList.toggle('pdfzh-show-en', state.showOriginal);
      setPanel(true);
    }
  }

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || !data.type) {
      return;
    }
    switch (data.type) {
      case 'progress':
        setStatus('已处理 ' + data.done + ' / ' + data.total + ' 段…');
        break;
      case 'result': {
        const inflight = state.inflight.get(data.reqId);
        state.inflight.delete(data.reqId);
        if (!inflight) {
          return;
        }
        if (data.error) {
          inflight.reject(new Error(data.error));
        } else {
          inflight.resolve(data);
        }
        break;
      }
      case 'stats':
        renderStats(data);
        break;
      case 'info':
        setStatus(data.text, 'ok');
        break;
      case 'cleared':
        state.pages.clear();
        renderPanel();
        break;
      case 'cmd':
        void handleCommand(data.cmd);
        break;
      default:
        break;
    }
  });

  let wireAttempts = 0;

  function wireViewer() {
    if (state.viewerWired) {
      return;
    }
    const app = window.PDFViewerApplication;
    if (!app || !app.eventBus) {
      wireAttempts += 1;
      if (wireAttempts < 60) {
        window.setTimeout(wireViewer, 200);
      }
      return;
    }
    state.viewerWired = true;
    app.eventBus.on('pagechanging', function (event) {
      hidePop();
      renderPanel();
      const cfg = bridge().config || {};
      if (cfg.autoTranslatePageOnScroll && state.panelOpen && !state.busy) {
        void translatePageInternal(event.pageNumber, 'page');
      }
    });
  }

  function start() {
    // UI 与桥解耦：UI 必须无条件建起来，否则用户连「译」按钮都看不到。
    try {
      ensureUi();
      setBusy(false);
      wireViewer();
    } catch (error) {
      console.error('[pdf-zh] UI 初始化失败', error);
    }

    try {
      post({ type: 'tr:ready' });
    } catch (error) {
      // 桥不可用只影响翻译，绝不能让 PDF 阅读受影响。
      setStatus(
        '翻译功能不可用（' +
          ((error && error.message) || String(error)) +
          '）　PDF 阅读不受影响。',
        'error',
      );
    }
  }

  window.addEventListener('pdfzh:documentloaded', function () {
    wireViewer();
    setStatus('已就绪：点「译本页」开始翻译。');
    renderPanel();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 暴露纯函数供自动化测试使用（scripts/smoke-paragraphs.mjs）。
  // 只挂内部实现，不改变运行时行为。
  try {
    window.__pdfzhInternals = { groupParagraphs: groupParagraphs };
  } catch (error) {
    /* 非浏览器环境下载入时忽略 */
  }
})();




