const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

function grayTiff(width, height, laneValues) {
  const entries = 11;
  const ifdOffset = 8;
  const ifdEnd = ifdOffset + 2 + entries * 12 + 4;
  const pixelOffset = ifdEnd;
  const buffer = Buffer.alloc(pixelOffset + width * height, 20);
  buffer.write("II", 0, "ascii");
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  const entry = (tag, type, count, value) => {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(count, cursor + 4);
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, cursor + 8);
    else buffer.writeUInt32LE(value, cursor + 8);
    cursor += 12;
  };
  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 1, 8);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 1);
  entry(273, 4, 1, pixelOffset);
  entry(277, 3, 1, 1);
  entry(278, 4, 1, height);
  entry(279, 4, 1, width * height);
  entry(284, 3, 1, 1);
  entry(339, 3, 1, 1);
  buffer.writeUInt32LE(0, cursor);
  const laneWidth = width / laneValues.length;
  laneValues.forEach((value, lane) => {
    for (let y = 62; y < 84; y += 1) {
      for (let x = Math.floor(lane * laneWidth + 16); x < Math.floor((lane + 1) * laneWidth - 16); x += 1) {
        buffer[pixelOffset + y * width + x] = value;
      }
    }
  });
  return buffer;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local test server did not start");
}

(async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "figurelab-wb-"));
  const loading = path.join(fixtureDir, "Loading_Control.tif");
  const target = path.join(fixtureDir, "Target_Protein.tif");
  const exposureShort = path.join(fixtureDir, "Loading_short.tif");
  const exposureLong = path.join(fixtureDir, "Loading_long.tif");
  const loadingBytes = grayTiff(300, 100, [120, 120, 120]);
  fs.writeFileSync(loading, loadingBytes);
  fs.writeFileSync(target, grayTiff(300, 100, [80, 160, 240]));
  fs.writeFileSync(exposureShort, grayTiff(300, 100, [70, 70, 70]));
  fs.writeFileSync(exposureLong, grayTiff(300, 100, [220, 220, 220]));
  const legacyProject = path.join(fixtureDir, "legacy-v1.wb-project");
  fs.writeFileSync(legacyProject, JSON.stringify({
    kind: "blotboard-project",
    version: 1,
    projectId: "legacy-v1-project",
    modifiedAt: new Date().toISOString(),
    settings: {
      groups: [{ name: "Control", count: 1 }, { name: "Group 1", count: 1 }, { name: "Group 2", count: 1 }],
      laneLabels: ["Control", "Group 1", "Group 2"],
      layoutMode: "compact", footerLabel: "Cell line", laneWidth: 40, rowHeight: 40, rowGap: 7, labelSize: 16,
      showMw: true, showLanes: false, showBorder: true, demoLoaded: false, exportDpi: 300,
    },
    rows: [{
      name: "Legacy target", mw: "100 kDa", crop: { x: 0, y: 0, w: 300, h: 100 }, brightness: 100, contrast: 100, invert: false,
      source: { name: "legacy.tif", type: "image/tiff", size: loadingBytes.length, lastModified: 0, sha256: "", dataUrl: `data:image/tiff;base64,${loadingBytes.toString("base64")}` },
    }],
  }));

  const port = 8765;
  const server = spawn(process.env.PYTHON || "python", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: path.resolve(__dirname, ".."), stdio: "ignore", windowsHide: true });
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    const executablePath = process.env.PLAYWRIGHT_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/#studio`, { waitUntil: "networkidle" });
    await page.locator("#projectFile").setInputFiles(legacyProject);
    await page.waitForFunction(() => document.querySelectorAll("#rowList .protein-row").length === 1);
    assert.equal(await page.locator("#rowList .protein-row-top input").first().inputValue(), "Legacy target");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#newProject").click();
    await page.waitForFunction(() => document.querySelectorAll("#rowList .protein-row").length === 0);
    await page.locator("#groupInput").fill("NK × 2, 231WT × 4, 231OE × 4");
    await page.locator("#laneLabelInput").fill("NK, NK+H, WT, WT+H, WT+NK, WT+H+NK, OE, OE+H, OE+NK, OE+H+NK");
    await page.locator("#footerLabel").fill("MDA-MB-231");
    await page.locator("#applyGroups").click();
    await page.waitForFunction(() => document.querySelector("#figureCanvas")?.getAttribute("aria-label")?.includes("10 个泳道"));
    assert.equal(await page.locator("#singleLevelMode").getAttribute("aria-pressed"), "true", "new projects should open in the single-level interface");
    assert.match(await page.locator("#previewStatus").textContent(), /10 个样本/);
    assert.equal(await page.locator("#footerLabel").inputValue(), "MDA-MB-231");
    const ungroupedCanvasHeight = await page.locator("#figureCanvas").evaluate((canvas) => canvas.height);
    await page.locator("#nestedLevelMode").click();
    await page.waitForFunction((height) => document.querySelector("#figureCanvas")?.height > height, ungroupedCanvasHeight);
    assert.equal(await page.locator("#nestedLevelMode").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#groupInputCaption").textContent(), "顶部来源大组与泳道数");
    await page.locator("#singleLevelMode").click();
    await page.waitForFunction((height) => document.querySelector("#figureCanvas")?.height === height, ungroupedCanvasHeight);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#newProject").click();
    await page.waitForFunction(() => document.querySelector("#groupInput")?.value.includes("Control × 1"));
    await page.locator("#multiFile").setInputFiles([loading, target]);
    await page.waitForFunction(() => document.querySelectorAll("#rowList .protein-row").length === 2);

    const rows = page.locator("#rowList .protein-row");
    await rows.nth(0).locator(".protein-row-top input").nth(0).fill("Loading control");
    await rows.nth(0).locator(".protein-row-top input").nth(1).fill("36 kDa");
    await rows.nth(0).locator(".row-science select").selectOption("loading");
    await rows.nth(0).locator(".row-science input").nth(0).fill("membrane-1");
    await rows.nth(1).locator(".protein-row-top input").nth(0).fill("Target protein");
    await rows.nth(1).locator(".protein-row-top input").nth(1).fill("185 kDa");
    await rows.nth(1).locator(".row-science select").selectOption("target");
    await rows.nth(1).locator(".row-science input").nth(0).fill("membrane-1");

    await rows.nth(1).getByRole("button", { name: "裁剪/调图" }).click();
    await page.locator("#imageEditor").waitFor({ state: "visible" });
    await page.locator("#editBackgroundClean").fill("60");
    assert.equal(await page.locator("#editBackgroundCleanValue").textContent(), "60%");
    await page.locator("#editRotation").fill("-2.3");
    assert.equal(await page.locator("#editRotationValue").textContent(), "-2.3°");
    await page.locator("#applyEditor").click();
    await page.locator("#imageEditor").waitFor({ state: "hidden" });

    await rows.nth(0).locator(".row-science select").selectOption("target");
    await rows.nth(1).locator(".row-science select").selectOption("loading");
    await page.locator("#openQuant").click();
    assert.equal(await page.locator("#quantLoading option:checked").textContent(), "Target protein");
    await page.locator('[data-close-dialog="quantDialog"]').click();
    await rows.nth(0).locator(".row-science select").selectOption("loading");
    await rows.nth(1).locator(".row-science select").selectOption("target");

    await page.locator("#openQuant").click();
    await page.locator("#quantDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#quantRow option").count(), 2);
    await page.locator("#sampleMapImport summary").click();
    await page.locator("#sampleMapText").fill("泳道\t样本ID\t组别\t生物学重复\t排除\t排除原因\n1\tC1\tControl\t1\t否\t\n2\tD1\tDrug\t1\t否\t\n3\tD2\tDrug\t2\t是\t图像伪影");
    await page.locator("#applySampleMapText").click();
    assert.equal(await page.locator('#sampleMapBody [data-map="sampleId"]').nth(0).inputValue(), "C1");
    assert.equal(await page.locator('#sampleMapBody [data-map="group"]').nth(2).inputValue(), "Drug");
    assert.match(await page.locator("#groupInput").inputValue(), /Control × 1, Drug × 2/);
    await page.locator("#sampleMapText").fill("lane,sample_id,biological_replicate\n1,Bad,1");
    await page.locator("#applySampleMapText").click();
    assert.equal(await page.locator('#sampleMapBody [data-map="sampleId"]').nth(0).inputValue(), "C1", "invalid import must not replace the existing map");
    const thirdGroup = page.locator('#sampleMapBody [data-map="group"]').nth(2);
    await thirdGroup.selectOption("Control");
    assert.match(await page.locator("#groupInput").inputValue(), /Control × 1, Drug × 1, Control × 1/, "manual map edits must keep figure grouping synchronized");
    await thirdGroup.selectOption("Drug");
    assert.match(await page.locator("#groupInput").inputValue(), /Control × 1, Drug × 2/);
    const loadingKey = await page.locator("#quantRow option").nth(0).getAttribute("value");
    const targetKey = await page.locator("#quantRow option").nth(1).getAttribute("value");
    await page.locator("#quantRow").selectOption(targetKey);
    await page.locator("#quantMembrane").fill("membrane-1");
    await page.locator("#quantPolarity").selectOption("bright");
    const maxRoiHeight = Number(await page.locator("#quantRoiHeight").getAttribute("max"));
    assert.ok(Number(await page.locator("#quantRoiHeight").inputValue()) >= 2 && maxRoiHeight >= 2, "ROI height should be explicit and editable in pixels");
    await page.locator("#quantRoiHeight").fill(String(maxRoiHeight + 100));
    await page.locator("#initializeRois").click();
    assert.match(await page.locator("#quantStatus").textContent(), new RegExp(`${maxRoiHeight} px`), "uniform initialization must clamp height before band/background ROIs can overlap");
    await page.locator("#suggestRois").click();
    assert.match(await page.locator("#quantStatus").textContent(), /信号建议/);
    await page.locator("#quantMapLocked").check();
    assert.ok(await page.locator('#sampleMapBody [data-map="sampleId"]').first().isDisabled(), "locked sample map must be read-only");
    await page.locator('[data-close-dialog="quantDialog"]').click();
    await page.locator("#applyGroups").click();
    await page.locator("#compactPreset").click();
    await page.locator("#openQuant").click();
    await page.locator("#quantDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator('#sampleMapBody [data-map="sampleId"]').first().inputValue(), "C1", "no-op layout actions must preserve detailed sample metadata");
    assert.ok(await page.locator("#quantMapLocked").isChecked(), "no-op layout actions must preserve the mapping lock");
    assert.ok(await page.locator('#sampleMapBody [data-map="excluded"]').nth(2).isChecked(), "no-op layout actions must preserve exclusions");
    await page.locator("#quantRow").selectOption(targetKey);
    await page.locator("#calculateQuant").click();
    await page.locator("#quantRow").selectOption(loadingKey);
    await page.locator("#quantMembrane").fill("membrane-1");
    await page.locator("#quantPolarity").selectOption("bright");
    await page.locator("#quantRoiHeight").fill("12");
    await page.locator("#initializeRois").click();
    assert.match(await page.locator("#quantStatus").textContent(), /12 px/);
    await page.locator("#calculateQuant").click();
    try {
      await page.waitForFunction(() => document.querySelectorAll("#quantResults tbody tr").length === 3, null, { timeout: 10_000 });
    } catch (error) {
      console.error(`quant status: ${await page.locator("#quantStatus").textContent()}\ntoast: ${await page.locator("#toast").textContent()}\nresults: ${await page.locator("#quantResults").innerText()}\nconsole: ${errors.join(" | ")}`);
      throw error;
    }
    assert.match(await page.locator("#quantResults thead").textContent(), /IntDen（Fiji 对照）/);
    assert.doesNotMatch(await page.locator("#quantResults tbody").textContent(), /NaN/);
    assert.equal(await page.locator("#quantPlotTarget").inputValue(), targetKey, "plot target must remain independent from the ROI row left on the loading control");
    assert.equal(await page.locator("#quantPlotTarget option").count(), 1, "the loading control must not appear as a plot target");
    assert.equal(await page.locator("#quantPlotLoadingName").textContent(), "Loading control");
    assert.match(await page.locator("#quantPlotStatus").textContent(), /Target protein \/ Loading control/);
    const plotInfo = await page.locator("#quantPlot").evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let coloredPixels = 0;
      let bluePixels = 0;
      let orangePixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== data[index + 1] || data[index + 1] !== data[index + 2]) coloredPixels += 1;
        if (data[index] === 63 && data[index + 1] === 105 && data[index + 2] === 169) bluePixels += 1;
        if (data[index] === 217 && data[index + 1] === 96 && data[index + 2] === 37) orangePixels += 1;
      }
      return { width: canvas.width, height: canvas.height, coloredPixels, bluePixels, orangePixels };
    });
    assert.deepEqual({ width: plotInfo.width, height: plotInfo.height }, { width: 856, height: 1140 });
    assert.ok(plotInfo.coloredPixels > 1000, "Prism-style plot should contain the user palette, not an empty canvas");
    assert.ok(plotInfo.bluePixels > 100 && plotInfo.orangePixels > 100, "plot bars must preserve the blue/orange palette parsed from the Prism project");
    const plotDownload = page.waitForEvent("download");
    await page.locator("#exportQuantPlotPng").click();
    const plotFile = await plotDownload;
    assert.match(plotFile.suggestedFilename(), /Target protein-prism-style-300dpi\.png$/);
    const plotPng = fs.readFileSync(await plotFile.path());
    assert.equal(plotPng.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(plotPng.readUInt32BE(16), 856);
    assert.equal(plotPng.readUInt32BE(20), 1140);
    assert.ok(plotPng.includes(Buffer.from("pHYs")), "plot PNG must carry 300 DPI resolution metadata");
    await page.locator("#quantMembrane").fill("membrane-temporary");
    assert.ok(await page.locator("#exportQuantPlotPng").isDisabled(), "changing a quantification input must disable stale plot export immediately");
    assert.match(await page.locator("#quantResults").textContent(), /尚未计算/);
    await page.locator("#quantMembrane").fill("membrane-1");
    await page.locator("#calculateQuant").click();
    await page.waitForFunction(() => document.querySelectorAll("#quantResults tbody tr").length === 3);
    assert.equal(await page.locator("#quantPlotTarget").inputValue(), targetKey);
    const detailDownload = page.waitForEvent("download");
    await page.locator("#exportQuantCsv").click();
    const detailFile = await detailDownload;
    const detailCsv = fs.readFileSync(await detailFile.path(), "utf8");
    assert.match(detailCsv, /target_fiji_intden/);
    assert.match(detailCsv, /loading_fiji_intden/);
    const workbookDownload = page.waitForEvent("download");
    await page.locator("#exportQuantXlsx").click();
    const workbookFile = await workbookDownload;
    const workbookBytes = fs.readFileSync(await workbookFile.path());
    assert.equal(workbookBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.ok(workbookBytes.includes(Buffer.from("Plot_Data")), "quantification workbook must include the exact plotted ratio table");
    assert.ok(workbookBytes.includes(Buffer.from("Plot_Stats")), "quantification workbook must include the plot statistics and group colors");
    assert.ok(workbookBytes.includes(Buffer.from("target/loading biological-replicate ratio")));

    await page.locator("#exposureCheck summary").click();
    await page.locator("#exposureFiles").setInputFiles([exposureShort, exposureLong]);
    assert.equal(await page.locator("#exposureFileTable tbody tr").count(), 3);
    const exposureTimes = page.locator("#exposureFileTable [data-exposure-time]");
    await exposureTimes.nth(0).fill("2");
    await exposureTimes.nth(1).fill("1");
    await exposureTimes.nth(2).fill("4");
    await page.locator("#exposureGeometryConfirmed").check();
    await page.locator("#runExposureCheck").click();
    await page.waitForFunction(() => document.querySelector("#exposureResults")?.textContent.includes("符合预筛查阈值"));
    assert.equal(await page.locator("#exposureResults tbody tr").count(), 2);
    const exposureDownload = page.waitForEvent("download");
    await page.locator("#downloadExposureReport").click();
    const exposureFile = await exposureDownload;
    assert.match(exposureFile.suggestedFilename(), /exposure-check\.csv$/);
    const exposureCsv = fs.readFileSync(await exposureFile.path(), "utf8");
    assert.match(exposureCsv, /Loading control/, "exposure report must retain the protein identity snapshot");
    assert.match(exposureCsv, /Loading_short\.tif/);
    assert.match(exposureCsv, /Loading_long\.tif/);
    assert.match(exposureCsv, /background_clipped_fraction/);
    assert.match(exposureCsv, /same_membrane_same_view_confirmed/);
    assert.match(exposureCsv, /EXCLUDED_BY_SAMPLE_MAP/);
    assert.match(exposureCsv, /图像伪影/);
    await page.locator("#quantMapLocked").uncheck();
    assert.ok(await page.locator("#downloadExposureReport").isDisabled(), "unlocking the sample map must invalidate an exposure report");
    await page.locator("#quantMapLocked").check();

    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function delayedExposureRead() {
        if (/Loading_(short|long)/.test(this.name)) return new Promise((resolve, reject) => setTimeout(() => original.call(this).then(resolve, reject), 120));
        return original.call(this);
      };
    });
    await page.locator("#runExposureCheck").click();
    await page.waitForTimeout(25);
    await page.locator("#quantMapLocked").uncheck();
    await page.waitForFunction(() => document.querySelector("#runExposureCheck")?.textContent === "运行响应预筛查");
    assert.ok(await page.locator("#downloadExposureReport").isDisabled(), "an exposure run must discard results when inputs change asynchronously");
    assert.match(await page.locator("#exposureResults").textContent(), /尚未运行检查/);
    await page.locator("#quantMapLocked").check();

    const prismDownload = page.waitForEvent("download");
    await page.locator("#exportPrism").click();
    const prismFile = await prismDownload;
    assert.match(prismFile.suggestedFilename(), /prism-column-data\.zip$/);
    const prismBytes = fs.readFileSync(await prismFile.path());
    assert.equal(prismBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.ok(prismBytes.includes(Buffer.from('"Control","Drug"\r\n')), "Prism CSV must start with clean group columns");
    assert.ok(prismBytes.includes(Buffer.from("Target protein-target-loading-ratio.csv")), "Prism package must include the exact ratio data used by the plot");
    assert.ok(prismBytes.includes(Buffer.from("Target protein-plot-statistics.csv")), "Prism package must include reproducible plot statistics");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileQuant = await page.evaluate(() => {
      const dialog = document.querySelector("#quantDialog").getBoundingClientRect();
      return { pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, dialogLeft: dialog.left, dialogRight: dialog.right };
    });
    assert.ok(mobileQuant.pageWidth <= mobileQuant.viewportWidth + 1, "mobile quantification dialog must not overflow the page");
    assert.ok(mobileQuant.dialogLeft >= 0 && mobileQuant.dialogRight <= mobileQuant.viewportWidth + 1, "mobile quantification dialog must stay inside the viewport");
    if (process.env.E2E_QUANT_SCREENSHOT) await page.locator("#quantPlot").screenshot({ path: process.env.E2E_QUANT_SCREENSHOT });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-close-dialog="quantDialog"]').click();

    const tiffDownload = page.waitForEvent("download");
    await page.locator("#exportTiff").click();
    const tiffFile = await tiffDownload;
    assert.match(tiffFile.suggestedFilename(), /300dpi\.tiff$/);
    assert.equal(fs.readFileSync(await tiffFile.path()).subarray(0, 4).toString("hex"), "49492a00");

    await page.locator("#openPanels").click();
    await page.locator("#addQuantPanel").click();
    await page.waitForFunction(() => document.querySelectorAll("#panelGrid .panel-card").length === 2);
    assert.equal(await page.locator("#panelGrid .panel-card").count(), 2);
    assert.match(await page.locator("#panelGrid .panel-card").nth(1).textContent(), /Target protein quantification/, "panel builder must add the selected plot target, not the current loading-control ROI row");
    const panelDownload = page.waitForEvent("download");
    await page.locator("#exportPanelPng").click();
    const panelFile = await panelDownload;
    assert.match(panelFile.suggestedFilename(), /multi-panel\.png$/);
    assert.equal(fs.readFileSync(await panelFile.path()).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    await page.locator('[data-close-dialog="panelDialog"]').click();

    const packageDownload = page.waitForEvent("download", { timeout: 120_000 });
    await page.locator("#exportPackage").click();
    const packageFile = await packageDownload;
    assert.match(packageFile.suggestedFilename(), /submission-package\.zip$/);
    const packageBytes = fs.readFileSync(await packageFile.path());
    assert.equal(packageBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.ok(packageBytes.includes(Buffer.from("checksums.sha256")));

    await page.locator("#openPreflight").click();
    assert.equal(await page.locator("#preflightResults .check-section").first().locator("li").textContent(), "没有阻止导出的错误。");
    await page.locator('[data-close-dialog="preflightDialog"]').first().click();

    const projectDownload = page.waitForEvent("download");
    await page.locator("#saveProject").click();
    const projectFile = await projectDownload;
    assert.match(projectFile.suggestedFilename(), /project\.wb-project$/);
    const projectPath = await projectFile.path();
    const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    assert.equal(project.version, 4);
    assert.equal(project.settings.showGroupBrackets, false);
    assert.equal(project.rows.length, 2);
    assert.equal(project.rows[1].backgroundClean, 60);
    assert.equal(project.rows[1].rotation, -2.3);
    assert.equal(project.panels.length, 1);
    assert.equal(project.settings.quant.rois[targetKey].method, "row-contrast-v1");
    assert.equal(project.settings.quant.rois[loadingKey].method, "uniform-v2");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#newProject").click();
    await page.locator("#projectFile").setInputFiles(projectPath);
    await page.waitForFunction(() => document.querySelectorAll("#rowList .protein-row").length === 2);
    await page.locator("#rowList .protein-row").nth(1).getByRole("button", { name: "裁剪/调图" }).click();
    assert.equal(await page.locator("#editBackgroundClean").inputValue(), "60");
    assert.equal(await page.locator("#editRotation").inputValue(), "-2.3");
    await page.locator("#cancelEditor").click();
    await page.locator("#openQuant").click();
    await page.locator("#quantDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator('#sampleMapBody [data-map="sampleId"]').first().inputValue(), "C1", "v2 import must restore the sample map");
    assert.ok(await page.locator("#quantMapLocked").isChecked(), "v2 import must restore the mapping lock");
    await page.locator("#quantRow").selectOption(targetKey);
    await page.waitForFunction(() => document.querySelector("#quantStatus")?.textContent.includes("信号建议"));
    assert.match(await page.locator("#quantStatus").textContent(), /信号建议/, "v2 import must restore ROI provenance");
    await page.locator('[data-close-dialog="quantDialog"]').click();
    await page.locator("#openPanels").click();
    assert.equal(await page.locator("#panelGrid .panel-card").count(), 2);
    await page.locator('[data-close-dialog="panelDialog"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/#studio`, { waitUntil: "networkidle" });
    assert.equal(await page.locator(".suite-nav .tool-tab").count(), 3);
    await page.waitForFunction(() => {
      const header = document.querySelector(".topbar")?.getBoundingClientRect();
      const studio = document.querySelector("#studio")?.getBoundingClientRect();
      return header && studio && studio.top >= header.bottom - 1 && studio.top < window.innerHeight;
    });
    const mobileShell = await page.evaluate(() => {
      const header = document.querySelector(".topbar").getBoundingClientRect();
      const studio = document.querySelector("#studio").getBoundingClientRect();
      const links = [...document.querySelectorAll(".suite-nav .tool-tab")].map((link) => link.getBoundingClientRect());
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        shellInsideViewport: header.left >= 0 && header.right <= window.innerWidth
          && links.every((link) => link.left >= 0 && link.right <= window.innerWidth),
        studioVisible: studio.top >= header.bottom - 1 && studio.top < window.innerHeight,
      };
    });
    assert.ok(mobileShell.pageWidth <= mobileShell.viewportWidth + 1, "mobile page must not overflow horizontally");
    assert.ok(mobileShell.shellInsideViewport, "mobile suite navigation must stay inside the viewport");
    assert.ok(mobileShell.studioVisible, "#studio must land below the sticky header and inside the viewport");
    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
    console.log("WB browser E2E passed: sample-map import, assisted ROI, exposure QC, TIFF quantification, Prism and compliance package.");
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
