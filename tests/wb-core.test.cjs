const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../wb-core.js");

function zipEntries(input) {
  const data = Buffer.from(input);
  const entries = new Map();
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(data.readUInt16LE(offset + 8), 0, "test reader expects stored ZIP entries");
    const size = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    entries.set(data.subarray(nameStart, nameStart + nameLength).toString("utf8"), data.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + size;
  }
  assert.equal(data.readUInt32LE(offset), 0x02014b50, "ZIP central directory is missing");
  return entries;
}

function tiffTags(input) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const ifd = view.getUint32(4, true);
  const tags = new Map();
  for (let index = 0; index < view.getUint16(ifd, true); index += 1) {
    const offset = ifd + 2 + index * 12;
    tags.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
    });
  }
  return { view, tags };
}

function measurement(corrected, qc = []) {
  return { corrected, qc };
}

function testZip() {
  assert.equal(core.crc32("123456789"), 0xcbf43926);
  const archive = core.zipStore([
    { name: "hello.txt", data: "hello" },
    { name: "数据/结果.csv", data: "a,b\n1,2" },
  ]);
  const entries = zipEntries(archive);
  assert.equal(entries.get("hello.txt").toString(), "hello");
  assert.equal(entries.get("数据/结果.csv").toString(), "a,b\n1,2");
}

function testTiff() {
  const rgba = Uint8Array.of(10, 20, 30, 255, 0, 0, 0, 0);
  const tiff = core.encodeTiffRgba(2, 1, rgba, 300);
  const { view, tags } = tiffTags(tiff);
  assert.equal(String.fromCharCode(tiff[0], tiff[1]), "II");
  assert.equal(view.getUint16(2, true), 42);
  assert.equal(tags.get(256).value, 2);
  assert.equal(tags.get(257).value, 1);
  assert.equal(tags.get(262).value & 0xffff, 2);
  assert.equal(tags.get(277).value & 0xffff, 3);
  const pixelOffset = tags.get(273).value;
  assert.deepEqual([...tiff.slice(pixelOffset)], [10, 20, 30, 255, 255, 255]);
  const xResolution = tags.get(282).value;
  assert.equal(view.getUint32(xResolution, true) / view.getUint32(xResolution + 4, true), 300);
  assert.throws(() => core.encodeTiffRgba(2, 2, rgba), /byte length/);
}

