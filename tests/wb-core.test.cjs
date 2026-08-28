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

function testSampleMapImport() {
  const tsv = "\ufeff泳道\t样本ID\t泳道标签\t组别\t生物学重复\t技术重复\t排除\t排除原因\n"
    + "2\tC2\tControl 2\tControl\t2\t\t否\t\n"
    + "1\tC1\tControl 1\tControl\t1\t\t0\t\n"
    + "3\tD1\tDrug 1\tDrug\t1\t\t是\t样本污染";
  const samples = core.parseSampleMapTable(tsv);
  assert.deepEqual(samples.map(({ lane, sampleId, group, excluded }) => ({ lane, sampleId, group, excluded })), [
    { lane: 1, sampleId: "C1", group: "Control", excluded: false },
    { lane: 2, sampleId: "C2", group: "Control", excluded: false },
    { lane: 3, sampleId: "D1", group: "Drug", excluded: true },
  ]);
  assert.equal(samples[2].exclusionNote, "样本污染");

  const quoted = core.parseSampleMapTable('lane,sample_id,lane_label,group,biological_replicate,technical_replicate,excluded,exclusion_note\n1,"Sample, A",Sample A,Control,1,,,\n2,Sample B,Sample B,Drug,1,,,');
  assert.equal(quoted[0].sampleId, "Sample, A");
  assert.throws(() => core.parseSampleMapTable("lane,sample,group,replicate\n1,A,C,1\n1,B,C,2"), /连续编号/);
  assert.throws(() => core.parseSampleMapTable("lane,sample,group,replicate,excluded,note\n1,A,C,1,maybe,"), /排除值/);
  assert.throws(() => core.parseSampleMapTable("lane,sample,group,replicate,excluded,note\n1,A,C,1,yes,"), /排除原因/);
  assert.throws(() => core.parseSampleMapTable("lane,sample,group\n1,A,C"), /生物学重复/);
  assert.throws(() => core.parseSampleMapTable("lane,sample,sample_id,group,replicate\n1,A,A,C,1"), /重复字段/);
  assert.throws(() => core.parseSampleMapTable('lane,sample,group,replicate\n1,A,"Control, baseline",1'), /组别不能包含/);
  assert.throws(() => core.parseSampleMapTable('lane,sample,lane_label,group,replicate\n1,A,"Lane, 1",Control,1'), /泳道标签不能包含/);
  assert.throws(() => core.parseSampleMapTable('lane,sample,group,replicate\n1,"Sample, A",Control,1'), /泳道标签不能包含/);
}

function syntheticBands({ width = 300, height = 100, background = 200, bandValues = [80, 110, 140], bright = false } = {}) {
  const pixels = new Uint8Array(width * height).fill(background);
  const laneWidth = width / bandValues.length;
  bandValues.forEach((value, lane) => {
    const offset = lane === 1 ? 2 : lane === 2 ? -2 : 0;
    const yStart = 60 + offset;
    for (let y = yStart; y < yStart + 22; y += 1) {
      for (let x = Math.floor(lane * laneWidth + laneWidth * .08); x < Math.ceil((lane + 1) * laneWidth - laneWidth * .08); x += 1) pixels[y * width + x] = value;
    }
  });
  return { pixels, width, height, polarity: bright ? "bright" : "dark" };
}

function testRoiSuggestions() {
  const dark = syntheticBands();
  const suggested = core.suggestLaneRois({ ...dark, laneCount: 3 });
  assert.equal(suggested.method, "row-contrast-v1");
  assert.equal(suggested.lanes.length, 3);
  suggested.lanes.forEach(({ band, background, contrastZ }) => {
    assert.equal(band.w, background.w);
    assert.equal(band.h, background.h);
    assert.ok(band.y <= 70 && band.y + band.h >= 70, "suggested band should cover the synthetic signal");
    assert.ok(band.x >= 0 && band.y >= 0 && band.x + band.w <= dark.width && band.y + band.h <= dark.height);
    assert.ok(background.y + background.h <= band.y || band.y + band.h <= background.y);
    assert.ok(contrastZ >= 3);
  });
  assert.equal(suggested.status, "clear");

  const bright = syntheticBands({ background: 20, bandValues: [220, 210, 200], bright: true });
  assert.equal(core.suggestLaneRois({ ...bright, laneCount: 3 }).status, "clear");
  const flat = core.suggestLaneRois({ pixels: new Uint8Array(300 * 100).fill(200), width: 300, height: 100, laneCount: 3, polarity: "dark" });
  assert.equal(flat.status, "low");
  assert.ok(flat.lanes.every((lane) => lane.qc.includes("ROI_SIGNAL_LOW_CONFIDENCE")));
  assert.equal(core.suggestLaneRois({ ...dark, crop: { x: .4, y: .4, w: 299.6, h: 99.6 }, laneCount: 3 }).lanes.length, 3);
  assert.equal(core.suggestLaneRois({ pixels: new Uint8Array(3 * 200000).fill(200), width: 3, height: 200000, laneCount: 1 }).lanes.length, 1);
}

