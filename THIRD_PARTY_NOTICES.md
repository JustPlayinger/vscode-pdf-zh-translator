# 第三方组件声明 / Third-Party Notices

本仓库源码以 **MIT** 许可发布（见 `LICENSE`）。
但 `lib/` 目录内**随仓库分发的** PDF 渲染资源来自 Mozilla 的 PDF.js 预构建发行包，
其版权与许可独立于本项目源码，**以 Apache License 2.0 授权**。以下为逐项说明。

---

## 1. PDF.js（Mozilla Foundation）

- **位置**：`lib/build/pdf.js`、`lib/build/pdf.worker.js`、`lib/web/viewer.js`、
  `lib/web/viewer.html`、`lib/web/viewer.css`、`lib/web/locale/**`、`lib/web/images/**`
- **版本**：2.10.377（build `156762c48`）
- **来源**：<https://github.com/mozilla/pdf.js> — 预构建包 (Prebuilt) <https://mozilla.github.io/pdf.js/getting_started/#download>
- **许可**：Apache License 2.0
- **许可全文**：见 `lib/LICENSE`

```
Copyright 2012 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### 1.1 本项目对 PDF.js 上游文件所做的修改

按 Apache-2.0 第 4 条（保留声明并标注修改），在此声明：

1. **`lib/build/pdf.sandbox.js` 未分发**（本项目不使用沙箱渲染路径）。
2. **`lib/web/debugger.js` 未分发**（调试面板，本项目不启用）。
3. `lib/web/viewer.html` **不在磁盘上被改动**；本项目在运行时于
   `src/pdfPreview.ts` 中读取该文件，并动态完成：
   - 将相对资源引用（`viewer.css` / `locale/locale.properties` / `../build/pdf.js` / `viewer.js`）
     重写为 VS Code Webview 资源 URI；
   - 注入 `Content-Security-Policy`、运行期配置、`pdf.worker.js` 引导脚本与本扩展的 UI 脚本。
4. 新增文件 `lib/bootstrap.js`（引导启动，替代上游 `web/viewer.js` 自带的 URL 参数入口），
   以及本扩展自有资产 `lib/ai-translate.js`、`lib/pdf.css`。
5. 空白占位 `lib/web/standard_fonts/**`、`lib/web/cmaps/**` 保持上游原样，未做改动。

---

## 2. Adobe CMap Resources

- **位置**：`lib/web/cmaps/*.bcmap`（169 个文件）
- **来源**：<https://github.com/adobe-type-tools/cmap-resources>
- **许可**：与 PDF.js 相同的 Apache License 2.0 条款（见 `lib/LICENSE`）

```
Copyright 1990-2015 Adobe Systems Incorporated.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## 3. 标准字体（PDF.js `standard_fonts`）

- **位置**：`lib/web/standard_fonts/**`
- **组成与许可**：
  - **Foxit 字体**（`Foxit*.pfb`）：许可见 `lib/web/standard_fonts/LICENSE_FOXIT`
  - **Liberation 字体**（`LiberationSans-*.ttf`）：SIL Open Font License 1.1，见
    `lib/web/standard_fonts/LICENSE_LIBERATION`
- 上述许可文件均**原样随仓库分发**，未作修改。

---

## 4. 本项目的运行时依赖

**无。** 本扩展不引入任何 npm 运行时依赖：

- HTTP 请求使用 Node.js 内置 `fetch`（Node 18+ / VS Code 内置 Node）
- 哈希使用内置 `node:crypto`
- 缓存持久化使用内置 `node:fs`（分片 JSON，不引入数据库）

`devDependencies`（`typescript`、`@types/vscode`、`@types/node`、`@vscode/vsce`）
仅用于开发与打包，不会被分发。

---

## 5. 用户自行配置的第三方服务

扩展会把你**主动配置**的文本发送到你在设置中选定的翻译服务商
（如 DeepSeek、阿里云百炼、Moonshot、智谱、OpenAI、Ollama 或 Google 公共端点）。
这些服务的条款与隐私政策由其各自提供方约束，与本项目无关。
如需完全离线，请选择 `pdf-zh.provider: "ollama"`。
