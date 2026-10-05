# Sandbox 本地 Office / PDF 工具调研

调研日期：2026-10-04。范围：Linux sandbox、开源、本地命令调用；不依赖 MCP。本文是候选研究，未安装或运行候选工具，未测性能、排版兼容性或实际安装体积。依赖重量是基于组成的定性判断。主方案见 [本地工具箱评估](local-agent-toolkit-assessment.md)。

## 结论

建议试点 **iOfficeAI/OfficeCLI 做统一 Office 读写入口**，**LibreOffice 做 Office→PDF 和 Calc 重算补充**；Poppler 与 qpdf 提供 PDF 读、渲染、拆合能力。MarkItDown 适合先把附件提取成 Agent 可读 Markdown。Python/Node 库保留为需要复杂编程操作时的备用入口。OCRmyPDF / Tesseract 单独作为 OCR 能力组预装。

这是选择建议，不代表 OfficeCLI 已达到 Microsoft Office 的完整兼容性。尤其要将“生成文件”“读取结构”“计算公式”“渲染页面”作为不同能力展示，避免 Agent 把文件写出来就当作排版或计算验证通过。

## 候选对照

| 工具 / 接口 | 最适合的操作 | 边界 | 本地依赖与许可证 |
| --- | --- | --- | --- |
| **[iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)**，原生 CLI | 统一创建、读取、查询、增删改 DOCX/XLSX/PPTX；JSON 结果；模板填充；批处理 | HTML 是自己的渲染实现；PDF 需要 exporter 插件；内置公式引擎不是完整 Excel | 自含 .NET 二进制，Linux x64/ARM64；核心相对独立，截图另需浏览器。[Apache-2.0](https://github.com/iOfficeAI/OfficeCLI/blob/main/LICENSE) |
| **[LibreOffice headless](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html)**，原生转换 CLI + UNO API | Office/ODF 格式转换、导出 PDF；Calc 公式计算；现有文档渲染 | `--convert-to` 不是通用单元格/段落 CRUD 接口；细粒度编辑或强制重算需 UNO 脚本；需验证字体与复杂 Office 特性 | 较重，整套排版/计算引擎及字体；本地转换可离线。[MPL-2.0，附带其他开源组件](https://www.libreoffice.org/licenses/) |
| **[Pandoc](https://pandoc.org/MANUAL.html)**，原生 CLI | Markdown/HTML/DOCX 内容转换；生成 DOCX/PPTX；按 reference doc 统一样式 | 保结构优于保原始布局；复杂表格等可能有损；不是 XLSX 编辑器。PDF 输出另需 PDF 引擎 | 常规转换较独立；增加 TeX 等 PDF 引擎会明显变重；本地输入和资源可离线。[GPL-2.0-or-later](https://github.com/jgm/pandoc/blob/main/COPYRIGHT) |
| **[MarkItDown](https://github.com/microsoft/markitdown)**，CLI + Python 库 | DOCX/XLSX/PPTX/PDF → Markdown，给 Agent 阅读、检索、摘要 | 只做内容抽取，不编辑 Office、不保真渲染；扫描件不能默认当作已有 OCR。云 OCR/LLM 功能是另一路径 | Python，按格式装 extras，避免 `[all]`；内置转换可离线，禁用云端配置与第三方插件。[MIT](https://github.com/microsoft/markitdown/blob/main/LICENSE) |
| **[python-docx](https://python-docx.readthedocs.io/en/latest/)**，Python 库 | 新建/读取/修改 DOCX 段落、表格、样式、图片、页眉页脚 | 不是现成 CLI；不是 Word 排版/转 PDF 引擎；不能承诺所有 OOXML 特性都有高级 API | Python + lxml；离线；相对轻。[MIT](https://github.com/python-openxml/python-docx/blob/master/LICENSE) |
| **[openpyxl](https://openpyxl.readthedocs.io/en/stable/)**，Python 库 | XLSX/XLSM 读写、单元格、样式、图表和公式文本 | **不计算公式**；`data_only=True` 读上次缓存值；复杂文件回存可能丢失未支持的对象 | Python；图片需 Pillow，lxml 可选；离线、较轻。[MIT/Expat](https://openpyxl.readthedocs.io/en/stable/) |
| **[python-pptx](https://python-pptx.readthedocs.io/en/latest/)**，Python 库 | 读取、修改及生成 PPTX，模板/布局、文字、形状、表格和图表 | 不是 CLI 或页面渲染器；官方明确仍有 PowerPoint 特性未支持 | Python + lxml/Pillow，图表用 XlsxWriter；离线、中轻。[MIT](https://github.com/scanny/python-pptx/blob/master/LICENSE) |
| **[PptxGenJS](https://github.com/gitbrent/PptxGenJS)**，JS/TS 库 | 从数据/脚本创建 PPTX、母版、图表、形状、图片 | 定位为生成库；不要列成既有 PPTX 的通用读取/编辑 CLI；PDF/PNG 另走渲染器 | Node 环境，较轻；使用本地资产时可离线；MIT（仓库许可证） |
| **[Poppler utils](https://poppler.freedesktop.org/)**，一组 CLI | `pdfinfo` 元数据/页数；`pdftotext` 文字；`pdftoppm`/`pdftocairo` 页面图片；`pdfimages` 内嵌图像 | 提取已有文本，不自动 OCR；文本抽取顺序不等于视觉顺序；不做 Office 编辑 | C++ 本地工具与字体/图像库，中等；离线；[GPL 系列，以包内版权声明为准](https://raw.githubusercontent.com/tsdgeos/poppler_mirror/master/COPYING) |
| **[qpdf](https://qpdf.readthedocs.io/en/stable/overview.html)**，CLI + C++ 库 | PDF 拆分、合并、页选择/旋转、结构检查、JSON 结构 | 不理解内容流语义，不渲染，不提供文字内容编辑 | 依赖少、较轻、离线。[Apache-2.0](https://github.com/qpdf/qpdf/blob/main/LICENSE.txt) |
| **[OCRmyPDF](https://ocrmypdf.readthedocs.io/en/stable/cookbook.html)**，原生 CLI | 给扫描 PDF 增加可检索文本层；方向修正、纠偏；输出 OCR sidecar | OCR 不是表格/段落结构复原；sidecar 不含被跳过页面的原生文本；签名 PDF 默认拒绝修改 | 较重，Python + Tesseract + PDF 栅格器与相关依赖；语言包预装后本地运行。[MPL-2.0](https://github.com/ocrmypdf/OCRmyPDF/blob/main/LICENSE) |
| **[Tesseract](https://github.com/tesseract-ocr/tesseract)**，原生 CLI + 库 | 图片 OCR → TXT/TSV/hOCR/PDF；识别图中词和位置 | 输入是图像，不能把 PDF 原件直接当作图像读取；质量取决于图像和语言包 | Leptonica + 语言模型，中等；预装语言包后离线；Apache-2.0，依赖另有许可 |

依赖依据：[python-docx 安装](https://python-docx.readthedocs.io/en/latest/user/install.html)、[python-pptx 安装](https://python-pptx.readthedocs.io/en/latest/user/install.html)、[openpyxl 教程](https://openpyxl.readthedocs.io/en/stable/tutorial.html)、[Pandoc 安装](https://pandoc.org/installing.html)、[OCRmyPDF 安装](https://ocrmypdf.readthedocs.io/en/stable/installation.html)。Python 项目部分安装页包含旧 Python 版本文字，部署时应以所选发行版元数据确定运行时，本文不把旧页面版本当安装要求。

## OfficeCLI 值得优先试点，但要明确包名与实际边界

### 正确候选

目标是 **[iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)**，npm 名为 **`@officecli/officecli`**。官方源码用 `DocumentFormat.OpenXml`，构建配置明确 `PublishSingleFile` 与 `SelfContained`；核心文档 CRUD 的使用流程不要求账号或模型 API。这里的“Agent 友好”体现在原生命令、元素路径、JSON 与局部查询，而非另一个 AI 服务。[构建源码](https://github.com/iOfficeAI/OfficeCLI/blob/main/src/officecli/officecli.csproj)、[命令参考](https://github.com/iOfficeAI/OfficeCLI/wiki/command-reference)

截至调研日，官方发布记录显示 v1.0.153 发布于 2026-09-30，此前 9 月还有 v1.0.151、v1.0.152；可判断在持续迭代，但不能从更新频率推断兼容性已成熟。项目把大量功能合在一个新引擎中，建议先用我们的中文 DOCX、表格公式、PPT 图表样本试点，再确定版本。[发行记录](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.153)

### 需要写进本地工具卡的约束

- 关闭后台更新：`officecli config autoUpdate false`；受控调用可同时设 `OFFICECLI_SKIP_UPDATE=1`。源码默认开启更新，并检查此环境变量；固定版本工具箱不要运行裸 `officecli`/`officecli install`，它们有自安装和 Agent 集成行为。[README 安装说明](https://github.com/iOfficeAI/OfficeCLI#installation)、[UpdateChecker 源码](https://github.com/iOfficeAI/OfficeCLI/blob/main/src/officecli/Core/UpdateChecker.cs)
- `open` / resident 模式把修改留在内存；交给 LibreOffice、Python、下载接口之前先 `save` 或 `close`。也可部署时设置 `OFFICECLI_RESIDENT_FLUSH=each`，每次修改返回前落盘。[resident 文档](https://github.com/iOfficeAI/OfficeCLI/wiki/command-open)
- `view screenshot` **没有内嵌浏览器**：顺次找 Playwright CLI、Chromium 系、Firefox。源码还明确提及 CDN 字体与 KaTeX 外部资源，因此“自含二进制”不等于“所有预览在断网时完整”。浏览器、字体和实际预览资源都要预装/验收。[HtmlScreenshot 源码](https://github.com/iOfficeAI/OfficeCLI/blob/main/src/officecli/Core/HtmlScreenshot.cs)
- Linux 上截图通常走自制 HTML → 浏览器，不能当作 Microsoft Word/PowerPoint 的原生排版证据。`view pdf` 依赖 exporter 插件；第一期用 LibreOffice 的 PDF 转换即可。[view 文档](https://github.com/iOfficeAI/OfficeCLI/wiki/command-view)
- 公式引擎有明确支持列表；不支持的函数仍写入公式，但没有预计算值，`Format["evaluated"]` 为 false。工具卡必须要求检查公式结果与错误，不能只看命令成功。[公式支持与未支持函数](https://github.com/iOfficeAI/OfficeCLI/wiki/excel-formula-functions)

### 容易混淆的同名项目

**[officecli/officecli](https://github.com/officecli/officecli)**（`officecli.io`、未加 scope 的 `officecli` npm 包）是另一套按 prompt 生成 Office/图片的产品。它要求 hosted trial/key 或 External Mode 模型配置；其公开仓库自己说明仅含安装文档、demo、脚本和 skill 包装，不含完整实现。公开包装仓库的 MIT 许可证不能作为完整运行时开源的证据；不放进本次纯本地开源基础工具首选。

另见 **[onecer/AIOffice](https://github.com/onecer/AIOffice)** 的同类本地 CLI，可作为后续比较对象；本轮不为相似的第二套 Office 引擎增加安装和维护面。

## 几个会直接影响 Agent 成功率的区别

1. **写入公式与公式重算不同。** openpyxl 明确不计算公式。对所选函数可试用 OfficeCLI；要求完整重算时，LibreOffice UNO 的 `XCalculatable.calculateAll()` 能显式重算所有单元格，之后保存文件。不要把一次 `--convert-to` 无条件当作“缓存值已正确重算”的保证。[openpyxl 公式](https://openpyxl.readthedocs.io/en/stable/simple_formulae.html)、[UNO calculateAll](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1sheet_1_1XCalculatable.html)
2. **内容抽取与保真转换不同。** MarkItDown 用于理解内容；Pandoc 明示复杂文档转换可能丢失格式；LibreOffice 提供排版输出，但仍需固定字体并检查页面。这些工具不互相替代。[MarkItDown](https://github.com/microsoft/markitdown)、[Pandoc 转换边界](https://pandoc.org/MANUAL.html#description)
3. **OCR 安装不能只装 Python 包。** 当前 OCRmyPDF 17.x 文档要求 Tesseract，并可用 pypdfium2 或 Ghostscript 栅格化；17.0 起 Ghostscript 不再是所有路径的硬依赖。使用发行版旧包时，依赖关系可能不同。[安装文档](https://ocrmypdf.readthedocs.io/en/stable/installation.html)
4. **抽取后验证更简单。** PDF 先 `pdfinfo` 看页数，`pdftotext` 抽内容，再挑页渲染；qpdf 的 `--check` 只确认其能发现的结构问题，不能证明排版正确。qpdf 返回 3 表示仅警告，2 表示错误，应在工具卡说明。[qpdf 退出码](https://qpdf.readthedocs.io/en/stable/cli.html#exit-status)
5. **Office 文件改后必须另存并回读。** openpyxl 文档明确未支持的 shapes 可能在打开并保存后丢失。需要保留复杂用户文件时，应先操作副本，再检查内容与渲染；这也是选择具体引擎的验收项。[openpyxl 教程](https://openpyxl.readthedocs.io/en/stable/tutorial.html#loading-from-a-file)

## 六组可放进工具说明的命令示例

以下命令是按官方语法整理的示例，未在目标 sandbox 执行。目录和输入文件由任务先准备；输出均使用新路径。源文档支持命令形状，不代表示例内容已经验收。

### 1. OfficeCLI 创建、增改、回读和落盘

```bash
officecli create summary.pptx
officecli add summary.pptx / --type slide --prop title="项目进展"
officecli get summary.pptx '/slide[1]' --json
officecli close summary.pptx
```

生产调用由工具环境设置 `OFFICECLI_SKIP_UPDATE=1`。[create](https://github.com/iOfficeAI/OfficeCLI/wiki/command-create)、[add](https://github.com/iOfficeAI/OfficeCLI/wiki/command-add)、[get](https://github.com/iOfficeAI/OfficeCLI/wiki/command-get)、[open/close](https://github.com/iOfficeAI/OfficeCLI/wiki/command-open)

### 2. Markdown → Word / PowerPoint

```bash
pandoc brief.md --reference-doc=brand.docx -o brief.docx
pandoc slides.md --reference-doc=brand.pptx -o slides.pptx
```

reference 文件提供样式/布局；PPTX 的内容分段仍须按 Pandoc slide 规则编写。[Pandoc reference-doc 与幻灯片规则](https://pandoc.org/MANUAL.html)

### 3. Office / PDF → Agent 可读文本

```bash
markitdown input.xlsx -o input.md
pdftotext -layout input.pdf input.txt
```

MarkItDown 安装时只启用需要的格式 extras；`-layout` 尝试保留文本的物理布局，扫描图片仍需 OCR。[MarkItDown CLI](https://github.com/microsoft/markitdown#command-line)、[Poppler pdftotext 上游维护者镜像手册](https://raw.githubusercontent.com/tsdgeos/poppler_mirror/master/utils/pdftotext.1)

### 4. Office → PDF

```bash
soffice -env:UserInstallation=file:///tmp/raytone-lo-job-001 \
  --headless --convert-to pdf --outdir output input.docx
```

每个并发任务使用自己的可写 profile 目录；例中的任务号需实际生成且唯一。输出目录由任务提前建立；完成后校验新 PDF 存在、页数和内容。[LibreOffice CLI 参数](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html)、[PDF 导出选项](https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html)

### 5. PDF 页选择、结构检查与页面渲染

```bash
qpdf --empty --pages input.pdf 1-3 appendix.pdf 1 -- selected.pdf
qpdf --check selected.pdf
pdftoppm -f 1 -l 1 -r 120 -png selected.pdf preview
```

qpdf 做页面/结构操作，Poppler 生成 `preview-*.png` 供 Agent 视觉检查；两者各负其责。[qpdf page selection](https://qpdf.readthedocs.io/en/stable/cli.html#page-selection)、[pdftoppm 上游维护者镜像手册](https://raw.githubusercontent.com/tsdgeos/poppler_mirror/master/utils/pdftoppm.1)

### 6. 扫描 PDF / 图片 OCR

```bash
ocrmypdf -l chi_sim+eng --skip-text --sidecar ocr.txt scan.pdf searchable.pdf
tesseract screenshot.png stdout -l chi_sim+eng tsv
```

要预装 `chi_sim` 和 `eng` 语言数据。第一条保留已有文本页；其 sidecar 不包含那些被跳过页面的文本，要全文可再用 pdftotext。第二条 TSV 适合把词与位置交给 Agent。[OCRmyPDF cookbook](https://ocrmypdf.readthedocs.io/en/stable/cookbook.html)、[Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)

## 对 harness 的最小启示

- 首屏清单按任务列出“首选工具 + 入口 + 手册路径 + 能力边界”，详细参数留本地手册；不要一次塞入全部 API。
- 原生 CLI 就直接执行；Python/Node 库写为 `python script.py` / `node script.mjs` 能力，并附已知可用的 import 与示例。不要把库冒充已存在的 CLI。
- 工具与依赖在部署期安装并锁定版本；Agent 用户只需读取工具和执行，在自己的工作目录写产物。工具目录可提供统一 `bin/` 入口，但 LibreOffice、字体、OCR 语言包、浏览器等不能假设复制一个二进制就足够。
- 清单由安装结果决定：`installed`、`version`、`command`、`docs`；未安装的不宣称可用。试点验收至少覆盖中文、多页、表格、公式、图片、缺字体、失败输入、并发转换与断网运行。

以上是研究推导的集成建议；具体目录、部署脚本与权限集成由主方案结合现有运行时确定。本次仅写文档，无安装、代码修改或 sandbox 变更。
