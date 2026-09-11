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

/** 用替身 DOM 加载 ai-translate.js，取出 groupParagraphs 纯函数。 */
function loadGroupParagraphs() {
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
  if (!internals || typeof internals.groupParagraphs !== 'function') {
    throw new Error('未能从 lib/ai-translate.js 取到 groupParagraphs（内部暴露点被改动？）');
  }
  return internals.groupParagraphs;
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

  console.log('\n[1] 加载 pdf.js 与 groupParagraphs');
  const pdfjsLib = require(path.join(root, 'lib/build/pdf.js'));
  // 让 pdf.js 走「主线程假 worker」，避免在 Node 里真的去 new Worker()
  globalThis.pdfjsWorker = require(path.join(root, 'lib/build/pdf.worker.js'));
  const groupParagraphs = loadGroupParagraphs();
  check(`pdf.js 版本 ${pdfjsLib.version}`, typeof pdfjsLib.getDocument === 'function');
  check('取得 groupParagraphs 纯函数', typeof groupParagraphs === 'function');

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

    const paragraphs = groupParagraphs(items);
    check(`${label} 抽出至少 3 段`, paragraphs.length >= 3, `paragraphs=${paragraphs.length}`);
    check(
      `${label} 每段都是非空字符串`,
      paragraphs.every((p) => typeof p === 'string' && p.trim().length >= 2),
    );
    check(
      `${label} 无孤立页码残留`,
      paragraphs.every((p) => !/^\d{1,4}$/.test(p.trim())),
    );
    check(
      `${label} 无 U+FFFD 等损坏字符`,
      paragraphs.every((p) => !p.includes('\uFFFD') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p)),
    );
    check(
      `${label} 段落含空格（不是把所有字挤成一坨）`,
      paragraphs.filter((p) => p.includes(' ')).length >= Math.min(3, paragraphs.length),
    );

    // 关键：同一输入必须得到逐字节相同的输出，否则缓存键会漂移
    const again = groupParagraphs(items);
    check(
      `${label} 切分稳定（两次结果完全一致 → 缓存键不会漂移）`,
      JSON.stringify(again) === JSON.stringify(paragraphs),
    );

    console.log(`      样例（前 3 段）：`);
    for (const p of paragraphs.slice(0, 3)) {
      console.log(`        · ${sanitize(p)}`);
    }
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
