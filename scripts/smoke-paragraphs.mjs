#!/usr/bin/env node
/*
 * 用真实 PDF 验证 Webview 侧的「段落抽取」逻辑。
 *
 * 这是全项目最容易出错、也最容易被忽略的一环：段落切分一旦不稳定，
 * 缓存键就会漂移，于是「同一篇论文每次重开都要重新烧 token」。
 *
 * 做法：
 *   1. 在 Node 中加载随仓库分发的 pdf.js（lib/build/pdf.js）真正解析 PDF；
 *   2. 用 node:vm 在替身 window/document 上加载 lib/ai-translate.js，
 *      取出其中的纯函数 groupParagraphs（为可测性挂到了 window.__pdfzhInternals）；
 *   3. 把 pdf.js 的真实 textContent.items 喂进去，断言输出是稳定、合理的段落。
 *
 *   node scripts/smoke-paragraphs.mjs <某个.pdf> [更多.pdf ...]
 *
 * 未传入 PDF 时直接跳过（退出码 0），便于在 CI 中无样本运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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

/** 用替身 DOM 加载 ai-translate.js，取出内部纯函数。 */
function loadInternals() {
  const source = fs.readFileSync(path.join(root, 'lib/ai-translate.js'), 'utf8');
  const noop = () => {};

  const makeElement = () => ({
    style: {},
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    appendChild: noop,
    insertBefore: noop,
    addEventListener: noop,
    querySelectorAll: () => [],
    contains: () => false,
    textContent: '',
    innerHTML: '',
  });

  const fakeDocument = {
    readyState: 'complete',
    body: makeElement(),
    addEventListener: noop,
    getElementById: (id) => {
      if (id === 'pdfzh-status' || id === 'pdfzh-title' || id === 'pdfzh-body') {
        return makeElement();
      }
      return null;
    },
    createElement: makeElement,
    execCommand: () => false,
  };

  const fakeWindow = {
    addEventListener: noop,
    dispatchEvent: noop,
    setTimeout: () => 0,
    confirm: () => false,
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'lib/ai-translate.js' });

  const internals = fakeWindow.__pdfzhInternals;
  const required = ['groupParagraphs', 'glyphsFromPdfItems', 'glyphsFromTextLayer', 'paragraphBox'];
  for (const name of required) {
    if (!internals || typeof internals[name] !== 'function') {
      throw new Error(`未能从 lib/ai-translate.js 取到 ${name}（内部暴露点被改动？）`);
    }
  }
  return internals;
}