function testPdf() {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  const pdf = core.pdfFromJpegs([{ jpeg, width: 300, height: 150, dpi: 300 }], { title: "WB (test)" });
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/MediaBox \[0 0 72 36\]/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.ok(text.includes("/Title (WB \\(test\\))"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.throws(() => core.pdfFromJpegs([]), /at least one page/);
}

function testXlsx() {
  const workbook = core.xlsxWorkbook([
    { name: "Prism/Data", rows: [["Group", "Control", "Drug"], ["R1", 1, 2.5], ["Included", true, false]] },
    { name: "Prism/Data", rows: [["duplicate name"]] },
  ]);
  const entries = zipEntries(workbook);
  assert.ok(entries.has("[Content_Types].xml"));
  assert.ok(entries.has("xl/workbook.xml"));
  assert.ok(entries.has("xl/worksheets/sheet1.xml"));
  assert.match(entries.get("xl/workbook.xml").toString(), /name="Prism_Data"/);
  assert.match(entries.get("xl/workbook.xml").toString(), /name="Prism_Data_2"/);
  const sheet = entries.get("xl/worksheets/sheet1.xml").toString();
  assert.match(sheet, /<c r="B2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="B3" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet, /Control/);
}

function testDarkAndBrightRois() {
  const dark = core.quantifyRoiPair({
    pixels: Uint8Array.of(20, 30, 200, 200, 20, 30, 200, 200),
    width: 4,
    height: 2,
    band: { x: 0, y: 0, w: 2, h: 2 },
    background: { x: 2, y: 0, w: 2, h: 2 },
    polarity: "dark",
  });
  assert.equal(dark.bandMean, 25);
  assert.equal(dark.backgroundMean, 200);
  assert.equal(dark.corrected, 700);
  assert.deepEqual(dark.qc, []);

  const bright = core.quantifyRoiPair({
    pixels: Uint8ClampedArray.of(230, 240, 20, 20, 230, 240, 20, 20),
    width: 4,
    height: 2,
    band: { x: 0, y: 0, w: 2, h: 2 },
    background: { x: 2, y: 0, w: 2, h: 2 },
    polarity: "bright",
  });
  assert.equal(bright.bandMean, 235);
  assert.equal(bright.backgroundMean, 20);
  assert.equal(bright.corrected, 860);
  assert.deepEqual(bright.qc, []);

  const saturated = core.quantifyRoiPair({
    pixels: Uint8Array.of(0, 0, 200, 200), width: 4, height: 1,
    band: { x: 0, y: 0, w: 2, h: 1 }, background: { x: 2, y: 0, w: 2, h: 1 }, polarity: "dark",
  });
  assert.ok(saturated.qc.includes("SIGNAL_SATURATION_HIGH"));
  assert.throws(() => core.quantifyRoiPair({
    pixels: Uint8Array.of(1, 2, 3, 4), width: 2, height: 2,
    band: { x: 0, y: 0, w: 1, h: 1 }, background: { x: 0, y: 0, w: 1, h: 1 },
  }), /must not overlap/);
}

function testNormalizationAndPrism() {
  const rows = core.normalizeMeasurements(
    [{ key: "her2", name: "HER2", lanes: [measurement(100), measurement(300), measurement(200), measurement(800)] }],
    { key: "gapdh", name: "GAPDH", lanes: [measurement(100), measurement(100), measurement(100), measurement(100)] },
    [
      { sampleId: "C1a", group: "Control", biologicalReplicate: 1, technicalReplicate: 1 },
      { sampleId: "C1b", group: "Control", biologicalReplicate: 1, technicalReplicate: 2 },
      { sampleId: "C2", group: "Control", biologicalReplicate: 2 },
      { sampleId: "D1", group: "Drug", biologicalReplicate: 1 },
    ],
    "Control",
  );
  assert.equal(rows[0].biologicalRatio, 2, "technical replicates are averaged first");
  assert.equal(rows[0].controlMean, 2, "control baseline uses biological replicates");
  assert.equal(rows[0].foldChange, 1);
  assert.equal(rows[3].foldChange, 4);

  const prism = core.prismColumnTables(rows);
  assert.equal(prism.length, 1);
  assert.deepEqual(prism[0].rows, [
    ["Control", "Drug"],
    [1, 4],
    [1, ""],
  ]);
  assert.deepEqual(core.summarizeNormalized(rows), [
    { targetKey: "her2", target: "HER2", group: "Control", n: 2, mean: 1, sd: 0 },
    { targetKey: "her2", target: "HER2", group: "Drug", n: 1, mean: 4, sd: null },
  ]);
}

function testQc() {
  const result = core.runIntegrityChecks({
    laneCount: 3,
    labelSizePt: 6,
    figureWidthCm: 18,
    maxWidthCm: 17.8,
    rows: [{
      name: "HER2", role: "target", hasSource: false, sha256: "", mw: "", brightness: 110, contrast: 100,
      invert: false, nonAdjacent: true, splices: [], signalClippedFraction: 0.02, backgroundClippedFraction: 0.03, membraneId: "m1",
    }],
  });
  const errors = result.errors.map(({ code }) => code);
  const warnings = result.warnings.map(({ code }) => code);
  assert.ok(errors.includes("SOURCE_MISSING"));
  assert.ok(errors.includes("SPLICE_UNMARKED"));
  ["HASH_MISSING", "MW_MISSING", "IMAGE_ADJUSTED", "SATURATION_HIGH", "BACKGROUND_CLIPPING_HIGH", "LOADING_CONTROL_MISSING", "MEMBRANE_MISMATCH", "FONT_TOO_SMALL", "FIGURE_TOO_WIDE"]
    .forEach((code) => assert.ok(warnings.includes(code), `${code} warning is missing`));

  const clean = core.runIntegrityChecks({
    laneCount: 2, labelSizePt: 8, figureWidthCm: 8.9, maxWidthCm: 8.9,
    rows: [
      { name: "Target", role: "target", hasSource: true, sha256: "a", mw: "50", brightness: 100, contrast: 100, invert: false, splices: [], signalClippedFraction: 0, membraneId: "m1" },
      { name: "Loading", role: "loading", hasSource: true, sha256: "b", mw: "36", brightness: 100, contrast: 100, invert: false, splices: [], signalClippedFraction: 0, membraneId: "m1" },
    ],
  });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.warnings, []);
}

function testPwaShell() {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some(({ sizes }) => sizes === "any"));
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /navigator\.serviceWorker\.register\("\.\/sw\.js"\)/);
  assert.ok(fs.readFileSync(path.join(root, "sw.js"), "utf8").includes("./wb-core.js"));
}

[
  testZip,
  testTiff,
  testPdf,
  testXlsx,
  testDarkAndBrightRois,
  testNormalizationAndPrism,
  testQc,
  testPwaShell,
].forEach((test) => {
  test();
  console.log(`✓ ${test.name}`);
});

console.log("WB core and PWA checks passed.");
