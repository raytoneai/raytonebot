# Sandbox 本地工具箱调研

调研日期：2026-10-04。范围：Linux sandbox 中，Agent 通过现有 shell/read 工具使用的开源工具；harness 提供一份可发现、可照着执行的本地清单。本轮只查官方资料与项目源码，没有安装、部署或进行真实文件兼容性测试。

## 结论

建议采用 **预装 CLI + 一份短工具清单 + 按需读取的用法文件**。继续使用现有 Bash 工具、审批和文件产物入口，不需要为每个软件增加模型工具定义，也不需要新增服务。

优先试点 **iOfficeAI/OfficeCLI**：它把 DOCX/XLSX/PPTX 的读写统一为 CLI，并提供 JSON 输出，很符合“Agent 看清单就能用”的方向。Office→PDF 使用 LibreOffice 补充；PDF 提取/拆合、数据查询、图片处理各选成熟专用命令。先用代表性文件验证这个组合，再扩大预装范围。[OfficeCLI 官方仓库](https://github.com/iOfficeAI/OfficeCLI)、[LibreOffice 命令行参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

## 候选工具与选择

“轻/中/重”仅表示相对依赖与部署复杂度，不是安装大小或性能实测；均应在目标 Linux 镜像固定版本后测量。Office/PDF 的细节、许可证和命令例子见 [专项调研](local-tools-office-research.md)。

| 能力 | 候选工具 / 官方资料 | Agent 使用方式 | 成本与边界 | 建议 |
| --- | --- | --- | --- | --- |
| Word / Excel / PPT 读写 | [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | `create/get/query/set/add/remove/batch/validate`，支持 JSON | 核心为自含二进制；截图另需浏览器。其公式计算与 HTML 渲染不能直接等同于 Microsoft Office 的结果 | 第一批试点，先验证我们常用文件 |
| Office 转 PDF / 格式转换 | [LibreOffice headless](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) | `soffice --headless --convert-to …` | 较重，需字体和可写用户配置目录；复杂排版、宏及公式兼容性按文件验证 | 第一批补充转换能力 |
| Markdown / HTML / DOCX 互转 | [Pandoc](https://pandoc.org/MANUAL.html) | 原生 CLI，可用 reference DOCX 模板 | 中；适合从内容生成文档，往返转换不保证保留所有 Office 格式；PDF 另需渲染引擎 | 第一批文档生成 |
| 文档转可读文本 | [MarkItDown](https://github.com/microsoft/markitdown) | 文档转 Markdown 的 Python CLI | 按格式选依赖；本地转换与需外部服务的可选能力分开。它不负责编辑 Office | 第一批抽取，可按需求缩减 extras |
| PDF 提取 / 页面图像 | [Poppler](https://poppler.freedesktop.org/) | `pdftotext`、`pdfinfo`、`pdftoppm` | 中；原生 CLI。扫描 PDF 没有文字层时需 OCR；表格文本不等于结构化表格 | 第一批 |
| PDF 拆分 / 合并 / 检查 | [qpdf](https://qpdf.readthedocs.io/en/stable/cli.html) | 页码选择、合并、`--check`、JSON 检查 | 轻至中；处理 PDF 结构，不是正文排版编辑器，也不做 OCR | 第一批 |
| CSV / JSON / Parquet 分析 | [DuckDB CLI](https://duckdb.org/docs/current/clients/cli/overview) | SQL 查询本地文件，输出 JSON / CSV / Markdown | 轻至中；独立命令，无需数据库服务。第一批只用预装能力，额外扩展另处理 | 第一批 |
| JSON / YAML / XML 处理 | [jq](https://jqlang.org/manual/)、[mikefarah/yq](https://github.com/mikefarah/yq) | 过滤、变换、校验，便于管道组合 | 轻；固定为 Go 实现的 mikefarah/yq，避免与同名 Python 包混用 | jq 第一批；yq 有配置文件需求时加 |
| 图片尺寸 / 裁切 / 转格式 | [ImageMagick](https://imagemagick.org/magick/) | `magick`、`magick identify` | 中；部分格式需要 delegate。固定主版本，v6/v7 命令名不同；PDF 渲染优先交 Poppler | 第一批基础图片能力 |
| 扫描件 OCR | [Tesseract](https://tesseract-ocr.github.io/tessdoc/)、[OCRmyPDF](https://ocrmypdf.readthedocs.io/en/latest/) | 图片→文字；给 PDF 增加可搜索文字层 | 中至重；预装 `eng` / `chi_sim`，繁体按需；OCRmyPDF 另有原生依赖 | 第二批，扫描件成为常见输入时加 |
| 网页操作 / 截图 | [Microsoft playwright-cli](https://github.com/microsoft/playwright-cli) | 页面快照、元素引用、click/fill/screenshot | 浏览器依赖重；CLI 调用会维护本地浏览器会话。安装不代表已有外网访问权限 | 第二批，浏览器工具只选一个 |
| 网页操作替代候选 | [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) | `snapshot -i --json`、`@e…` 元素引用、截图 | 同样需浏览器；JSON 交互友好，普通 CLI 模式不需要 MCP | 与 playwright-cli 比较实际成功率后选一 |
| 音视频提取 / 转码 / 元信息 | [FFmpeg / ffprobe](https://ffmpeg.org/ffprobe.html) | 命令处理音视频，ffprobe 输出 JSON | 中；转码 CPU 开销取决于输入和编码参数 | 第二批，出现实际音视频需求时加 |

许可概览：OfficeCLI、playwright-cli 为 Apache-2.0；DuckDB、mikefarah/yq 为 MIT；jq 主程序为 MIT（文档/部分依赖另有许可）；ImageMagick 使用自身开源许可；FFmpeg 的 LGPL/GPL 取决于构建选项。安装时保存所选版本的 LICENSE/NOTICE，不用项目名推断整个二进制包的许可。[DuckDB](https://github.com/duckdb/duckdb)、[jq](https://github.com/jqlang/jq#license)、[ImageMagick](https://imagemagick.org/license/)、[FFmpeg](https://ffmpeg.org/legal.html)

## Office 工具如何分工

推荐路径是：读取 Office → OfficeCLI / MarkItDown；修改单元格、段落、幻灯片 → OfficeCLI；从 Markdown 生成报告 → Pandoc；Office 文件交付前导出 PDF → LibreOffice；检查页数/抽文字/生成预览图 → Poppler。各工具承担明确步骤，避免让 Agent 同时在数个功能重叠的软件间猜测。

Python 的 `python-docx`、`openpyxl`、`python-pptx` 和 Node 的 PptxGenJS 是库，适合脚本生成、模板填充或 CLI 没覆盖的操作，不能写成“安装后直接有同名通用 CLI”。可预装需要的库并提供少量示例脚本，初期不自建一整套统一 Office SDK。特别是 openpyxl **不会计算公式**，读取缓存结果和重算是两件事。[python-docx](https://python-docx.readthedocs.io/en/latest/)、[openpyxl 公式说明](https://openpyxl.readthedocs.io/en/stable/simple_formulae.html)、[python-pptx](https://python-pptx.readthedocs.io/en/latest/)、[PptxGenJS](https://gitbrent.github.io/PptxGenJS/)

OfficeCLI 有自己的公式与 HTML 渲染实现，适合试点，但需要验证常用公式、中文字体、图表和既有文档保存后的变化；生成 HTML 成功不是 Office 排版无损的证据。若使用其驻留模式，交给 LibreOffice 或下载前先按所选版本要求 save/close，确保修改已经落盘。具体依赖和运行约束见专项调研。

部署固定版本后，OfficeCLI 应关闭自动更新：官方提供 `officecli config autoUpdate false`，或在入口包装中使用 `OFFICECLI_SKIP_UPDATE=1`。截图源码表明浏览器并未内嵌，部分预览还可能依赖 CDN 字体/KaTeX；因此“核心 CLI 可离线”不代表截图已完整离线。PDF 导出也有 exporter 插件路径，第一批保持 LibreOffice 这一明确转换依赖。[更新检查源码](https://github.com/iOfficeAI/OfficeCLI/blob/main/src/officecli/Core/UpdateChecker.cs)、[截图源码](https://github.com/iOfficeAI/OfficeCLI/blob/main/src/officecli/Core/HtmlScreenshot.cs)、[view 命令](https://github.com/iOfficeAI/OfficeCLI/wiki/command-view)

复杂 PDF 的版面、表格抽取可再评估 Docling；它有 CLI、本地执行和结构化导出，但模型资源需事先准备，不列入基础预装。[Docling](https://github.com/docling-project/docling)、[离线模型准备](https://docling-project.github.io/docling/usage/advanced_options/)

## Sandbox 目录建议

以下是建议布局，尚未创建：

```text
/opt/raytone-tools/                    # 部署维护，Agent 可读/执行
  TOOLS.md                            # 仅列实际安装且通过检查的能力
  bin/                                # 命令入口、符号链接、必要的薄包装
  docs/                               # 每个工具的常用命令、限制、失败处理
  examples/                           # 少量 Office / 数据任务示例
  lib/                                # 固定版本的独立程序和 Node 依赖
  venv/                               # Python CLI/库的独立环境
  versions.json                       # 安装版本、来源、校验值、检查结果

/home/user/workspace/shared/artifacts/<task-id>/
                                       # 可下载成果
<agent-cwd>/.tool-tmp/<task-id>/         # 临时输入副本、转换配置与中间文件
```

这是统一入口目录，不要求把所有系统依赖搬进去。LibreOffice、Poppler、字体、浏览器系统库等仍按 Linux 包方式安装；`bin/` 连接到实际命令即可。Python 用 venv 的解释器/入口，Node 包由自己的脚本目录解析，不依赖全局 `PYTHONPATH` 或 `NODE_PATH`。

工具目录和说明由部署维护、root 所有且 Agent 不可写；缓存、Office 用户配置和浏览器会话放可写任务目录。不要放进 `~/.raytonebot/`，那是现有凭据/数据保护目录。也不把工具二进制放进共享成果目录，否则备份会包含可重建的依赖。

## Harness 给 Agent 什么

建议每轮在现有模型上下文中加入一小段当前能力摘要和索引路径，保证旧会话续接也能知道新增工具。完整手册留在磁盘上，Agent 需要时用 read 查看。

示意内容（不是当前已安装状态）：

```text
Local tools are available through bash; /opt/raytone-tools/bin is on PATH.
Read /opt/raytone-tools/TOOLS.md to choose a tool and find local usage examples.
Office: officecli. Office to PDF: soffice. Markdown to DOCX: pandoc.
PDF: pdftotext, pdfinfo, pdftoppm, qpdf. Data: duckdb, jq. Images: magick.
Write deliverables under /home/user/workspace/shared/artifacts/<task-id>/.
Check exit status and inspect the resulting file before reporting success.
```

`TOOLS.md` 每项只需：能做什么、命令名、适用输入、最小例子、输出位置/格式、已安装版本、重要限制、详细用法文件。安装检查失败的工具不列为可用；需要时给明确“未安装”状态。清单可以在部署时依据安装结果生成，不需要工具注册服务。

示意条目：

```markdown
### duckdb — 查询本地 CSV / JSON / Parquet
用途：统计、过滤、分组、连接文件；不是 Excel 样式编辑器。
执行：duckdb -json -c "SELECT count(*) AS rows FROM read_csv('input.csv');"
结果：stdout JSON；大结果写入任务目录中的文件。
版本：由部署填入实装值。更多例子：docs/duckdb.md。
```

原生命令已有可用 JSON/文本输出就直接使用。只为跨工具多步流程增加薄包装，例如“Office→PDF→生成预览”，在包装中处理超时、可写 profile、输出检查；不要先发明统一 JSON 协议和所有格式的命令框架。

## 与当前代码的接入点

已对照本轮工作树源码；这里是后续实现建议，不代表已经修改：

| 现状 / 证据 | 对方案的影响 |
| --- | --- |
| [`src/pi/piResources.ts`](../src/pi/piResources.ts) 在 sandbox 关闭 context files、skills、prompt 自动发现 | 不能只投放 AGENTS.md / SKILL.md；harness 要显式提供入口，不需要重开不受信任资源发现 |
| [`src/pi/piHost.ts`](../src/pi/piHost.ts) 的 Claude 路径已有 `appendSystemPrompt`；Codex 首轮拼接角色说明；Pi 使用模型 prompt | 复用各引擎现有上下文入口，传相同短清单；续接路径也需更新，不能只处理首轮 |
| [`src/pi/workspaceFiles.ts`](../src/pi/workspaceFiles.ts) 已区分用户原始消息与模型附加上下文 | 沿用这类边界，避免把内部工具说明当成用户正文显示；不必把工具职责塞进附件函数 |
| [`src/pi/runtime/agentProcess.ts`](../src/pi/runtime/agentProcess.ts) 统一建立 Agent 环境，剥离 `NODE_PATH/PYTHONPATH` 等变量；[`cliHarness.ts`](../src/pi/cliHarness.ts) 保留 `PATH` | 在既有环境出口增加固定工具 bin 路径；三个引擎均用真实受限 UID 检查，不能只在部署用户下检查 |
| [`src/pi/runtime/modelGateway.ts`](../src/pi/runtime/modelGateway.ts) 下载白名单只有 npm/PyPI 相关三个域 | 二进制、浏览器、OCR 语言包、Docling 模型及依赖应由部署预装；网页浏览能力需另验证代理与目标域权限 |
| [`scripts/agentsphere/deploy.py`](../scripts/agentsphere/deploy.py) 已为 Pi 预装 rg/fd，且对特定 fd 发布物做校验 | 扩展现有部署流程；固定版本/来源并验证即可，不需要新增镜像构建平台 |
| [`scripts/agentsphere/backup_data.py`](../scripts/agentsphere/backup_data.py) 备份工作区及原生会话 | 工具由版本记录重装，成果随现有工作区备份；临时大文件清理后再备份 |
| [`src/pi/permissionPolicy.ts`](../src/pi/permissionPolicy.ts) 对 Bash 操作按现有规则分类 | CLI 继续走现有权限闸门，不因列入清单而全局免审批；Tonny 的规划职责也不因有 Office 工具而改变 |

产物沿用工作区文件和现有 Output 面板。无需工具商店、新文件浏览器或新的 tool-call 组件。OfficeCLI 的 watch/安装向导、浏览器工具的 dashboard 等可选入口不属于第一批工作流；先使用 headless 命令和输出文件。

## 后续试点的最小验收

先在独立测试 sandbox 执行，记录通过的版本、实际安装体积和耗时；本轮没有这些实测数字。

1. **发现与执行**：Pi、Claude、Codex 各能读同一清单并运行适合角色的命令；新会话和已有会话续接都能发现；缺工具时报告缺失。
2. **Office**：中文 DOCX 读取并修改；XLSX 修改数值/公式并核对结果；PPTX 新建/编辑；保存后由第二个进程重读，确认不是仅留在内存中。复杂样式至少有一份既有文件样本。
3. **转换与检查**：三类 Office 导出 PDF；检查页数、文字内容及页面图像中的中文/溢出；PDF 抽页/合并后再次打开。JSON 或 ZIP 结构有效不能代替视觉验收。
4. **基础处理**：DuckDB 对已知 CSV 算出预期结果；jq 变换可核对；图片裁切/缩放后的尺寸与文件可读性正确。
5. **交付与失败**：成果出现在现有文件面板并可下载；转换失败、输入损坏、超时和停止不返回虚假成功；输入文件保留。
6. **环境可重现**：断开外网仍完成本地 Office/PDF 任务；重建后按版本记录恢复工具；两个并行转换任务使用各自输出目录/profile，不互相覆盖。

第二批再增加 OCR、浏览器、音视频。若试点发现 OfficeCLI 对常用文件的修改保真不足，再补相应 Python/Node 脚本，不用一开始把所有候选都安装上。

## 本轮验证范围

已搜索并核对第一方项目/文档，阅读了现有部署、环境、上下文注入、权限与备份代码。没有连接生产 sandbox，没有安装软件，没有更改运行时代码，没有跑真实文档转换、模型任务、build 或测试套件。本文是可实施的候选方案，不是已部署工具目录。
