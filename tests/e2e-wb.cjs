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
  const loadingBytes = grayTiff(300, 100, [120, 120, 120]);
  fs.writeFileSync(loading, loadingBytes);
  fs.writeFileSync(target, grayTiff(300, 100, [80, 160, 240]));
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
    const loadingKey = await page.locator("#quantRow option").nth(0).getAttribute("value");
    const targetKey = await page.locator("#quantRow option").nth(1).getAttribute("value");
    await page.locator("#quantRow").selectOption(targetKey);
    await page.locator("#quantMembrane").fill("membrane-1");
    await page.locator("#quantPolarity").selectOption("bright");
    await page.locator("#initializeRois").click();
    await page.locator("#quantMapLocked").check();
    await page.locator("#calculateQuant").click();
    await page.locator("#quantRow").selectOption(loadingKey);
    await page.locator("#quantMembrane").fill("membrane-1");
    await page.locator("#quantPolarity").selectOption("bright");
    await page.locator("#initializeRois").click();
    await page.locator("#calculateQuant").click();
    try {
      await page.waitForFunction(() => document.querySelectorAll("#quantResults tbody tr").length === 3, null, { timeout: 10_000 });
    } catch (error) {
      console.error(`quant status: ${await page.locator("#quantStatus").textContent()}\ntoast: ${await page.locator("#toast").textContent()}\nresults: ${await page.locator("#quantResults").innerText()}\nconsole: ${errors.join(" | ")}`);
      throw error;
    }

    const prismDownload = page.waitForEvent("download");
    await page.locator("#exportPrism").click();
    const prismFile = await prismDownload;
    assert.match(prismFile.suggestedFilename(), /prism-column-data\.zip$/);
    const prismBytes = fs.readFileSync(await prismFile.path());
    assert.equal(prismBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.ok(prismBytes.includes(Buffer.from('"Control","Group 1","Group 2"\r\n')), "Prism CSV must start with clean group columns");
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
    assert.equal(project.version, 2);
    assert.equal(project.rows.length, 2);
    assert.equal(project.panels.length, 1);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#newProject").click();
    await page.locator("#projectFile").setInputFiles(projectPath);
    await page.waitForFunction(() => document.querySelectorAll("#rowList .protein-row").length === 2);
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
    console.log("WB browser E2E passed: TIFF upload, raw quantification, Prism, panel, TIFF and compliance package.");
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
