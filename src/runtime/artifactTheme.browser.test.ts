import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { artifactThemeCss } from "../components/agent-preview/outputframe/artifactTheme.ts";
import { htmlPreviewDocument, htmlStreamDocument } from "../components/agent-preview/outputframe/htmlPreview.ts";
import { themeTokens } from "../theme/themeTokens.ts";
import { themeVariables } from "../theme/applyTheme.ts";

const colors = ["blue", "teal", "purple", "coral", "amber", "green", "red", "gray"];
const textClasses = ["t", "ts", "th"];
const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => value / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a: number[], b: number[]) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("artifact SVG labels are readable in both themes and author colors remain effective", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000,
}, async t => {
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 660, height: 580 } });
    for (const theme of Object.values(themeTokens)) await t.test(theme.appearance, async () => {
      const variables = themeVariables(theme);
      const css = artifactThemeCss(name => variables[name] ?? "", theme.appearance);
      await page.setContent(htmlPreviewDocument(`<style>.author-color{fill:#123456}</style>
        <svg width="620" height="540" xmlns="http://www.w3.org/2000/svg">
          ${textClasses.map((name, index) => `<text class="${name}" x="${16 + index * 190}" y="24">${name} Plain / 文字</text>`).join("")}
          ${colors.map((name, index) => `<g class="c-${name}" transform="translate(16,${40 + index * 54})">
            <rect width="580" height="44" rx="8"/>
            ${textClasses.map((textClass, i) => `<text class="${textClass}" x="${12 + i * 145}" y="28">${name} ${textClass} / 标签</text>`).join("")}
            <text x="447" y="28">Legacy label</text>
          </g>`).join("")}
          <g class="c-blue" transform="translate(16,500)">
            <text id="explicit" class="t" fill="#123456">Explicit</text>
            <text id="inline" class="t" style="fill:#123456" x="100">Inline</text>
            <text id="author" class="t author-color" x="200">CSS</text>
            <text id="author-stroke" class="t" x="300" stroke="#123456">Stroke</text>
            <path id="art" d="M 400 0 h 20 v 20 h -20 z" fill="#123456"/>
          </g>
        </svg>`, css));
      const samples = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const pixel = (...layers: string[]) => {
          context.clearRect(0, 0, 1, 1);
          for (const color of layers) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const pageColor = getComputedStyle(document.body).backgroundColor;
        const surface = pixel(pageColor);
        return {
          surface,
          plain: [...document.querySelectorAll("svg > text")].map(text => ({ name: text.classList.value, color: pixel(getComputedStyle(text).fill) })),
          nodes: [...document.querySelectorAll("svg > g:has(rect)")].map(group => ({
            name: group.classList.value,
            background: pixel(pageColor, getComputedStyle(group.querySelector("rect")!).fill),
            labels: [...group.querySelectorAll("text")].map(text => ({ name: text.classList.value, color: pixel(getComputedStyle(text).fill), stroke: getComputedStyle(text).stroke })),
          })),
          custom: ["explicit", "inline", "author", "art"].map(id => ({ id, fill: getComputedStyle(document.getElementById(id)!).fill })),
          customStroke: getComputedStyle(document.getElementById("author-stroke")!).stroke,
        };
      });
      for (const text of samples.plain) assert.ok(contrast(text.color, samples.surface) >= 4.5, `${theme.appearance} ${text.name} on page`);
      const ratios = [];
      for (const node of samples.nodes) for (const label of node.labels) {
        const onNode = contrast(label.color, node.background), onPage = contrast(label.color, samples.surface);
        assert.ok(onNode >= 4.5, `${theme.appearance} ${node.name} ${label.name} on node: ${onNode}`);
        assert.ok(onPage >= 4.5, `${theme.appearance} ${node.name} ${label.name} on page: ${onPage}`);
        assert.equal(label.stroke, "none", "labels must not inherit the node outline");
        ratios.push(onNode, onPage);
      }
      for (const custom of samples.custom) assert.equal(custom.fill, "rgb(18, 52, 86)", `${custom.id} must preserve author color`);
      assert.equal(samples.customStroke, "rgb(18, 52, 86)");
      t.diagnostic(`${theme.appearance} minimum node/page label contrast: ${Math.min(...ratios).toFixed(2)}:1`);
      const evidence = process.env.RAYTONEBOT_UI_EVIDENCE_DIR;
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `artifact-svg-${theme.appearance}.png`) }); }
    });
  } finally { await browser.close(); }
});

test("streamed static content is visible before save while scripts stay inactive", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe sandbox="allow-scripts" title="Preview"></iframe>');
    const frameElement = page.locator("iframe");
    await frameElement.evaluate((element, source) => { (element as HTMLIFrameElement).srcdoc = source; }, htmlStreamDocument("", "streamtest"));
    const frame = page.frameLocator("iframe");
    await frame.locator("#raytone-theme").waitFor({ state: "attached" });
    const post = async (body: string) => frameElement.evaluate((element, html) => {
      (element as HTMLIFrameElement).contentWindow!.postMessage({ raytoneStream: html }, "*");
    }, body);
    const prefix = '<style>.summary{padding:12px}</style><div class="summary">Static comparison</div>';
    await post(prefix);
    await frame.getByText("Static comparison", { exact: true }).waitFor();
    await post(`${prefix}<button onclick="document.body.dataset.ran='yes'">Enhance</button><script>document.body.dataset.ran='yes'</script>`);
    await frame.getByRole("button", { name: "Enhance" }).click();
    assert.equal(await frame.locator("body").getAttribute("data-ran"), null);
    assert.equal(await frame.locator("body script").count(), 0);
    assert.equal(await frame.locator("button").getAttribute("onclick"), null);
    assert.equal(await frame.locator(".summary").innerText(), "Static comparison");
    await frameElement.evaluate((element, source) => { (element as HTMLIFrameElement).srcdoc = source; }, htmlPreviewDocument(`${prefix}<button onclick="this.textContent='Enhanced'">Enhance</button>`));
    await frame.getByRole("button", { name: "Enhance", exact: true }).click();
    await frame.getByRole("button", { name: "Enhanced", exact: true }).waitFor();
  } finally { await browser.close(); }
});
