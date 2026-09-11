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

  /*
   * 关键：通信桥必须在**脚本加载时同步**建立，不能推迟到 load 事件里。
   *
   * bootstrap.js 与 ai-translate.js 都是 <head> 中的同步脚本，按顺序执行；
   * 而 load 事件要等页面所有资源加载完毕才触发 —— 那时 ai-translate.js 早已执行完。
   * 若把建桥推迟到 load，ai-translate.js 会永久拿不到 vscode API，
   * 表现为工具栏没有「译」按钮、点翻译直接抛 TypeError。
   */
  let config = null;
  let initError = null;
  try {
    config = loadConfig();
  } catch (error) {
    initError = error;
  }

  let vscodeApi = null;
  try {
    vscodeApi = acquireVsCodeApi();
  } catch (error) {
    initError = initError || error;
  }

  // 供 ai-translate.js 与后续逻辑复用
  window.__PDF_ZH_CONFIG__ = config;
  window.__PDF_ZH__ = { config: config, vscode: vscodeApi };

  window.addEventListener(
    'load',
    async function () {
      if (initError || !config) {
        window.onerror(String(initError || '未能读取运行期配置。'));
        return;
      }

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