function testManualRowLineRois() {
  const width = 30;
  const height = 40;
  const pixels = Uint8Array.from({ length: width * height }, (_, index) => Math.floor(index / width) * 5);
  const input = { pixels, width, height, crop: { x: 3, y: 4, w: 24, h: 32 }, laneCount: 2, bandCenterY: 20, roiHeight: 4 };
  const dark = core.laneRoisAtBandCenter({ ...input, polarity: "dark" });
  const bright = core.laneRoisAtBandCenter({ ...input, polarity: "bright" });
  assert.equal(dark.method, "manual-row-line-v1");
  assert.equal(dark.lanes.length, 2);
  assert.equal(dark.lanes[0].band.y, 18);
  assert.equal(dark.lanes[0].band.h, 4);
  assert.equal(dark.lanes[0].background.y, 28, "dark polarity chooses the brightest clean local background");
  assert.equal(bright.lanes[0].background.y, 8, "bright polarity chooses the darkest clean local background");
  [dark, bright].flatMap(({ lanes }) => lanes).forEach((lane) => {
    assert.equal(lane.band.y, 18, "the user line fixes one shared band row across lanes");
    assert.ok(lane.background.y + lane.background.h <= lane.band.y || lane.band.y + lane.band.h <= lane.background.y);
    assert.ok(lane.band.x >= 3 && lane.band.x + lane.band.w <= 27);
    assert.ok(lane.background.y >= 4 && lane.background.y + lane.background.h <= 36);
  });
  assert.throws(() => core.laneRoisAtBandCenter({ ...input, bandCenterY: 5 }), /inside the crop/);
  assert.throws(() => core.laneRoisAtBandCenter({ ...input, bandCenterY: 35 }), /inside the crop/);
}

function testExposureSeries() {
  const linear = core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 100, signalClippedFraction: 0 }] },
    { time: 2, lanes: [{ corrected: 200, signalClippedFraction: 0 }] },
    { time: 4, lanes: [{ corrected: 400, signalClippedFraction: 0 }] },
  ]);
  assert.equal(linear.status, "consistent");
  assert.equal(linear.lanes[0].r2, 1);
  assert.equal(linear.lanes[0].responseCv, 0);

  const plateau = core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 100, signalClippedFraction: 0 }] },
    { time: 2, lanes: [{ corrected: 180, signalClippedFraction: 0 }] },
    { time: 4, lanes: [{ corrected: 185, signalClippedFraction: .02 }] },
  ]);
  assert.equal(plateau.status, "review");
  assert.ok(plateau.lanes[0].codes.includes("SATURATION_HIGH"));
  assert.ok(plateau.lanes[0].codes.includes("RESPONSE_RATE_CV_HIGH"));
  const clippedBackground = core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 100, backgroundClippedFraction: 1 }] },
    { time: 2, lanes: [{ corrected: 200, backgroundClippedFraction: 1 }] },
    { time: 4, lanes: [{ corrected: 400, backgroundClippedFraction: 1 }] },
  ]);
  assert.equal(clippedBackground.status, "review");
  assert.ok(clippedBackground.lanes[0].codes.includes("BACKGROUND_CLIPPING_HIGH"));
  const endpointPresent = core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 100, signalClippedFraction: .005 }] },
    { time: 2, lanes: [{ corrected: 200, signalClippedFraction: .005 }] },
    { time: 4, lanes: [{ corrected: 400, signalClippedFraction: .005 }] },
  ]);
  assert.equal(endpointPresent.status, "consistent", "endpoint fractions below the declared 1% threshold are non-blocking");
  assert.ok(endpointPresent.lanes[0].codes.includes("SIGNAL_ENDPOINT_PRESENT"));
  const invalid = core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 0 }, { corrected: 100 }] },
    { time: 2, lanes: [{ corrected: 10 }, { corrected: 200 }] },
    { time: 4, lanes: [{ corrected: 20 }, { corrected: 400 }] },
  ]);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.lanes[0].status, "invalid");
  assert.equal(core.assessExposureSeries([
    { time: 1, lanes: [{ corrected: 100 }] },
    { time: 2, lanes: [{ corrected: 200 }] },
  ]).status, "insufficient");
  assert.throws(() => core.assessExposureSeries([{ time: 1, lanes: [{ corrected: 1 }] }, { time: 1, lanes: [{ corrected: 2 }] }]), /unique/);
  assert.throws(() => core.assessExposureSeries([{ time: 0, lanes: [{ corrected: 1 }] }, { time: 1, lanes: [{ corrected: 2 }] }]), /positive/);
  assert.throws(() => core.assessExposureSeries([{ time: 1, lanes: [{ corrected: 1 }] }, { time: 2, lanes: [{ corrected: 2 }, { corrected: 3 }] }]), /lane counts/);
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
  assert.equal(dark.fijiIntDen, 4 * 255 - (20 + 30 + 20 + 30), "dark Fiji/JAR compatibility IntDen is the inverted band sum before background subtraction");
  assert.equal(dark.corrected, 700);
  assert.notEqual(dark.fijiIntDen, dark.corrected, "Fiji/JAR compatibility IntDen must remain uncorrected for background");
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
  assert.equal(bright.fijiIntDen, 230 + 240 + 230 + 240, "bright Fiji/JAR compatibility IntDen is the raw band sum before background subtraction");
  assert.equal(bright.corrected, 860);
  assert.notEqual(bright.fijiIntDen, bright.corrected, "Fiji/JAR compatibility IntDen must remain uncorrected for background");
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

