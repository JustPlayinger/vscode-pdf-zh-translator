'use strict';

/*
 * vscode-pdf-zh-translator —— PDF.js 启动引导
 *
 * 本文件替代 pdf.js 上游 Prebuilt 自带的 URL 参数入口：
 * 扩展宿主把文档地址与运行期配置通过 <meta id="pdf-zh-config"> 注入，
 * 这里负责把它们交给 PDFViewerApplication，并处理“源文件变更 → 重新加载”。
 */

(function () {
  function loadConfig() {
    const elem = document.getElementById('pdf-zh-config');
    if (!elem) {
      throw new Error('未找到 pdf-zh-config 配置节点。');
    }
    return JSON.parse(elem.getAttribute('data-config'));
  }

  window.addEventListener(
    'load',
    async function () {
      let config;
      try {
        config = loadConfig();
      } catch (error) {
        window.onerror(String(error));
        return;
      }

      // 供 ai-translate.js 复用
      window.__PDF_ZH_CONFIG__ = config;
      const vscodeApi = acquireVsCodeApi();
      window.__PDF_ZH__ = { config: config, vscode: vscodeApi };

      PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl);
      PDFViewerApplicationOptions.set('standardFontDataUrl', config.standardFontDataUrl);

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
        console.error('[pdf-zh] 加载失败', error);
        window.onerror(String(error));
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
    }
  });

  window.onerror = function () {
    const body = document.createElement('body');
    const box = document.createElement('div');
    box.style.cssText =
      'padding:24px;font-family:system-ui,sans-serif;color:#f48771;line-height:1.8';
    box.innerHTML =
      '<h3>PDF 加载失败</h3>' +
      '<p>请关闭该标签页后重新打开。若问题持续，请查看输出面板「PDF 中文翻译」。</p>';
    body.appendChild(box);
    document.body = body;
  };
})();