async function textItemsOf(pdfjsLib, file, pageNo) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  try {
    if (pageNo > doc.numPages) {
      return { items: [], numPages: doc.numPages };
    }
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    return { items: content.items, numPages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

function sanitize(text) {
  return text.replace(/\s+/g, ' ').slice(0, 110);
}

async function main() {
  const targets = process.argv.slice(2).filter((p) => fs.existsSync(p));
  if (targets.length === 0) {
    console.log('\n未提供 PDF 样本，跳过段落抽取测试。');
    console.log('用法： node scripts/smoke-paragraphs.mjs <某个.pdf>\n');
    return;
  }

  console.log('\n[1] 加载 pdf.js 与内部纯函数');
  const pdfjsLib = require(path.join(root, 'lib/build/pdf.js'));
  // 让 pdf.js 走「主线程假 worker」，避免在 Node 里真的去 new Worker()
  globalThis.pdfjsWorker = require(path.join(root, 'lib/build/pdf.worker.js'));
  const internals = loadInternals();
  const { groupParagraphs, glyphsFromPdfItems } = internals;
  check(`pdf.js 版本 ${pdfjsLib.version}`, typeof pdfjsLib.getDocument === 'function');
  check('取得内部纯函数', typeof groupParagraphs === 'function');
  check('取得 glyphsFromPdfItems', typeof glyphsFromPdfItems === 'function');

  console.log('\n[2] 真实 PDF 段落抽取');
  for (const file of targets) {
    const label = path.basename(file);
    let items;
    let numPages;
    try {
      ({ items, numPages } = await textItemsOf(pdfjsLib, file, 1));
    } catch (error) {
      check(`${label} 可被 pdf.js 解析`, false, error.message);
      continue;
    }
    check(`${label} 可被 pdf.js 解析（共 ${numPages} 页）`, numPages > 0);
    check(`${label} 第 1 页有文本层（非扫描件）`, items.length > 0, `items=${items.length}`);

    const paragraphs = groupParagraphs(glyphsFromPdfItems(items));
    check(`${label} 抽出至少 3 段`, paragraphs.length >= 3, `paragraphs=${paragraphs.length}`);
    check(
      `${label} 每段都有非空文本`,
      paragraphs.every((p) => p && typeof p.text === 'string' && p.text.trim().length >= 2),
    );
    check(
      `${label} 每段都有正数字号`,
      paragraphs.every((p) => typeof p.fontSize === 'number' && p.fontSize > 0),
      JSON.stringify(paragraphs.slice(0, 3).map((p) => p.fontSize)),
    );
    check(
      `${label} 无孤立页码残留`,
      paragraphs.every((p) => !/^\d{1,4}$/.test(p.text.trim())),
    );
    check(
      `${label} 无 U+FFFD 等损坏字符`,
      paragraphs.every(
        (p) => !p.text.includes('\uFFFD') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p.text),
      ),
    );
    check(
      `${label} 段落含空格（不是把所有字挤成一坨）`,
      paragraphs.filter((p) => p.text.includes(' ')).length >= Math.min(3, paragraphs.length),
    );

    // 关键：同一输入必须得到逐字节相同的输出，否则缓存键会漂移
    const again = groupParagraphs(glyphsFromPdfItems(items));
    check(
      `${label} 切分稳定（两次结果完全一致 → 缓存键不会漂移）`,
      JSON.stringify(again) === JSON.stringify(paragraphs),
    );

    console.log(`      样例（前 3 段）：`);
    for (const p of paragraphs.slice(0, 3)) {
      console.log(`        · ${sanitize(p.text)}`);
    }
  }

  console.log('\n[3] 覆盖模式的几何计算（译文原位对齐的关键）');
  {
    const { glyphsFromTextLayer, paragraphBox: boxOf } = internals;

    const rect = (left, top, width, height) => ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    });
    const span = (text, r, fontSize) => ({
      textContent: text,
      style: { fontSize: fontSize + 'px' },
      getBoundingClientRect: () => r,
    });

    // 页面左上角在视口 (100, 50)，因此页面内坐标 = 视口坐标 - (100, 50)
    const pageEl = { getBoundingClientRect: () => rect(100, 50, 612, 792) };
    // 注意：querySelectorAll 必须每次返回**同一批对象**，否则无法校验节点引用是否被保留
    const spans = [
      span('Hello', rect(120, 100, 40, 10), 10),
      span('world', rect(165, 100, 35, 10), 10),
      // 第二行与第一行只差 12px → 应并入同一段（行距阈值 = 字号 × 1.8 = 18）
      span('Second', rect(120, 112, 45, 10), 10),
    ];
    const layerEl = { querySelectorAll: () => spans };

    const glyphs = glyphsFromTextLayer(layerEl, pageEl);
    check('span → glyph 数量正确', glyphs.length === 3, `len=${glyphs.length}`);
    check('x 已换算为页面内坐标', Math.abs(glyphs[0].x - 20) < 1e-6, String(glyphs[0].x));
    check('y 取负（统一为「向上为正」）', Math.abs(glyphs[0].y - -50) < 1e-6, String(glyphs[0].y));
    check('h 取自 span 的 fontSize', glyphs[0].h === 10, String(glyphs[0].h));
    check('w 取自 span 宽度', glyphs[0].w === 40, String(glyphs[0].w));
    check('保留了 span 节点引用（供定位用）', glyphs[0].node === spans[0]);

    const paras = groupParagraphs(glyphs);
    check('三行聚成一段', paras.length === 1, `len=${paras.length}`);
    check(
      '段落文本按行拼接并补空格',
      paras[0].text === 'Hello world Second',
      JSON.stringify(paras[0].text),
    );
    check('段落保留全部 span 节点', paras[0].nodes.length === 3, `nodes=${paras[0].nodes.length}`);

    const box = boxOf(paras[0], pageEl);
    check('外接矩形 left 正确', Math.abs(box.left - 20) < 1e-6, String(box.left));
    check('外接矩形 top 正确', Math.abs(box.top - 50) < 1e-6, String(box.top));
    check('外接矩形宽度取并集', Math.abs(box.width - 80) < 1e-6, String(box.width));
    check('外接矩形高度取并集', Math.abs(box.height - 22) < 1e-6, String(box.height));

    // 远离的行必须切成两段，否则覆盖块会横跨整页。
    // 文本要足够长：分组末尾会过滤掉长度 < 2 的片段（页码、孤立符号）。
    const farSpans = [
      span('Alpha', rect(120, 100, 40, 10), 10),
      span('Beta', rect(120, 300, 40, 10), 10),
    ];
    const farParas = groupParagraphs(
      glyphsFromTextLayer({ querySelectorAll: () => farSpans }, pageEl),
    );
    check('行距过大时切成两段', farParas.length === 2, `len=${farParas.length}`);

    check('没有 span 节点时 paragraphBox 返回 null', boxOf({ nodes: [] }, pageEl) === null);
    check('缺少页面元素时 paragraphBox 返回 null', boxOf(paras[0], null) === null);
  }

  console.log(
    failures === 0 ? '\n段落抽取测试通过 \u2713\n' : `\n有 ${failures} 项未通过 \u2717\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('段落抽取测试异常终止：', error.message || error);
  process.exitCode = 1;
});