function testBrightPolarityEqualsInvertedDark() {
  const pixels = Uint8Array.of(230, 240, 20, 20, 230, 240, 20, 20);
  const input = {
    width: 4,
    height: 2,
    band: { x: 0, y: 0, w: 2, h: 2 },
    background: { x: 2, y: 0, w: 2, h: 2 },
  };
  const bright = core.quantifyRoiPair({ ...input, pixels, polarity: "bright" });
  const invertedDark = core.quantifyRoiPair({
    ...input,
    pixels: Uint8Array.from(pixels, (value) => 255 - value),
    polarity: "dark",
  });
  assert.equal(bright.fijiIntDen, invertedDark.fijiIntDen);
  assert.equal(bright.corrected, invertedDark.corrected);
  assert.equal(bright.bandMean, 255 - invertedDark.bandMean);
  assert.equal(bright.backgroundMean, 255 - invertedDark.backgroundMean);
  assert.deepEqual(bright.qc, invertedDark.qc);
}

function testDisplayBackgroundFlattening() {
  const width = 60;
  const height = 18;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      let value = 128 + Math.round(x * 1.3) + Math.round(y * .8);
      if ((x - 43) ** 2 / 180 + (y - 5) ** 2 / 10 < 1) value += 45;
      if (y >= 7 && y <= 10 && ((x >= 8 && x <= 14) || (x >= 28 && x <= 34) || (x >= 46 && x <= 52))) value -= 95;
      if (y >= 7 && y <= 10 && x >= 19 && x <= 24) value -= 28;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  const flattened = core.flattenDisplayBackground({ rgba, width, height, strength: 100 });
  const background = (x, y = 2) => flattened[(y * width + x) * 4];
  const band = (x) => flattened[(8 * width + x) * 4];
  const originalBand = (x) => rgba[(8 * width + x) * 4];
  const backgroundSamples = [background(4), background(22), background(42), background(55), background(42, 5), background(18, 14)];
  assert.ok(Math.max(...backgroundSamples) - Math.min(...backgroundSamples) < 18, "two-dimensional white-field patches should be flattened");
  assert.ok(background(11) - band(11) > 55, "dark band contrast should remain visible after display correction");
  assert.ok(Math.abs(band(11) - originalBand(11)) < 12, "dark band pixels should be protected from background brightening");
  assert.ok(Math.abs(band(21) - originalBand(21)) < 12, "weak band pixels should be protected from background brightening");
  assert.deepEqual(core.flattenDisplayBackground({ rgba, width, height, strength: 0 }), rgba, "zero strength must leave display pixels unchanged");
}

