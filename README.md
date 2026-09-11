# PDF 中文翻译阅读器 / vscode-pdf-zh-translator

> 在 VS Code 里直接读英文 PDF 论文并译成中文：**划词 / 整页 / 整篇**中英对照，
> 译文**落盘持久化**，同一段永不重复计费。

![CI](https://github.com/JustPlayinger/vscode-pdf-zh-translator/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.85-007ACC)

---

## 为什么需要它

在 VS Code 里读论文的人通常有这么一套流程：用一个 PDF 预览插件看原文，
再开浏览器用翻译插件看译文，两边来回切。想省事的人会随手把 PDF 丢给在线翻译，
结果公式乱了、图表标题没了、术语被译成了莫名其妙的词。

已有的 Markdown 增强插件（如 `markdown-preview-enhanced`）虽然自带 AI 翻译，
但**它的译文只存在内存里**：关掉预览、重开文件，一切重来，token 又烧一遍。
而 PDF 论文动辄几十页，一次整篇翻译就是几万 token。

本项目针对这两点重新设计：

1. **翻译发生在阅读器内部**，原文与译文逐段对照，不切窗口；
2. **译文按“内容”寻址落盘**，重新打开文件、换目录、甚至换一篇论文，
   只要段落内容相同就直接复用。

---

## 功能

| 能力 | 说明 |
|---|---|
| **原位覆盖** | 译文**直接覆盖在原文位置上**，位置来自 pdf.js 文本层的真实布局，缩放/翻页后自动重算。默认开启 |
| 一键回退 | 面板「覆盖」按钮或「原文」按钮可随时关掉覆盖，立刻露出英文原文 |
| 划词翻译 | 在 PDF 里选中文字 → 浮窗点「翻译」，译文就地弹出 |
| 整页对照 | 右侧面板按段落给出中英对照，可切换显示英文原文 |
| 整篇翻译 | 逐页翻译，带进度、可随时中止、二次确认防误触 |
| **持久化缓存** | 段落级内容寻址，落在扩展的 `globalStorage`，**不写只读的论文目录** |
| 零成本导出 | 直接复用缓存导出中英对照 / 纯中文 Markdown，**不产生任何 API 调用** |
| 术语保真 | 内置提示词强制保留公式、基因名、方法名、缩写、单位；支持自定义术语表 |
| 多服务商 | DeepSeek / 通义 / Kimi / 智谱 / OpenAI / Ollama(本地离线) / Google(免 Key) |
| 密钥安全 | API Key 存 VS Code `SecretStorage`（系统加密），不落 `settings.json` |
| 只读安全 | 只读编辑器，**绝不回写你的 PDF**；缓存与导出都在别处 |
| 共存无冲突 | 以 `priority: "option"` 注册，双击 PDF 仍由你原来的阅读器打开 |

---

## 快速开始

1. 安装扩展（VSIX 或商店，见「安装」一节）。
2. 右键任意 PDF → **PDF中文: 用翻译阅读器打开**（或命令面板执行同名命令）。
3. 命令面板执行 **PDF中文: 设置 AI 翻译 API Key**，粘贴你的密钥。
   *默认服务商是 DeepSeek，去 <https://platform.deepseek.com> 申请即可，价格很低。*
4. 点工具栏上的 **「译」** 打开右侧面板 → 点 **译本页**。

> 只想试试水？把 `pdf-zh.provider` 设为 `"google"` 可以**不填 Key** 直接翻译，
> 走的是公共端点，会限流、可能不稳，仅适合验证效果。

---

## 翻译服务商

| provider | 默认端点 | 需要 Key | 说明 |
|---|---|---|---|
| `deepseek`（默认） | `api.deepseek.com/v1` | ✅ | 便宜，中文学术语感好 |
| `dashscope` | `dashscope.aliyuncs.com/compatible-mode/v1` | ✅ | 阿里云百炼（通义千问） |
| `moonshot` | `api.moonshot.cn/v1` | ✅ | Kimi |
| `zhipu` | `open.bigmodel.cn/api/paas/v4` | ✅ | 智谱 GLM |
| `openai` | `api.openai.com/v1` | ✅ | OpenAI |
| `ollama` | `localhost:11434/v1` | ❌ | **完全本地离线**，如 `qwen2.5:7b` |
| `google` | `translate.googleapis.com` | ❌ | 公共端点，零配置回退 |
| `custom` | 自填 `pdf-zh.baseUrl` | 视情况 | 任何 OpenAI 兼容服务 |

除 `google` 外全部走 **OpenAI 兼容的 `/chat/completions`**，
所以换服务商只需要改三个字段：`provider` / `model` / `baseUrl`。

---

## 覆盖模式：译文原位替换原文

这是默认的阅读方式：**译文直接盖在英文原来的位置上**，版面、图表、公式都保持原位。

### 它怎么做到对齐

PDF 里的英文是**画在 canvas 上的像素**，DOM 里删不掉。所以「覆盖」的做法是：
在每个段落的外接矩形上放一块不透明的译文盒子，把底下的英文遮住。

关键在对齐。本项目没有自己去算 PDF 坐标系，而是**直接读 pdf.js 文本层 span 的真实布局**：

```
.page
├─ .canvasWrapper > canvas     ← 英文像素画在这里
├─ .textLayer                  ← pdf.js 生成的定位 span（opacity: 0.2，不可见）
└─ .pdfzh-overlay-layer        ← 我们挂的覆盖层，与 span 同一坐标系
```

因为覆盖层和 span 都挂在 `.page` 上，用 `getBoundingClientRect()` 取到的矩形
天然就是同一套坐标，**不需要任何手工换算**，缩放、翻页、窗口变化后重算即可保持对齐。

于是：

- **段落矩形** = 该段所有 span 矩形的并集；
- **字号** = 该段行高的中位数（避免被上标/下标带偏）；
- **背景色** = 在矩形外侧 4 个点采样 canvas，取最亮的那个当作纸张底色
  （浅灰底、米色底的老论文也不会露白边）；
- **放不下就自动缩小字号**，最多迭代 24 次。

### 几个刻意的取舍

| 情况 | 行为 | 为什么 |
|---|---|---|
| 段落还没翻译 | **不遮挡** | 方便对照原意，也避免误以为"原文没了" |
| 字号 < `overlay.minFontSize` | 不覆盖 | 多半是图注、坐标轴刻度、页眉页脚，覆盖反而更难读 |
| 页面有旋转 | 不覆盖 | 旋转后 span 带 `transform`，矩形换算需要另一套逻辑 |
| 整篇翻译时未渲染的页 | 只翻译、暂不覆盖 | 滚动到该页、文本层就绪后自动补上覆盖（**命中缓存，不重复计费**） |
| 两个来源切分出的段数不一致 | 保守跳过覆盖重算并告警 | 避免把已翻译的译文按下标错位映射到别的段落 |

> 想看回英文？点面板上的 **「原文」**，或把 **「覆盖」** 关掉。
> 也可以在设置里把 `pdf-zh.overlay.enabled` 设为 `false`，只保留右侧对照面板。

---

## 它到底怎么省 token

这是本项目与「随手调一次翻译接口」的本质区别。

```
抽段落 → 归一化 → 算内容哈希 → 查磁盘缓存
                                   ├─ 命中 → 直接返回，0 token
                                   └─ 未命中 → 合并成一次请求 → 写回磁盘
```

**1. 内容寻址，而不是文件寻址。**
缓存键是
`sha1(归一化文本 + provider + model + 目标语言 + 提示词版本)`。
于是：

- 同一段话在正文、SI、其它论文里重复出现 → 直接复用；
- 论文改名、移动目录、换电脑同步 → 依然命中；
- 换了模型或改了提示词 → 自动失效，不会拿到质量不一致的旧译文。

**2. 同批去重。** 一次翻译里重复出现的段落只请求一次。

**3. 批量合并。** 多段打包进一次调用（`[[1]]…[[2]]…` 编号协议），
显著降低往返次数与提示词开销；模型漏编号时自动逐段重试。

**4. 按需翻译。** 默认只译当前页；整篇翻译需要二次确认；
滚动自动翻译默认**关闭**，避免无人值守时烧额度。

**5. 失败不落盘。** 报错或空结果不会写进缓存，避免污染。

**6. 可观测。** 「统计」按钮显示缓存段落数、命中/未命中次数、
以及**累计估算省下的 token**。

**7. 导出零成本。** 缓存里同时保存了原文与译文，
所以导出中英对照 Markdown 只是把已有内容拼起来 —— 不会再调用任何 API。

---

## 命令

| 命令 | 说明 |
|---|---|
| `PDF中文: 用翻译阅读器打开` | 用本扩展打开 PDF（资源管理器右键可用） |
| `PDF中文: 设置 AI 翻译 API Key` | 写入 VS Code SecretStorage |
| `PDF中文: 翻译当前页` | 只译当前页，已缓存段落自动跳过 |
| `PDF中文: 翻译整篇（消耗 token）` | 逐页翻译，带二次确认与进度 |
| `PDF中文: 显示原文` | 在对照面板中切换英文原文 |
| `PDF中文: 导出中英对照 Markdown` | 选择「中英对照 / 仅中文」后导出 |
| `PDF中文: 查看翻译缓存统计` | 命中率与节省的 token 估算 |
| `PDF中文: 清除翻译缓存` | 可按当前文件或全部清除 |

---

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `pdf-zh.provider` | `deepseek` | 服务商，见上表 |
| `pdf-zh.model` | `deepseek-chat` | 模型 ID，如 `qwen-plus`、`glm-4-flash`、`qwen2.5:7b` |
| `pdf-zh.baseUrl` | 空 | 仅 `custom` 时必填，形如 `https://example.com/v1` |
| `pdf-zh.targetLang` | `简体中文` | 目标语言，会写入提示词 |
| `pdf-zh.glossary` | `{}` | 术语表 `{"关键词":"指定译法"}`；写 `{"pLDDT":"pLDDT"}` 可强制不译 |
| `pdf-zh.maxCharsPerRequest` | `6000` | 单次请求最多打包多少字符 |
| `pdf-zh.timeoutMs` | `120000` | 单次请求超时（毫秒） |
| `pdf-zh.autoTranslatePageOnScroll` | `false` | 翻页自动翻译；默认关闭以免烧额度 |
| `pdf-zh.overlay.enabled` | `true` | 译文**原位覆盖**原文；关闭则只用右侧对照面板 |
| `pdf-zh.overlay.fontScale` | `1` | 覆盖译文的字号倍率（相对原文字号），放不下会自动继续缩小 |
| `pdf-zh.overlay.padding` | `1` | 覆盖块向外扩张的像素，用于盖住字形边缘；相邻段落太近可调到 `0` |
| `pdf-zh.overlay.minFontSize` | `6` | 低于此字号（px）不做覆盖，避开图注与坐标轴刻度 |
| `pdf-zh.cacheDir` | 空 | 自定义缓存目录；留空用扩展 `globalStorage` |

示例：

```jsonc
{
  "pdf-zh.provider": "deepseek",
  "pdf-zh.model": "deepseek-chat",
  "pdf-zh.glossary": {
    "backbone": "骨架",
    "pLDDT": "pLDDT",
    "ESM-2": "ESM-2"
  },
  "pdf-zh.autoTranslatePageOnScroll": false
}
```

### 缓存放在哪

默认在扩展的全局存储目录（Windows 下类似）：

```
%APPDATA%\Code\User\globalStorage\JustPlayinger.pdf-zh-translator\translation-cache\
├─ meta.json                    缓存格式版本
├─ seg\<a>\<b>\<sha1>.json      {"s":原文,"t":译文,"ts":…}
├─ doc\<sha1>.json              文档 → 页 → 段落键
└─ stats.json                   命中 / 未命中 / 节省统计
```

**它永远不会写入你的论文所在目录**，因此论文只读也完全没问题。
想放到别处（例如同步盘）就设置 `pdf-zh.cacheDir`。

---

## 安装

### 方式一：VSIX

```bash
npm install
npm run package          # 生成 pdf-zh-translator-0.1.0.vsix
code --install-extension pdf-zh-translator-0.1.0.vsix
```

也可以从 [Releases](https://github.com/JustPlayinger/vscode-pdf-zh-translator/releases)
下载构建好的 `.vsix`，在 VS Code 的「扩展 → … → 从 VSIX 安装」中选择。

### 方式二：源码调试

在 VS Code 中打开本仓库，按 <kbd>F5</kbd> 启动 Extension Development Host，
在新窗口里打开任意 PDF 即可。

---

## 与其它方案的关系

| 方案 | 能做什么 | 做不到 |
|---|---|---|
| 浏览器翻译插件 | 整页 HTML 翻译，效果好 | 不在 VS Code 内；PDF 场景要先把论文导出成网页 |
| `markdown-preview-enhanced` | Markdown 预览内 AI 翻译，填 Key 即用 | **译文只在内存**，关掉预览即丢，重开重译 |
| 在线 PDF 翻译网站 | 整篇出中文 PDF | 要上传论文（隐私/版权）；公式与版式常有损 |
| **本项目** | PDF 内划词/整页/整篇对照 + **落盘缓存** + 零成本导出 | 扫描件无文本层时需先 OCR（见下） |

本项目**不抢占**默认 PDF 打开方式：它用 `priority: "option"` 注册，
双击 PDF 依旧是你原来的阅读器，需要翻译时右键选「PDF中文: 用翻译阅读器打开」。
（同样的机制也用于 `markdown-preview-enhanced`。）

---

## 已知限制

1. **扫描件**：没有文本层的 PDF 抽不出文字，会明确提示「可能是扫描件」，暂不支持 OCR。
2. **双栏排版**：段落归并是启发式的（按 y 坐标 + 行距），偶发跨栏合并。
   遇到时可先只译单页核对，或调整 `pdf-zh.maxCharsPerRequest`。
3. **机器翻译定位**：导出稿是**参照稿**，公式、术语、专有名词仍可能出错，
   引用或写作前请回到原文核对。导出文件顶部会自动附上这句提醒。
4. **密钥需自行申请**，本项目不提供任何内置额度。
5. `google` 端点为非官方的公共接口，随时可能失效或限流，仅作零配置回退。

---

## 开发

```bash
npm install

npm run compile        # TypeScript → out/
npm run check          # 校验 viewer.html 替换锚点 + 命令/配置与源码是否一致
npm run smoke          # 离线断言；设置 PDF_ZH_API_KEY 后会跑真实 API 端到端
npm run smoke:pdf -- 某篇.pdf   # 用真实 PDF 验证段落抽取与切分稳定性
npm run verify         # compile + check + smoke

npm run watch          # 增量编译
npm run package        # 打包 VSIX
npm run make-icon      # 重新生成 media/icon.png
npm run sync-lib       # 重新同步 lib/ 下的 pdf.js 静态资源
```

### 结构

```
src/
  extension.ts          命令注册与激活
  pdfProvider.ts        自定义编辑器 Provider（priority: option）
  pdfPreview.ts         HTML 装配 + 宿主侧消息桥 + 导出
  config.ts             设置读取、SecretStorage、缓存目录解析
  log.ts                Output 面板日志（脱离 VS Code 也能加载）
  ai/
    types.ts            共享类型
    segment.ts          归一化 / 内容哈希 / 提示词版本
    cache.ts            分片 JSON 磁盘缓存（原子写 + 统计）
    providers.ts        OpenAI 兼容适配 + Google 回退 + [[n]] 协议解析
    translate.ts        批量编排、去重、重试、中止
lib/                    随仓库分发的 PDF.js 静态资源 + Webview 侧 UI
  bootstrap.js          启动 pdf.js
  ai-translate.js       对照面板 / 划词浮窗 / 段落抽取
  pdf.css               面板与浮窗样式
scripts/                校验、冒烟测试、资源同步、图标生成
```

**架构上的一个关键决定**：文本抽取在 Webview（那里才有 pdf.js 文本层），
而网络请求在扩展宿主（Node 侧）执行。带来的好处是
Webview 的 CSP 无需放宽 `connect-src`，且 **API Key 永不进入 Webview**。

---

## 贡献

欢迎 Issue 与 PR。提交前请确保 `npm run verify` 通过。

`lib/` 下的 PDF.js 资源是上游发行包，改动请通过 `scripts/sync-lib.ps1` 重新同步，
不要手工编辑；本项目对上游的改动已在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中声明。

---

## 许可

源码以 [MIT](LICENSE) 发布。
`lib/` 目录内随仓库分发的 PDF.js 相关资源为 Apache License 2.0，
版权归属与修改说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

