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
    /** 是否把译文直接覆盖在原文字面上 */
    overlayEnabled: true,
    /** pageNo -> { paragraphs: [{text,fontSize,nodes}] | null, results: Map<index, {text, hit, error}> } */
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
      '<button class="pdfzh-btn" data-act="overlay" title="译文直接覆盖在原文位置上（关闭则显示英文原文）">覆盖</button>' +
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
      } else if (act === 'overlay') {
        setOverlayEnabled(!state.overlayEnabled);
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

  // ─────────────────────── 段落抽取 ───────────────────────

  /*
   * 统一约定：一个 “glyph” 形如 { str, x, y, h, w, node }
   *   - str  文本片段
   *   - x/y  位置；y **向上为正**（与 PDF 坐标系一致）
   *   - h/w  字号与宽度，必须与 x/y 同量纲
   *   - node 可选的 DOM 节点（文本层 span），仅「覆盖模式」定位时需要
   *
   * 之所以统一成 y 向上：行/段合并全靠相对比较（间距 vs 字号倍数），
   * 只要两套来源坐标系一致，切分结果就一致 —— 这保证了「先用 textContent
   * 翻译、等文本层渲染后再覆盖」时段落下标一一对应，不会重复调用 API。
   */

  /** 由 pdf.js 的 textContent.items 生成 glyph（无 DOM 节点，不用于覆盖定位）。 */
  function glyphsFromPdfItems(items) {
    const glyphs = [];
    if (!items) {
      return glyphs;
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const str = item && item.str;
      if (!str || !str.trim()) {
        continue;
      }
      const tr = item.transform;
      const h = Math.abs(tr[3]) || item.height || 10;
      glyphs.push({
        str: str,
        x: tr[4],
        y: tr[5],
        h: h,
        w: item.width !== undefined && item.width !== null ? item.width : str.length * h * 0.5,
        node: null,
      });
    }
    return glyphs;
  }

  /** 由已渲染的文本层 span 生成 glyph：位置取自真实 DOM，可直接用于覆盖定位。 */
  function glyphsFromTextLayer(layerEl, pageEl) {
    const glyphs = [];
    if (!layerEl || !pageEl) {
      return glyphs;
    }
    const pageRect = pageEl.getBoundingClientRect();
    const spans = layerEl.querySelectorAll('span');
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      const str = span.textContent || '';
      if (!str.trim()) {
        continue;
      }
      const rect = span.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) {
        continue;
      }
      const h = parseFloat(span.style.fontSize) || rect.height || 10;
      glyphs.push({
        str: str,
        x: rect.left - pageRect.left,
        // 取负号：使「y 越大越靠上」，与 PDF 坐标系保持一致
        y: -(rect.top - pageRect.top),
        h: h,
        w: rect.width,
        node: span,
      });
    }
    return glyphs;
  }

  /**
   * 把 glyph 归并成“段落”。先按 y 聚成行，再按行距合并成段。
   * 纯函数、纯启发式，只依赖文本层本身 —— 同一文件每次结果稳定，这对缓存命中至关重要。
   *
   * 返回 [{ text, fontSize, nodes }]，其中 nodes 是该段对应的文本层 span（可能为空）。
   */
  function groupParagraphs(glyphs) {
    if (!glyphs || glyphs.length === 0) {
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
        rows.push({
          text: cleaned,
          y: line.y,
          h: line.h,
          nodes: line.items
            .map(function (g) {
              return g.node;
            })
            .filter(Boolean),
        });
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
          para.heights.push(row.h);
          para.nodes = para.nodes.concat(row.nodes);
          continue;
        }
      }
      para = {
        text: row.text,
        y: row.y,
        h: row.h,
        heights: [row.h],
        nodes: row.nodes.slice(),
      };
      paragraphs.push(para);
    }

    // ④ 过滤孤立页码，并算出该段代表字号（取行高之中位数，避免被上标/下标带偏）
    return paragraphs
      .filter(function (p) {
        return p.text.length >= 2 && !/^\d{1,4}$/.test(p.text);
      })
      .map(function (p) {
        const sorted = p.heights.slice().sort(function (a, b) {
          return a - b;
        });
        return {
          text: p.text,
          fontSize: sorted[Math.floor(sorted.length / 2)] || p.h || 10,
          nodes: p.nodes,
        };
      });
  }

  /**
   * 由该段对应的文本层 span 反算它的外接矩形（相对页面左上角，CSS 像素）。
   * 之所以在覆盖阶段现算而不在分组阶段算：分组要保持纯函数，
   * 而矩形必须依赖真实 DOM 布局（缩放、缩放后重排都会变）。
   */
  function paragraphBox(para, pageEl) {
    if (!para || !para.nodes || para.nodes.length === 0 || !pageEl) {
      return null;
    }
    const pageRect = pageEl.getBoundingClientRect();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < para.nodes.length; i += 1) {
      const rect = para.nodes[i].getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) {
        continue;
      }
      left = Math.min(left, rect.left - pageRect.left);
      top = Math.min(top, rect.top - pageRect.top);
      right = Math.max(right, rect.right - pageRect.left);
      bottom = Math.max(bottom, rect.bottom - pageRect.top);
    }
    if (!isFinite(left) || right <= left || bottom <= top) {
      return null;
    }
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  function pageViewOf(pageNo) {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfViewer || typeof app.pdfViewer.getPageView !== 'function') {
      return null;
    }
    const pageView = app.pdfViewer.getPageView(pageNo - 1);
    return pageView && pageView.div ? pageView : null;
  }

  /**
   * 抽取一页的段落。
   * 优先走「已渲染的文本层」：那里既有文本又有真实几何，覆盖模式可以直接用。
   * 页面尚未渲染时（例如整篇翻译会遍历未显示的页）退回 textContent ——
   * 此时段落没有 DOM 节点，只用于翻译；等页面渲染出来后会自动套用覆盖。
   */
  async function extractPage(pageNo) {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      throw new Error('PDF 尚未加载完成');
    }

    const pageView = pageViewOf(pageNo);
    if (pageView && pageView.rotation % 360 === 0) {
      const layer = pageView.div.querySelector('.textLayer');
      const glyphs = glyphsFromTextLayer(layer, pageView.div);
      if (glyphs.length > 0) {
        return groupParagraphs(glyphs);
      }
    }

    const page = await app.pdfDocument.getPage(pageNo);
    const textContent = await page.getTextContent();
    return groupParagraphs(glyphsFromPdfItems(textContent.items));
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
    previous.paragraphs.forEach(function (para, index) {
      const got = previous.results.get(index);
      if (!got || got.error) {
        pending.push({ k: index, text: para.text });
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
      // 翻译完成后立即把译文覆盖到原文位置
      scheduleOverlay(pageNo);
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

  // ─────────────────── 覆盖模式：译文原位替换原文 ───────────────────

  /*
   * 原理：PDF 的原文字形是**画在 canvas 上的像素**，DOM 里删不掉，
   * 因此「覆盖」= 在每个段落的外接矩形上放一块不透明的译文盒子，
   * 把底下的英文遮住。矩形直接取自 pdf.js 文本层 span 的真实布局，
   * 所以缩放、换页、重排之后重新计算即可保持对齐。
   *
   * 注意：覆盖层必须挂在 .page 上，不能放进 .textLayer ——
   * 后者带 opacity:0.2，放进去译文会变成半透明。
   */

  const OVERLAY_LAYER_CLASS = 'pdfzh-overlay-layer';

  function overlayOptions() {
    const cfg = bridge().config || {};
    const overlay = cfg.overlay || {};
    return {
      enabled: overlay.enabled !== false,
      fontScale: typeof overlay.fontScale === 'number' ? overlay.fontScale : 1,
      padding: typeof overlay.padding === 'number' ? overlay.padding : 1,
      minFontSize: typeof overlay.minFontSize === 'number' ? overlay.minFontSize : 6,
    };
  }

  function overlayLayerFor(pageView, create) {
    let layer = pageView.div.querySelector('.' + OVERLAY_LAYER_CLASS);
    if (!layer && create) {
      layer = document.createElement('div');
      layer.className = OVERLAY_LAYER_CLASS;
      pageView.div.appendChild(layer);
    }
    return layer;
  }

  /**
   * 采样纸张底色：在矩形外侧取 4 个点，选最亮的那个近似背景色。
   * 这样浅灰底、米色底的老论文也不会露出白边。
   */
  function samplePaperColor(pageView, box) {
    const fallback = { color: '#ffffff', dark: false };
    try {
      const canvas = pageView.div.querySelector('canvas');
      if (!canvas || !canvas.width || !canvas.height) {
        return fallback;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return fallback;
      }
      const cssWidth = parseFloat(canvas.style.width) || canvas.width;
      const cssHeight = parseFloat(canvas.style.height) || canvas.height;
      const scaleX = canvas.width / cssWidth;
      const scaleY = canvas.height / cssHeight;
      const points = [
        [box.left - 4, box.top + box.height / 2],
        [box.left + box.width + 4, box.top + box.height / 2],
        [box.left + box.width / 2, box.top - 4],
        [box.left + box.width / 2, box.top + box.height + 4],
      ];
      let best = null;
      for (let i = 0; i < points.length; i += 1) {
        const px = Math.round(points[i][0] * scaleX);
        const py = Math.round(points[i][1] * scaleY);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
          continue;
        }
        const data = ctx.getImageData(px, py, 1, 1).data;
        const lum = 0.299 * data[0] + 0.587 * data[1] + 0.114 * data[2];
        if (!best || lum > best.lum) {
          best = {
            lum: lum,
            color: 'rgb(' + data[0] + ',' + data[1] + ',' + data[2] + ')',
          };
        }
      }
      if (!best) {
        return fallback;
      }
      return { color: best.color, dark: best.lum < 128 };
    } catch (error) {
      return fallback;
    }
  }

  /** 逐步缩小字号直到译文装进盒子（中文通常比英文短，多数情况一次即中）。 */
  function fitOverlayFont(cell, baseFontSize, opt) {
    let size = Math.max(opt.minFontSize, baseFontSize * opt.fontScale);
    cell.style.fontSize = size + 'px';
    let guard = 0;
    while (guard < 24 && size > 5 && cell.scrollHeight > cell.clientHeight + 1) {
      size = Math.max(5, size - Math.max(0.5, size * 0.06));
      cell.style.fontSize = size + 'px';
      guard += 1;
    }
  }

  function applyOverlay(pageNo) {
    const previous = state.pages.get(pageNo);
    const pageView = pageViewOf(pageNo);
    if (!previous || !previous.paragraphs || !pageView) {
      return;
    }
    const layer = overlayLayerFor(pageView, true);
    if (!layer) {
      return;
    }
    while (layer.firstChild) {
      layer.removeChild(layer.firstChild);
    }

    const opt = overlayOptions();
    if (!state.overlayEnabled || !opt.enabled || pageView.rotation % 360 !== 0) {
      return;
    }

    const pageEl = pageView.div;
    previous.paragraphs.forEach(function (para, index) {
      const got = previous.results.get(index);
      if (!got || !got.text) {
        return; // 未翻译或失败：不遮挡，方便用户对照原意
      }
      const box = paragraphBox(para, pageEl);
      if (!box || box.width < 24 || box.height < 5) {
        return;
      }
      // 字号过小多半是图注、坐标轴刻度、页眉页脚 —— 覆盖它们反而更难读
      if (para.fontSize < opt.minFontSize) {
        return;
      }

      const cell = document.createElement('div');
      cell.className = 'pdfzh-overlay';
      cell.setAttribute('data-para', String(index));
      cell.style.left = box.left - opt.padding + 'px';
      cell.style.top = box.top - opt.padding + 'px';
      cell.style.width = box.width + opt.padding * 2 + 'px';
      cell.style.height = box.height + opt.padding * 2 + 'px';
      const paper = samplePaperColor(pageView, box);
      cell.style.background = paper.color;
      cell.style.color = paper.dark ? '#f2f2f2' : '#111111';
      cell.textContent = got.text;
      layer.appendChild(cell);
      fitOverlayFont(cell, para.fontSize, opt);
    });
  }

  const overlayTimers = new Map();

  /** 合并短时间内的多次请求（渲染与缩放都会连续触发多次事件）。 */
  function scheduleOverlay(pageNo) {
    if (!pageNo) {
      return;
    }
    if (overlayTimers.has(pageNo)) {
      window.clearTimeout(overlayTimers.get(pageNo));
    }
    overlayTimers.set(
      pageNo,
      window.setTimeout(function () {
        overlayTimers.delete(pageNo);
        try {
          applyOverlay(pageNo);
        } catch (error) {
          console.error('[pdf-zh] 覆盖渲染失败', error);
        }
      }, 60),
    );
  }

  function refreshAllOverlays() {
    state.pages.forEach(function (_value, pageNo) {
      scheduleOverlay(pageNo);
    });
  }

  function setOverlayEnabled(enabled) {
    state.overlayEnabled = !!enabled;
    if (state.overlayEnabled) {
      // 用户手动打开时，以用户操作为准，覆盖配置里的关闭
      const cfg = bridge();
      if (cfg.config && cfg.config.overlay) {
        cfg.config.overlay.enabled = true;
      }
    }
    document.body.classList.toggle('pdfzh-overlay-off', !state.overlayEnabled);
    setStatus(state.overlayEnabled ? '已开启译文覆盖' : '已关闭译文覆盖（显示英文原文）', 'ok');
    refreshAllOverlays();
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
        esc(source.text) +
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

    // 覆盖层依赖真实布局，因此渲染完成、文本层就绪、缩放变化后都要重算。
    app.eventBus.on('pagerendered', function (event) {
      scheduleOverlay(event.pageNumber);
    });
    app.eventBus.on('textlayerrendered', function (event) {
      reextractForOverlay(event.pageNumber);
    });
    app.eventBus.on('scalechanging', function () {
      refreshAllOverlays();
    });
  }

  /**
   * 文本层渲染完成后，用真实 DOM 几何重新抽一次段落。
   *
   * 场景：整篇翻译时页面未渲染，段落是从 textContent 抽的（没有 DOM 节点、无法定位）；
   * 等用户滚动到该页、文本层就绪后，这里换成带几何的版本，译文立刻就能覆盖上去
   * —— 因为段落内容没变，翻译结果直接命中缓存，**不会重复消耗 token**。
   */
  function reextractForOverlay(pageNo) {
    const previous = state.pages.get(pageNo);
    if (!previous) {
      scheduleOverlay(pageNo);
      return;
    }
    const pageView = pageViewOf(pageNo);
    if (!pageView || pageView.rotation % 360 !== 0) {
      return;
    }
    const layer = pageView.div.querySelector('.textLayer');
    const glyphs = glyphsFromTextLayer(layer, pageView.div);
    if (glyphs.length === 0) {
      return;
    }
    const next = groupParagraphs(glyphs);
    if (next.length === 0) {
      return;
    }
    // 两种来源理论上切分一致；真出现差异时保守跳过，
    // 以免把已翻译的结果按下标错位映射到别的段落上。
    if (
      previous.paragraphs &&
      previous.paragraphs.length > 0 &&
      next.length !== previous.paragraphs.length
    ) {
      console.warn(
        '[pdf-zh] 文本层与 textContent 的段落数不一致（' +
          next.length +
          ' vs ' +
          previous.paragraphs.length +
          '），本次跳过覆盖重算。',
      );
      return;
    }
    previous.paragraphs = next;
    scheduleOverlay(pageNo);
  }

  function start() {
    // UI 与桥解耦：UI 必须无条件建起来，否则用户连「译」按钮都看不到。
    try {
      ensureUi();
      setBusy(false);
      state.overlayEnabled = overlayOptions().enabled;
      document.body.classList.toggle('pdfzh-overlay-off', !state.overlayEnabled);
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

  // 暴露纯函数供自动化测试使用（scripts/smoke-paragraphs.mjs / smoke-webview.mjs）。
  // 只挂内部实现，不改变运行时行为。
  try {
    window.__pdfzhInternals = {
      groupParagraphs: groupParagraphs,
      glyphsFromPdfItems: glyphsFromPdfItems,
      glyphsFromTextLayer: glyphsFromTextLayer,
      paragraphBox: paragraphBox,
    };
  } catch (error) {
    /* 非浏览器环境下载入时忽略 */
  }
})();