function testAutomaticStripRotation() {
  const width = 160;
  const height = 32;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const slope = .07;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const center = 9 + slope * x;
      const inBand = Math.abs(y - center) <= 1.4 && Math.floor(x / 16) % 2 === 0;
      const value = inBand ? 45 : 218 + Math.round(x / width * 18);
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  const angle = core.estimateStripRotation({ rgba, width, height });
  assert.ok(Math.abs(angle + Math.atan(slope) * 180 / Math.PI) < .8, `automatic rotation should correct the shared strip slope, received ${angle}`);
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

function testCleavageNormalization() {
  const fragment = {
    key: "gsdmb-n",
    name: "GSDMB-N",
    lanes: [
      { bandSum: 150, backgroundSum: 50, backgroundMean: 5, fijiIntDen: 2050, corrected: 100, qc: [] },
      { bandSum: 350, backgroundSum: 50, backgroundMean: 5, fijiIntDen: 2250, corrected: 300, qc: [] },
      { bandSum: 250, backgroundSum: 50, backgroundMean: 5, fijiIntDen: 2150, corrected: 200, qc: [] },
      { bandSum: 50, backgroundSum: 50, backgroundMean: 5, fijiIntDen: 2050, corrected: 0, qc: ["POLARITY_OR_SIGNAL_INVALID"] },
      { bandSum: 850, backgroundSum: 50, backgroundMean: 5, fijiIntDen: 2750, corrected: 800, qc: [] },
    ],
  };
  const fullLength = {
    key: "gsdmb-fl",
    name: "GSDMB-FL",
    lanes: [100, 100, 100, 0, 200].map((corrected) => ({
      bandSum: corrected + 40,
      backgroundSum: 40,
      backgroundMean: 4,
      fijiIntDen: corrected + 2000,
      corrected,
      qc: [],
    })),
  };
  const samples = [
    { sampleId: "C1a", group: "Control", biologicalReplicate: 1, technicalReplicate: 1 },
    { sampleId: "C1b", group: "Control", biologicalReplicate: 1, technicalReplicate: 2 },
    { sampleId: "C2", group: "Control", biologicalReplicate: 2 },
    { sampleId: "C-excluded", group: "Control", biologicalReplicate: 3, excluded: true },
    { sampleId: "D1", group: "Drug", biologicalReplicate: 1 },
  ];
  const rows = core.normalizeCleavageMeasurements(fragment, fullLength, samples, "Control");

  assert.equal(rows[0].ratioFormula, "N/FL");
  assert.equal(rows[0].fragmentFullLengthRatio, 1, "ratio is N/FL, not N/(N+FL)");
  assert.equal(rows[0].biologicalFragmentFullLengthRatio, 2, "technical N/FL replicates are averaged first");
  assert.equal(rows[0].controlMeanFragmentFullLengthRatio, 2, "control baseline uses biological replicates");
  assert.equal(rows[4].fragmentFullLengthRatio, 4);
  assert.equal(rows[4].foldChange, 2);
  assert.equal(rows[3].fragmentFullLengthRatio, null, "an excluded invalid lane remains reportable without being normalized");
  assert.equal(rows[3].biologicalFragmentFullLengthRatio, null, "excluded lanes do not contribute a biological value");
  assert.equal(rows[3].foldChange, null);
  assert.ok(rows[3].qc.includes("NORMALIZATION_INVALID"));
  assert.strictEqual(rows[0].fragmentMeasurement, fragment.lanes[0], "raw, background, corrected and Fiji fields are preserved");
  assert.strictEqual(rows[0].fullLengthMeasurement, fullLength.lanes[0]);
  assert.deepEqual(
    [rows[0].fragmentMeasurement.bandSum, rows[0].fragmentMeasurement.backgroundSum, rows[0].fragmentMeasurement.corrected, rows[0].fragmentMeasurement.fijiIntDen],
    [150, 50, 100, 2050],
  );

  assert.throws(
    () => core.normalizeCleavageMeasurements({ ...fragment, lanes: [{ corrected: 0 }] }, { ...fullLength, lanes: [{ corrected: 1 }] }, [samples[0]], "Control"),
    /positive background-corrected intensity/,
  );
  assert.throws(
    () => core.normalizeCleavageMeasurements({ ...fragment, lanes: [{ corrected: 1 }] }, { ...fullLength, lanes: [{ corrected: NaN }] }, [samples[0]], "Control"),
    /positive background-corrected intensity/,
  );
  assert.throws(
    () => core.normalizeCleavageMeasurements({ ...fragment, lanes: fragment.lanes.slice(0, 1) }, fullLength, samples, "Control"),
    /same number of lanes/,
  );
}

function testOrdinaryAnovaDunnett() {
  const result = core.ordinaryAnovaDunnett([
    { name: "control", values: [.682295422, .693432712, .905426369] },
    { name: "sh1", values: [.119780948, .161386194, .213168795] },
    { name: "sh2", values: [.124205847, .172884828, .177363983] },
  ], "control");
  assert.equal(result.df, 6);
  assert.ok(Math.abs(result.mse - .006288999278774584) < 1e-15);
  assert.deepEqual(result.groups.map(({ name, n }) => ({ name, n })), [
    { name: "control", n: 3 }, { name: "sh1", n: 3 }, { name: "sh2", n: 3 },
  ]);
  assert.ok(Math.abs(result.groups[0].mean - .7603848343333333) < 1e-15);
  assert.ok(Math.abs(result.groups[0].sd - .12573303023065344) < 1e-15);
  assert.ok(Math.abs(result.comparisons[0].t - 9.1984374342) < 1e-10);
  assert.ok(Math.abs(result.comparisons[1].t - 9.3007850953) < 1e-10);
  assert.ok(Math.abs(result.comparisons[0].pAdjusted - .0001691208931) < 2e-8);
  assert.ok(Math.abs(result.comparisons[1].pAdjusted - .0001588807922) < 2e-8);
  result.comparisons.forEach(({ pAdjusted }) => assert.ok(pAdjusted >= 0 && pAdjusted <= 1));

  const oneComparison = core.ordinaryAnovaDunnett([
    { name: "control", values: [1, 2, 3] },
    { name: "treatment", values: [2, 3, 4] },
  ], "control");
  const exactTwoSidedStudentT = 1 - 1.5 * Math.sqrt(3 / 11) + .5 * Math.sqrt(3 / 11) ** 3;
  assert.ok(Math.abs(oneComparison.comparisons[0].pAdjusted - exactTwoSidedStudentT) < 1e-12, "one Dunnett comparison must equal the two-sided Student t test");
  const lowDf = core.ordinaryAnovaDunnett([
    { name: "control", values: [0, 1] },
    { name: "treatment", values: [1, 2] },
  ], "control");
  assert.ok(Math.abs(lowDf.comparisons[0].pAdjusted - (1 - 1 / Math.sqrt(2))) < 1e-12, "the exact Student t branch must remain accurate at df=2");

  const noDifference = core.ordinaryAnovaDunnett([
    { name: "control", values: [1, 2, 3] },
    { name: "same", values: [1, 2, 3] },
  ], "control");
  assert.equal(noDifference.comparisons[0].t, 0);
  assert.equal(noDifference.comparisons[0].pAdjusted, 1);

  const zeroMse = core.ordinaryAnovaDunnett([
    { name: "control", values: [1, 1] },
    { name: "same", values: [1, 1] },
    { name: "different", values: [2, 2] },
  ], "control");
  assert.deepEqual(zeroMse.comparisons.map(({ t, pAdjusted }) => ({ t, pAdjusted })), [
    { t: 0, pAdjusted: 1 }, { t: -Infinity, pAdjusted: 0 },
  ]);
  assert.throws(() => core.ordinaryAnovaDunnett([{ name: "only", values: [1, 2] }], "only"), /at least two groups/);
  assert.throws(() => core.ordinaryAnovaDunnett([{ name: "a", values: [1, 2] }, { name: "b", values: [3] }], "a"), /at least two biological replicates/);
  assert.throws(() => core.ordinaryAnovaDunnett([{ name: "a", values: [1, 2] }, { name: "b", values: [3, NaN] }], "a"), /non-finite/);
  assert.throws(() => core.ordinaryAnovaDunnett([{ name: "a", values: [1, 2] }, { name: "b", values: [3, 4] }], "missing"), /was not found/);
}

function testPrismPlotGeometry() {
  assert.deepEqual(core.prismPlotGeometry(3), {
    logicalWidth: 205.44, logicalHeight: 273.6, plotLeft: 65.04, plotTop: 80.64, plotWidth: 106.19999999999999, plotHeight: 144, barWidth: 21.12, rotateGroupLabels: false,
  });
  const six = core.prismPlotGeometry(6);
  assert.ok(Math.abs(six.logicalWidth - 211.32) < 1e-12);
  assert.equal(six.logicalHeight, 268.8);
  assert.equal(six.plotTop, 41.88);
  assert.equal(six.plotWidth, 144);
  assert.ok(Math.abs(six.barWidth - 15.157894736842104) < 1e-12);
  assert.equal(six.rotateGroupLabels, true);
  const ten = core.prismPlotGeometry(10);
  assert.ok(Math.abs(ten.logicalWidth - 284.28) < 1e-12);
  assert.equal(ten.plotWidth, 216);
  assert.ok(Math.abs(ten.barWidth - 13.935483870967742) < 1e-12);
  assert.deepEqual(core.prismPlotColors(3), ["#3f69a9", "#d96025", "#e69d21"]);
  assert.deepEqual(core.prismPlotColors(6), ["#3f69a9", "#3f69a9", "#3f69a9", "#3f69a9", "#d96025", "#e69d21"]);
  assert.deepEqual(core.prismPlotColors(10), [...Array(9).fill("#3f69a9"), "#d96025"]);
  assert.throws(() => core.prismPlotGeometry(0), /integer from 1 to 24/);
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
  assert.equal(core.ENGINE_VERSION, "2.8.0");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal(manifest.name, "实验室工作台 · WB 组图与灰度");
  assert.equal(manifest.short_name, "WB 工作台");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some(({ sizes }) => sizes === "any"));
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /navigator\.serviceWorker\.register\("\.\/sw\.js"\)/);
  const worker = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.ok(worker.includes("./wb-core.js"));
  assert.ok(worker.includes("figurelab-wb-v2.8.0"));
  ["sampleMapText", "quantRoiHeight", "suggestRois", "exposureCheck", "downloadExposureReport", "quantPlotTarget", "exportQuantPlotPng", "editBackgroundClean", "editRotation", "autoStraighten", "quantNormalizationMode", "quantNumerator", "quantDenominator", "createCleavagePair", "guideRois", "quantQuickResults", "openGrayReader", "grayReaderFile", "grayReaderFolder", "chooseGrayReaderFolder", "previousGrayReaderFile", "nextGrayReaderFile", "grayReaderProgress", "grayReaderLaneCount", "grayReaderRoiHeight", "grayReaderCanvas", "grayReaderResults", "copyGrayReaderValues", "downloadGrayReaderCsv", "downloadGrayReaderAuditCsv"].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  assert.match(html, /id="grayReaderFile"[^>]*multiple/);
  assert.match(html, /id="grayReaderFolder"[^>]*webkitdirectory/);
  assert.match(html, /window\.WBCore\.normalizeCleavageMeasurements\(/);
  assert.match(html, /window\.WBCore\.laneRoisAtBandCenter\(/);
  assert.match(html, /ordinaryAnovaDunnett\(groups, state\.quant\.controlGroup\)/);
  assert.match(html, /✱✱✱/);
  assert.match(html, /Segoe UI Symbol/);
}

function testUnifiedSuiteShell() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const shell = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || "";
  assert.match(html, /<title>实验室工作台 · WB 组图与灰度<\/title>/);
  assert.match(html, /font-family: Arial, "Microsoft YaHei", "PingFang SC", sans-serif/);
  assert.match(shell, /<nav class="suite-nav" aria-label="实验室工具套件">/);
  assert.match(shell, /实验室工作台/);
  assert.match(shell, /href="https:\/\/weigenwu\.github\.io\/ikun-calculator\/">实验流程<\/a>/);
  assert.match(shell, /href="#top" aria-current="page">WB<\/a>/);
  assert.match(shell, /href="https:\/\/if-group-pictures\.onrender\.com\/"[^>]*>IF \/ IHC<\/a>/);
  assert.match(shell, /本地处理/);
  assert.doesNotMatch(shell, /target="_blank"/);
}

[
  testZip,
  testTiff,
  testPdf,
  testXlsx,
  testSampleMapImport,
  testRoiSuggestions,
  testManualRowLineRois,
  testExposureSeries,
  testDarkAndBrightRois,
  testBrightPolarityEqualsInvertedDark,
  testDisplayBackgroundFlattening,
  testAutomaticStripRotation,
  testNormalizationAndPrism,
  testCleavageNormalization,
  testOrdinaryAnovaDunnett,
  testPrismPlotGeometry,
  testQc,
  testPwaShell,
  testUnifiedSuiteShell,
].forEach((test) => {
  test();
  console.log(`✓ ${test.name}`);
});

console.log("WB core, assay workflow and PWA checks passed.");
