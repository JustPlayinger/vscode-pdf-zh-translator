#!/usr/bin/env node
/*
 * 校验 Webview 侧的「启动顺序契约」。
 *
 * 背景（真实发生过的 bug）：
 *   bootstrap.js 里曾经把 window.__PDF_ZH__ 建在 window 的 load 事件回调里，
 *   而 ai-translate.js 在 <head> 解析时就执行完了。结果是 ai-translate.js
 *   永久拿不到 VS Code 通信桥 —— 工具栏没有「译」按钮，点翻译直接抛 TypeError。
 *
 * 本脚本在 Node 里按真实顺序（bootstrap.js → ai-translate.js）加载两个脚本，
 * 断言：
 *   1. bootstrap.js 执行完（不触发 load）后，桥就必须已经可用；
 *   2. ai-translate.js 启动时会真的往宿主发出 tr:ready；
 *   3. 万一桥缺失，UI 必须给出可见错误而不是抛异常消失。
 *
 *   node scripts/smoke-webview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${name}${extra ? `  \u2192 ${extra}` : ''}`);
  }
}

const CONFIG = {
  fileUri: 'vscode-webview://x/doc.pdf',
  fileName: 'doc.pdf',
  cMapUrl: 'vscode-webview://x/cmaps/',
  standardFontDataUrl: 'vscode-webview://x/fonts/',
  autoTranslatePageOnScroll: false,
  provider: 'deepseek',
  model: 'deepseek-chat',
  targetLang: '简体中文',
};

/**
 * 造一个最小可用的 Webview 替身环境。
 * withBridge=false 用于模拟 bootstrap.js 失效的场景。
 */
