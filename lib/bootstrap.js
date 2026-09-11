'use strict';

/*
 * vscode-pdf-zh-translator —— PDF.js 启动引导
 *
 * 三条设计原则（都很重要）：
 *
 * 1. **PDF 渲染绝不能依赖通信桥。**
 *    acquireVsCodeApi() 的可用时机在不同 VS Code 版本/时序下并不一致。
 *    一旦把「拿不到通信桥」当成致命错误，后果是整份 PDF 打不开 ——
 *    远比「翻译暂时不可用」严重得多。所以桥的获取是 best-effort，
 *    失败只记录、只提示，绝不阻断渲染。
 *
 * 2. **配置在解析期先读一次，失败则在 load 时重试。**
 *    正常情况下配置就在脚本之前，解析期即可读到；万一有时序偏差，
 *    load 事件时 DOM 必然完整，重试一定成功。
 *
 * 3. **出错要显示真实错误，且不破坏 DOM。**
 *    旧实现用 document.body = ... 整页替换，既丢失了真实报错信息，
 *    也把 pdf.js 自己的错误面板一起干掉了，完全无法排查。
 */

(function () {
  function messageOf(error) {
    if (!error) {
      return 'unknown error';
    }
    return error.message || String(error);
  }

  // ───────────────────────── 诊断横幅 ─────────────────────────

  /** 顶部横幅：可关闭、不破坏 DOM、显示真实错误文本。 */
  function showNotice(text) {
    try {
      console.error('[pdf-zh]', text);
      const host = document.body || document.documentElement;
      if (!host) {
        return;
      }
      let banner = document.getElementById('pdfzh-notice');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'pdfzh-notice';
        banner.style.cssText =
          'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:8px 36px 8px 12px;' +
          'background:#5a1d1d;color:#ffd9d9;' +
          'font:12px/1.6 "Microsoft YaHei",system-ui,-apple-system,sans-serif;' +
          'white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 10px rgba(0,0,0,.45)';

        const textNode = document.createElement('span');
        const close = document.createElement('button');
        close.textContent = '\u00d7';
        close.title = '关闭提示';
        close.style.cssText =
          'position:absolute;top:4px;right:6px;background:transparent;color:inherit;' +
          'border:1px solid currentColor;border-radius:3px;cursor:pointer;' +
          'font-size:12px;line-height:1;padding:0 4px';
        close.addEventListener('click', function () {
          if (banner.parentNode) {
            banner.parentNode.removeChild(banner);
          }
        });

        banner.appendChild(textNode);
        banner.appendChild(close);
        host.appendChild(banner);
      }
      banner.firstChild.textContent = String(text);
    } catch (ignored) {
      /* 诊断本身失败就放弃，不要因此再抛错 */
    }
  }

  // ───────────────────────── 运行期配置 ─────────────────────────

  function readConfig() {
    const elem = document.getElementById('pdf-zh-config');
    if (!elem) {
      throw new Error('未找到 <meta id="pdf-zh-config">：扩展注入的配置缺失。');
    }
    const raw = elem.getAttribute('data-config');
    if (!raw) {
      throw new Error('<meta id="pdf-zh-config"> 缺少 data-config 属性。');
    }
    return JSON.parse(raw);
  }

  /** 读取配置；解析期没读到就在调用时重试（load 事件时 DOM 必然完整）。 */
  function ensureConfig() {
    const state = window.__PDF_ZH__;
    if (state && state.config) {
      return state.config;
    }
    const config = readConfig();
    if (state) {
      state.config = config;
    }
    window.__PDF_ZH_CONFIG__ = config;
    return config;
  }

  // ───────────────────────── 通信桥（best-effort） ─────────────────────────

  /**
   * 按需获取 VS Code API。每次调用都会在缓存为空时重试，
   * 因此即使解析期不可用，用户真正点击翻译时也大概率已经可用。
   * 注意 acquireVsCodeApi() 只允许调用一次成功，所以必须先查缓存。
   */
  function acquireApi() {
    const state = window.__PDF_ZH__;
    if (!state) {
      return null;
    }
    if (state.vscode) {
      return state.vscode;
    }
    try {
      if (typeof acquireVsCodeApi !== 'function') {
        state.bridgeError = 'acquireVsCodeApi 尚未注入';
        return null;
      }
      state.vscode = acquireVsCodeApi();
      state.bridgeError = null;
    } catch (error) {
      state.bridgeError = messageOf(error);
    }
    return state.vscode || null;
  }

  let initialConfig = null;
  try {
    initialConfig = readConfig();
  } catch (error) {
    // 解析期读不到不算致命，load 时会重试
    console.warn('[pdf-zh] 解析期读取配置失败，将在 load 时重试：' + messageOf(error));
  }

  let initialApi = null;
  let initialBridgeError = null;
  try {
    if (typeof acquireVsCodeApi === 'function') {
      initialApi = acquireVsCodeApi();
    } else {
      initialBridgeError = 'acquireVsCodeApi 尚未注入';
    }
  } catch (error) {
    initialBridgeError = messageOf(error);
  }

  window.__PDF_ZH_CONFIG__ = initialConfig;
  window.__PDF_ZH__ = {
    config: initialConfig,
    vscode: initialApi,
    bridgeError: initialBridgeError,
    acquireApi: acquireApi,
    ensureConfig: ensureConfig,
    showNotice: showNotice,
  };


  // 全局错误兜底：显示真实错误，绝不替换 DOM
  window.onerror = function (message) {
    showNotice('[pdf-zh] 未捕获错误：' + message);
    return false;
  };
  window.addEventListener('unhandledrejection', function (event) {
    showNotice('[pdf-zh] 未处理的 Promise 拒绝：' + messageOf(event && event.reason));
  });

  window.addEventListener(
    'load',
    async function () {
      let config;
      try {
        config = ensureConfig();
      } catch (error) {
        showNotice('无法读取 PDF 查看器配置：' + messageOf(error));
        return;
      }

      try {
        PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl);
        PDFViewerApplicationOptions.set('standardFontDataUrl', config.standardFontDataUrl);
      } catch (error) {
        console.warn('[pdf-zh] 设置 pdf.js 选项失败：' + messageOf(error));
      }

      const loadOptions = {
        url: config.fileUri,
        // 与扩展的 CSP 保持一致：不额外拉取远程资源
        useWorkerFetch: false,
        isEvalSupported: false,
        cMapUrl: config.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: config.standardFontDataUrl,
      };

      const onDocumentLoaded = function () {
        PDFViewerApplication.eventBus.off('documentloaded', onDocumentLoaded);
        window.dispatchEvent(new CustomEvent('pdfzh:documentloaded'));
      };

      try {
        await PDFViewerApplication.initializedPromise;
        PDFViewerApplication.eventBus.on('documentloaded', onDocumentLoaded);

        // open() 会先确保 pdf.js 初始化完成
        await PDFViewerApplication.open(config.fileUri);
        const doc = await pdfjsLib.getDocument(loadOptions).promise;
        // 用文档地址伪造 fingerprint，使 pdf.js 在重载时保留滚动位置
        doc._pdfInfo.fingerprints = [config.fileUri];
        await PDFViewerApplication.load(doc);
      } catch (error) {
        console.error('[pdf-zh] PDF 加载失败', error);
        showNotice('PDF 加载失败：' + messageOf(error) + '\n地址：' + config.fileUri);
      }
    },
    { once: true },
  );

  // 源文件在磁盘上发生变化时，宿主会发来 reload —— 只有这一种消息走重载分支
  window.addEventListener('message', async function (event) {
    const data = event.data;
    if (!data || data.type !== 'reload') {
      return;
    }
    try {
      const config = window.__PDF_ZH_CONFIG__;
      const loadOptions = {
        url: config.fileUri,
        useWorkerFetch: false,
        isEvalSupported: false,
        cMapUrl: config.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: config.standardFontDataUrl,
      };

      // 阻止重载时的闪烁，并保留滚动位置
      const originalResetView = PDFViewerApplication.pdfViewer._resetView;
      PDFViewerApplication.pdfViewer._resetView = function () {
        this._firstPageCapability = pdfjsLib.createPromiseCapability();
        this._onePageRenderedCapability = pdfjsLib.createPromiseCapability();
        this._pagesCapability = pdfjsLib.createPromiseCapability();
        this.viewer.textContent = '';
      };

      const doc = await pdfjsLib.getDocument(loadOptions).promise;
      doc._pdfInfo.fingerprints = [config.fileUri];
      await PDFViewerApplication.load(doc);

      PDFViewerApplication.pdfViewer._resetView = originalResetView;
      window.dispatchEvent(new CustomEvent('pdfzh:documentloaded'));
    } catch (error) {
      console.error('[pdf-zh] 重载失败', error);
      showNotice('PDF 重新加载失败：' + messageOf(error));
    }
  });
})();
