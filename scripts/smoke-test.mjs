#!/usr/bin/env node
/*
 * 冒烟测试：不启动 VS Code，直接验证 src/ai/** 的核心链路。
 *
 *   node scripts/smoke-test.mjs
 *
 * 环境变量：
 *   PDF_ZH_API_KEY    有则额外跑「真实 API + 落盘缓存」端到端断言；
 *                     没有则只跑离线断言（分段 / 键 / 解析 / 缓存读写）。
 *   PDF_ZH_PROVIDER / PDF_ZH_MODEL / PDF_ZH_BASE_URL   可选覆盖默认值。
 *
 * 退出码非 0 表示有断言失败，可直接用于 CI。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(rel) {
  const target = path.join(root, 'out', rel);
  if (!fs.existsSync(target)) {
    throw new Error(`缺少编译产物 ${target}，请先运行 npm run compile`);
  }
  return require(target);
}

const { TranslationCache } = load('ai/cache.js');
const { Translator, assertConfigured } = load('ai/translate.js');
const { segKey, normalize } = load('ai/segment.js');
const { parseNumbered, buildSystemPrompt } = load('ai/providers.js');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${name}${extra ? `  \u2192 ${extra}` : ''}`);
  }
}

const CJK = /[\u4e00-\u9fff]/;

async function main() {
  console.log('\n[1] 归一化与缓存键');
  check(
    '空白与引号被规整',
    normalize('  a   b\u00a0c \u2018d\u2019  ') === "a b c 'd'",
    JSON.stringify(normalize('  a   b\u00a0c \u2018d\u2019  ')),
  );

  const baseCfg = {
    provider: process.env.PDF_ZH_PROVIDER || 'deepseek',
    model: process.env.PDF_ZH_MODEL || 'deepseek-chat',
    baseUrl: process.env.PDF_ZH_BASE_URL || '',
    targetLang: '简体中文',
    glossary: { pLDDT: 'pLDDT' },
    maxCharsPerRequest: 6000,
    timeoutMs: 120000,
  };

  const keyA = segKey('The quick brown fox.', baseCfg);
  check('同一文本 → 同一键', segKey('The quick brown fox.', baseCfg) === keyA);
  check(
    '空白差异不影响键',
    segKey('The quick   brown fox.', baseCfg) === keyA,
  );
  check(
    '换模型 → 键失效',
    segKey('The quick brown fox.', { ...baseCfg, model: 'qwen-plus' }) !== keyA,
  );
  check(
    '换目标语言 → 键失效',
    segKey('The quick brown fox.', { ...baseCfg, targetLang: '繁體中文' }) !== keyA,
  );

  console.log('\n[2] 编号协议解析');
  const parsed = parseNumbered('[[1]] 第一段译文\n\n[[2]] 第二段译文\n');
  check('按 [[n]] 切回两段', parsed.size === 2, `size=${parsed.size}`);
  check('第 1 段正确', parsed.get(1) === '第一段译文', JSON.stringify(parsed.get(1)));
  check('第 2 段正确', parsed.get(2) === '第二段译文', JSON.stringify(parsed.get(2)));
  check('提示词包含术语表', buildSystemPrompt(baseCfg).includes('pLDDT'));

  console.log('\n[3] 磁盘缓存读写');
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfzh-smoke-'));
  const cache = new TranslationCache(cacheRoot);
  await cache.init();
  const cacheKey = segKey('cache roundtrip', baseCfg);
  check('未写入前读不到', (await cache.get(cacheKey)) === undefined);
  await cache.put(cacheKey, 'cache roundtrip', '缓存往返');
  check('写入后可读到', (await cache.get(cacheKey)) === '缓存往返');
  await cache.flush();

  const cache2 = new TranslationCache(cacheRoot);
  await cache2.init();
  check('重新打开（模拟重启 VS Code）仍命中', (await cache2.get(cacheKey)) === '缓存往返');
  const seg = await cache2.readSegment(cacheKey);
  check('原文与译文成对保存（导出对照用）', seg && seg.s === 'cache roundtrip' && seg.t === '缓存往返');

  const apiKey = (process.env.PDF_ZH_API_KEY || '').trim();
  if (!apiKey) {
    console.log('\n[4] 真实 API 端到端 —— 跳过（未设置 PDF_ZH_API_KEY）');
    console.log('\n离线断言完成。');
  } else {
    console.log('\n[4] 真实 API 端到端（验证“二次不再烧 token”）');
    assertConfigured(baseCfg, apiKey);
    const translator = new Translator(cache);

    const items = [
      { k: 0, text: 'Protein design seeks sequences that fold into a specified three-dimensional structure.' },
      { k: 1, text: 'We introduce a model that jointly generates sequence and structure without a fixed backbone.' },
    ];
    const signal = new AbortController().signal;

    const first = await translator.run(items, { cfg: baseCfg, apiKey, signal });
    check('首次：两段都拿到译文', first.results.every((r) => r.text && CJK.test(r.text)), JSON.stringify(first.results.map((r) => r.text)));
    check('首次：发生了真实请求', first.usage.requested > 0, `requested=${first.usage.requested}`);
    check('首次：全部来自 API 而非缓存', first.usage.cached === 0, `cached=${first.usage.cached}`);
    check('首次：拿到 token 用量', first.usage.promptTokens > 0 && first.usage.completionTokens > 0);

    const second = await translator.run(items, { cfg: baseCfg, apiKey, signal });
    check('二次：零请求（完全命中缓存）', second.usage.requested === 0, `requested=${second.usage.requested}`);
    check('二次：两段均标记为缓存命中', second.results.every((r) => r.hit === true));
    check('二次：译文与首次完全一致', second.results[0].text === first.results[0].text);
    check('二次：统计到省下的 token', second.usage.estTokensSaved > 0, `estTokensSaved=${second.usage.estTokensSaved}`);
  }

  await cache.flush();
  fs.rmSync(cacheRoot, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\n全部断言通过 \u2713\n'
      : `\n有 ${failures} 条断言失败 \u2717\n`,
  );
  // 注意：这里刻意不用 process.exit()。
  // 在 Windows 上，若 stdout 仍在写出，process.exit() 会触发
  // libuv 的 "!(handle->flags & UV_HANDLE_CLOSING)" 断言崩溃。
  // 设置 exitCode 后自然退出即可。
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('冒烟测试异常终止：', error.message || error);
  process.exitCode = 1;
});