function createSandbox(options = {}) {
  const acquireThrows = !!options.acquireThrows;
  const noop = () => {};
  const posted = [];
  const hostListeners = new Map();
  const optionCalls = [];
  const pdfCalls = { open: 0, load: 0, getDocument: 0 };

  const makeElement = () => ({
    style: {},
    className: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    appendChild: noop,
    insertBefore: noop,
    addEventListener: noop,
    querySelectorAll: () => [],
    contains: () => false,
  });

  const configElement = {
    getAttribute: (name) =>
      name === 'data-config' ? JSON.stringify(CONFIG) : null,
  };

  const originalBody = makeElement();
  const fakeDocument = {
    readyState: 'complete',
    body: originalBody,
    addEventListener: noop,
    createElement: makeElement,
    execCommand: () => false,
    getElementById: (id) => {
      if (id === 'pdf-zh-config') {
        return configElement;
      }
      if (id === 'pdfzh-status' || id === 'pdfzh-title' || id === 'pdfzh-body' || id === 'pdfzh-pop-body') {
        return makeElement();
      }
      return null;
    },
  };

  const fakeWindow = {
    addEventListener: (type, handler) => {
      hostListeners.set(type, handler);
    },
    dispatchEvent: noop,
    // 刻意不立即执行回调，避免 wireViewer 的重试循环把栈打爆
    setTimeout: () => 0,
    onerror: null,
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout,
    PDFViewerApplicationOptions: {
      set: (key, value) => {
        optionCalls.push([key, value]);
      },
    },
    PDFViewerApplication: {
      initializedPromise: Promise.resolve(),
      eventBus: { on: noop, off: noop },
      open: async () => {
        pdfCalls.open += 1;
      },
      load: async () => {
        pdfCalls.load += 1;
      },
      pdfDocument: null,
      pdfViewer: { currentPageNumber: 1 },
    },
    pdfjsLib: {
      getDocument: () => {
        pdfCalls.getDocument += 1;
        return { promise: Promise.resolve({ _pdfInfo: {} }) };
      },
    },
    acquireVsCodeApi: () => {
      if (acquireThrows) {
        throw new Error('模拟：acquireVsCodeApi 此时不可用');
      }
      return { postMessage: (message) => posted.push(message) };
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  return { sandbox, posted, hostListeners, optionCalls, pdfCalls, originalBody };
}

function load(sandbox, rel) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  vm.runInContext(source, sandbox, { filename: rel });
}

async function main() {
  console.log('\n[1] bootstrap.js 必须在脚本加载时同步建立通信桥');
  {
    const { sandbox } = createSandbox();
    load(sandbox, 'lib/bootstrap.js');

    const bridge = sandbox.window.__PDF_ZH__;
    check('window.__PDF_ZH__ 已建立（无需等待 load 事件）', !!bridge);
    check(
      'window.__PDF_ZH__.vscode 可用',
      !!(bridge && bridge.vscode && typeof bridge.vscode.postMessage === 'function'),
    );
    check(
      'window.__PDF_ZH__.config 已注入',
      !!(bridge && bridge.config && bridge.config.fileName === 'doc.pdf'),
      bridge && bridge.config ? JSON.stringify(bridge.config).slice(0, 80) : 'missing',
    );
    check(
      'window.__PDF_ZH_CONFIG__ 兼容别名已设置',
      !!sandbox.window.__PDF_ZH_CONFIG__,
    );
  }

  console.log('\n[2] ai-translate.js 随后应能真正用上通信桥');
  {
    const { sandbox, posted, hostListeners } = createSandbox();
    load(sandbox, 'lib/bootstrap.js');
    load(sandbox, 'lib/ai-translate.js');

    check(
      '启动时向宿主发出 tr:ready',
      posted.some((m) => m && m.type === 'tr:ready'),
      JSON.stringify(posted),
    );
    check(
      '取到 groupParagraphs 纯函数',
      typeof (sandbox.window.__pdfzhInternals || {}).groupParagraphs === 'function',
    );

    const onMessage = hostListeners.get('message');
    check('已注册宿主消息监听', typeof onMessage === 'function');

    // 模拟宿主下发命令：必须被稳定消费，不得抛异常
    for (const cmd of ['show-original', 'translate-page']) {
      let threw = null;
      try {
        onMessage({ data: { type: 'cmd', cmd } });
      } catch (error) {
        threw = error;
      }
      check(`处理宿主命令 cmd=${cmd} 不抛异常`, threw === null, threw && threw.message);
    }
  }

  console.log('\n[3] 桥缺失时必须给出可见错误，而不是静默/抛异常');
  {
    const { sandbox, posted } = createSandbox();
    sandbox.window.__PDF_ZH__ = undefined;
    let threw = null;
    try {
      load(sandbox, 'lib/ai-translate.js');
    } catch (error) {
      threw = error;
    }
    check('启动不抛异常', threw === null, threw && threw.message);
    check('未误发 tr:ready', !posted.some((m) => m && m.type === 'tr:ready'));
  }

  console.log('\n[4] 源码层面：ai-translate.js 不得在顶层捕获 window.__PDF_ZH__');
  {
    const source = fs.readFileSync(path.join(root, 'lib/ai-translate.js'), 'utf8');
    check(
      '没有 `const vscode = ... window.__PDF_ZH__` 之类的顶层捕获',
      !/^\s*const\s+\w+\s*=\s*window\.__PDF_ZH__\b/m.test(source),
    );
    check(
      '没有直接使用未定义的 vscode 标识符',
      !/\bvscode\.postMessage\(/.test(source),
    );
    const bootstrap = fs.readFileSync(path.join(root, 'lib/bootstrap.js'), 'utf8');
    check(
      'bootstrap.js 在 IIFE 顶层（非 load 回调内）写入 window.__PDF_ZH__',
      /^ {2}window\.__PDF_ZH__\s*=/m.test(bootstrap),
    );
    check(
      'bootstrap.js 在 load 回调之前就调用了 acquireVsCodeApi()',
      (() => {
        const callIndex = bootstrap.indexOf('acquireVsCodeApi()');
        const loadIndex = bootstrap.indexOf("'load'");
        return callIndex > 0 && loadIndex > 0 && callIndex < loadIndex;
      })(),
      `acquireVsCodeApi@${bootstrap.indexOf('acquireVsCodeApi()')} load@${bootstrap.indexOf("'load'")}`,
    );

    // 反例验证：证明「把建桥放进 load 回调」确实会导致顶层拿不到 ——
    // 这是本测试存在的前提，避免断言写成了无意义的同义反复。
    const counterSandbox = {
      window: { addEventListener: () => {}, setTimeout: () => 0 },
      document: {},
      console,
    };
    counterSandbox.globalThis = counterSandbox;
    vm.createContext(counterSandbox);
    vm.runInContext(
      "(function(){ window.addEventListener('load', function(){ window.__PDF_ZH__ = { vscode: {} }; }); })();",
      counterSandbox,
    );
    check(
      '反例：建桥若放进 load 回调，同步读取必然拿不到（说明该断言有意义）',
      counterSandbox.window.__PDF_ZH__ === undefined,
    );
  }

  console.log('\n[5] 通信桥获取失败时，绝不能阻断 PDF 加载（历史回归）');
  {
    const ctx = createSandbox({ acquireThrows: true });
    load(ctx.sandbox, 'lib/bootstrap.js');

    const state = ctx.sandbox.window.__PDF_ZH__;
    check('桥为 null（未伪装成功）', state && state.vscode === null);
    check('记录了桥失败原因', !!(state && state.bridgeError), state && state.bridgeError);

    const onLoad = ctx.hostListeners.get('load');
    check('已注册 load 监听', typeof onLoad === 'function');

    let threw = null;
    try {
      await onLoad();
    } catch (error) {
      threw = error;
    }
    check('load 处理不抛异常', threw === null, threw && threw.message);

    check(
      '仍然配置了 cMapUrl（说明越过了配置检查继续启动）',
      ctx.optionCalls.some(([key]) => key === 'cMapUrl'),
      JSON.stringify(ctx.optionCalls.map(([k]) => k)),
    );
    check(
      '仍然配置了 standardFontDataUrl',
      ctx.optionCalls.some(([key]) => key === 'standardFontDataUrl'),
    );
    check(
      '仍然调用了 PDFViewerApplication.open',
      ctx.pdfCalls.open === 1,
      `open=${ctx.pdfCalls.open}`,
    );
    check(
      '仍然调用了 PDFViewerApplication.load',
      ctx.pdfCalls.load === 1,
      `load=${ctx.pdfCalls.load}`,
    );
    check(
      'document.body 未被替换（旧实现会整页换掉、丢失真实报错）',
      ctx.sandbox.document.body === ctx.originalBody,
    );
  }

  console.log('\n[6] 桥正常时，启动路径同样要跑通');
  {
    const ctx = createSandbox();
    load(ctx.sandbox, 'lib/bootstrap.js');
    load(ctx.sandbox, 'lib/ai-translate.js');

    const onLoad = ctx.hostListeners.get('load');
    let threw = null;
    try {
      await onLoad();
    } catch (error) {
      threw = error;
    }
    check('load 处理不抛异常', threw === null, threw && threw.message);
    check('pdf.js 文档已加载', ctx.pdfCalls.load === 1, `load=${ctx.pdfCalls.load}`);
    check(
      'document.body 未被替换',
      ctx.sandbox.document.body === ctx.originalBody,
    );
    check(
      '宿主收到过 tr:ready',
      ctx.posted.some((m) => m && m.type === 'tr:ready'),
    );
  }

  console.log(
    failures === 0
      ? '\nWebview 启动契约测试通过 \u2713\n'
      : `\n有 ${failures} 项未通过 \u2717\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
