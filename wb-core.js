(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WBCore = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const ENGINE_VERSION = "2.1.0";
  const encoder = new TextEncoder();

  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return encoder.encode(String(value));
  }

  function concat(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function crc32(input) {
    const data = bytes(input);
    let crc = 0xffffffff;
    for (const value of data) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosTime(date) {
    const value = date instanceof Date ? date : new Date(date || Date.now());
    const year = Math.max(1980, value.getFullYear());
    return {
      time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    };
  }

  function zipStore(entries) {
    const locals = [];
    const centrals = [];
    let localOffset = 0;
    const stamp = dosTime(new Date());
    entries.forEach((entry) => {
      const name = bytes(String(entry.name).replaceAll("\\", "/").replace(/^\/+/, ""));
      const data = bytes(entry.data);
      const checksum = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      locals.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, stamp.time, true);
      centralView.setUint16(14, stamp.date, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, localOffset, true);
      central.set(name, 46);
      centrals.push(central);
      localOffset += local.length + data.length;
    });

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    return concat([...locals, ...centrals, end]);
  }

  function encodeTiffRgba(width, height, rgba, dpi = 300) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("TIFF dimensions are invalid");
    const source = bytes(rgba);
    if (source.length !== width * height * 4) throw new Error("RGBA byte length does not match dimensions");
    const entryCount = 13;
    const ifdOffset = 8;
    const ifdEnd = ifdOffset + 2 + entryCount * 12 + 4;
    const bitsOffset = ifdEnd;
    const xResolutionOffset = bitsOffset + 6;
    const yResolutionOffset = xResolutionOffset + 8;
    const pixelOffset = yResolutionOffset + 8;
    const pixelBytes = width * height * 3;
    const output = new Uint8Array(pixelOffset + pixelBytes);
    const view = new DataView(output.buffer);
    output[0] = 0x49;
    output[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdOffset, true);
    view.setUint16(ifdOffset, entryCount, true);
    let cursor = ifdOffset + 2;
    const entry = (tag, type, count, value) => {
      view.setUint16(cursor, tag, true);
      view.setUint16(cursor + 2, type, true);
      view.setUint32(cursor + 4, count, true);
      if (type === 3 && count === 1) view.setUint16(cursor + 8, value, true);
      else view.setUint32(cursor + 8, value, true);
      cursor += 12;
    };
    entry(256, 4, 1, width);
    entry(257, 4, 1, height);
    entry(258, 3, 3, bitsOffset);
    entry(259, 3, 1, 1);
    entry(262, 3, 1, 2);
    entry(273, 4, 1, pixelOffset);
    entry(277, 3, 1, 3);
    entry(278, 4, 1, height);
    entry(279, 4, 1, pixelBytes);
    entry(282, 5, 1, xResolutionOffset);
    entry(283, 5, 1, yResolutionOffset);
    entry(284, 3, 1, 1);
    entry(296, 3, 1, 2);
    view.setUint32(cursor, 0, true);
    [0, 2, 4].forEach((offset) => view.setUint16(bitsOffset + offset, 8, true));
    view.setUint32(xResolutionOffset, Math.round(dpi), true);
    view.setUint32(xResolutionOffset + 4, 1, true);
    view.setUint32(yResolutionOffset, Math.round(dpi), true);
    view.setUint32(yResolutionOffset + 4, 1, true);
    let target = pixelOffset;
    for (let index = 0; index < source.length; index += 4) {
      const alpha = source[index + 3] / 255;
      output[target++] = Math.round(source[index] * alpha + 255 * (1 - alpha));
      output[target++] = Math.round(source[index + 1] * alpha + 255 * (1 - alpha));
      output[target++] = Math.round(source[index + 2] * alpha + 255 * (1 - alpha));
    }
    return output;
  }

  function pdfString(value) {
    return String(value || "").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replace(/[\r\n]+/g, " ");
  }

  function pdfFromJpegs(pages, metadata = {}) {
    if (!Array.isArray(pages) || !pages.length) throw new Error("PDF requires at least one page");
    const objects = [null];
    const pageIds = [];
    const imageIds = [];
    const contentIds = [];
    pages.forEach(() => {
      pageIds.push(objects.length); objects.push(null);
      imageIds.push(objects.length); objects.push(null);
      contentIds.push(objects.length); objects.push(null);
    });
    const pagesId = objects.length; objects.push(null);
    const catalogId = objects.length; objects.push(null);
    const infoId = objects.length; objects.push(null);

    pages.forEach((page, index) => {
      const jpeg = bytes(page.jpeg || page.data);
      const dpi = Number(page.dpi) > 0 ? Number(page.dpi) : 300;
      const widthPt = Number((page.width / dpi * 72).toFixed(4));
      const heightPt = Number((page.height / dpi * 72).toFixed(4));
      const content = bytes(`q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Im0 Do\nQ\n`);
      objects[pageIds[index]] = bytes(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im0 ${imageIds[index]} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`);
      objects[imageIds[index]] = concat([
        bytes(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
        jpeg,
        bytes("\nendstream"),
      ]);
      objects[contentIds[index]] = concat([bytes(`<< /Length ${content.length} >>\nstream\n`), content, bytes("endstream")]);
    });
    objects[pagesId] = bytes(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
    objects[catalogId] = bytes(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    objects[infoId] = bytes(`<< /Title (${pdfString(metadata.title)}) /Author (${pdfString(metadata.author || "FigureLab")}) /Subject (${pdfString(metadata.subject || "Scientific figure export")}) /Creator (FigureLab WB ${ENGINE_VERSION}) >>`);

    const parts = [bytes("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
    const offsets = [0];
    let offset = parts[0].length;
    for (let id = 1; id < objects.length; id += 1) {
      const object = concat([bytes(`${id} 0 obj\n`), objects[id], bytes("\nendobj\n")]);
      offsets[id] = offset;
      parts.push(object);
      offset += object.length;
    }
    const xrefOffset = offset;
    const xref = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
    for (let id = 1; id < objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    parts.push(bytes(xref.join("")));
    parts.push(bytes(`trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return concat(parts);
  }

  function xml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function excelColumn(index) {
    let value = index + 1;
    let name = "";
    while (value) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function worksheetXml(rows) {
    const body = rows.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        const ref = `${excelColumn(columnIndex)}${rowIndex + 1}`;
        if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  }

  function xlsxWorkbook(sheets, metadata = {}) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error("XLSX requires at least one sheet");
    const usedNames = new Set();
    const safeSheets = sheets.map((sheet, index) => {
      const base = String(sheet.name || `Sheet${index + 1}`).replace(/[\\/*?:\[\]]/g, "_").slice(0, 31) || `Sheet${index + 1}`;
      let name = base;
      let suffix = 2;
      while (usedNames.has(name.toLowerCase())) {
        const tail = `_${suffix++}`;
        name = base.slice(0, 31 - tail.length) + tail;
      }
      usedNames.add(name.toLowerCase());
      return { name, rows: Array.isArray(sheet.rows) ? sheet.rows : [] };
    });
    const contentTypes = safeSheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    const workbookSheets = safeSheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
    const workbookRels = safeSheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
    const entries = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>` },
      { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(metadata.title || "FigureLab WB quantification")}</dc:title><dc:creator>FigureLab</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>` },
      { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FigureLab</Application></Properties>` },
    ];
    safeSheets.forEach((sheet, index) => entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheetXml(sheet.rows) }));
    return zipStore(entries);
  }

  const SAMPLE_MAP_HEADERS = {
    lane: ["lane", "laneno", "lanenumber", "泳道", "泳道号", "泳道编号"],
    sampleId: ["sample", "sampleid", "样本", "样本id", "样本编号"],
    laneLabel: ["lanelabel", "label", "displaylabel", "泳道标签", "显示标签"],
    group: ["group", "condition", "treatment", "组别", "分组", "处理组"],
    biologicalReplicate: ["biologicalreplicate", "biorep", "replicate", "生物学重复", "生物学重复编号", "生物重复", "生物重复编号"],
    technicalReplicate: ["technicalreplicate", "techrep", "技术重复", "技术重复编号"],
    excluded: ["excluded", "exclude", "omit", "isexcluded", "排除", "是否排除"],
    exclusionNote: ["exclusionnote", "reason", "note", "notes", "备注", "说明", "排除原因"],
  };

  function normalizedHeader(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s_\-()（）/]+/g, "");
  }

  function delimitedRows(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else cell += character;
      } else if (character === '"' && !cell.trim()) {
        cell = "";
        quoted = true;
      } else if (character === delimiter) {
        row.push(cell.trim());
        cell = "";
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        cell = "";
      } else cell += character;
    }
    if (quoted) throw new Error("样本表包含未闭合的引号");
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function parseSampleMapTable(input) {
    if (typeof input !== "string") throw new Error("样本表必须是文本");
    const text = input.replace(/^\ufeff/, "").trim();
    if (!text) throw new Error("样本表为空");
    if (text.length > 262144) throw new Error("样本表不能超过 256 KB");
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delimiter = firstLine.includes("\t") ? "\t" : ((firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",");
    const rows = delimitedRows(text, delimiter);
    if (rows.length < 2) throw new Error("样本表至少需要表头和一行数据");
    const aliases = new Map(Object.entries(SAMPLE_MAP_HEADERS).flatMap(([key, values]) => values.map((value) => [normalizedHeader(value), key])));
    const columns = new Map();
    rows[0].forEach((header, index) => {
      const key = aliases.get(normalizedHeader(header));
      if (!key) return;
      if (columns.has(key)) throw new Error(`样本表有重复字段：${header}`);
      columns.set(key, index);
    });
    [["lane", "泳道"], ["sampleId", "样本 ID"], ["group", "组别"], ["biologicalReplicate", "生物学重复"]].forEach(([key, label]) => {
      if (!columns.has(key)) throw new Error(`样本表缺少必填字段：${label}`);
    });
    if (rows.length - 1 > 24) throw new Error("样本表最多支持 24 个泳道");
    const value = (row, key) => columns.has(key) ? String(row[columns.get(key)] || "").trim() : "";
    const parseExcluded = (raw, line) => {
      const normalized = normalizedHeader(raw);
      if (["", "0", "false", "no", "n", "否"].includes(normalized)) return false;
      if (["1", "true", "yes", "y", "是", "排除"].includes(normalized)) return true;
      throw new Error(`第 ${line} 行的排除值无法识别`);
    };
    const samples = rows.slice(1).map((row, index) => {
      const line = index + 2;
      const lane = Number(value(row, "lane"));
      const sampleId = value(row, "sampleId");
      const laneLabel = value(row, "laneLabel") || sampleId;
      const group = value(row, "group");
      const biologicalReplicate = value(row, "biologicalReplicate");
      const technicalReplicate = value(row, "technicalReplicate");
      const excluded = parseExcluded(value(row, "excluded"), line);
      const exclusionNote = value(row, "exclusionNote");
      if (!Number.isInteger(lane) || lane < 1 || lane > 24) throw new Error(`第 ${line} 行的泳道必须是 1–24 的整数`);
      if (!sampleId) throw new Error(`第 ${line} 行缺少样本 ID`);
      if (!group) throw new Error(`第 ${line} 行缺少组别`);
      if (/[,，;；\r\n]/.test(group)) throw new Error(`第 ${line} 行的组别不能包含逗号、分号或换行`);
      if (/[,，;；\r\n]/.test(laneLabel)) throw new Error(`第 ${line} 行的泳道标签不能包含逗号、分号或换行`);
      if (!biologicalReplicate) throw new Error(`第 ${line} 行缺少生物学重复编号`);
      if (sampleId.length > 80 || laneLabel.length > 40 || group.length > 40 || biologicalReplicate.length > 40 || technicalReplicate.length > 40 || exclusionNote.length > 200) throw new Error(`第 ${line} 行有字段超过长度限制`);
      if (excluded && !exclusionNote) throw new Error(`第 ${line} 行已排除，但没有填写排除原因`);
      return { lane, sampleId, laneLabel, group, biologicalReplicate, technicalReplicate, excluded, exclusionNote };
    }).sort((left, right) => left.lane - right.lane);
    samples.forEach((sample, index) => {
      if (sample.lane !== index + 1) throw new Error(`泳道需要从 1 连续编号；缺少或重复第 ${index + 1} 道`);
    });
    const replicateGroups = new Map();
    samples.forEach((sample) => {
      const key = `${sample.group}\u001f${sample.biologicalReplicate}`;
      const group = replicateGroups.get(key) || [];
      group.push(sample);
      replicateGroups.set(key, group);
    });
    replicateGroups.forEach((group) => {
      if (group.length < 2) return;
      if (group.some((sample) => !sample.technicalReplicate)) throw new Error(`${group[0].group} 的生物学重复 ${group[0].biologicalReplicate} 出现多次，请填写技术重复编号`);
      if (new Set(group.map((sample) => sample.technicalReplicate)).size !== group.length) throw new Error(`${group[0].group} 的生物学重复 ${group[0].biologicalReplicate} 有重复的技术重复编号`);
    });
    return samples;
  }

  function windowAverages(values, size) {
    const output = [];
    let sum = 0;
    values.forEach((value, index) => {
      sum += value;
      if (index >= size) sum -= values[index - size];
      if (index >= size - 1) output.push(sum / size);
    });
    return output;
  }

  function suggestLaneRois(input) {
    const pixels = bytes(input.pixels);
    const width = Number(input.width);
    const height = Number(input.height);
    const laneCount = Number(input.laneCount);
    if (!Number.isInteger(width) || !Number.isInteger(height) || pixels.length !== width * height) throw new Error("Grayscale byte length does not match dimensions");
    if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 24) throw new Error("Lane count must be between 1 and 24");
    const sourceCrop = input.crop || { x: 0, y: 0, w: width, h: height };
    const values = [sourceCrop.x, sourceCrop.y, sourceCrop.w, sourceCrop.h].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0 || values[0] + values[2] > width + .001 || values[1] + values[3] > height + .001) throw new Error("Crop is too small or outside the source image");
    const crop = {
      x: Math.max(0, Math.round(values[0])),
      y: Math.max(0, Math.round(values[1])),
      w: Math.min(width, Math.round(values[0] + values[2])) - Math.max(0, Math.round(values[0])),
      h: Math.min(height, Math.round(values[1] + values[3])) - Math.max(0, Math.round(values[1])),
    };
    if (crop.w < laneCount * 3 || crop.h < 8) throw new Error("Crop is too small or outside the source image");
    const polarity = input.polarity === "bright" ? "bright" : "dark";
    const laneWidth = crop.w / laneCount;
    const boxWidth = Math.max(2, Math.min(Math.floor(laneWidth), Math.round(laneWidth * .72)));
    const boxHeight = Math.max(2, Math.min(crop.h - 4, Math.round(crop.h * .22)));
    const profiles = Array.from({ length: laneCount }, (_, laneIndex) => {
      const x = Math.max(crop.x, Math.min(crop.x + crop.w - boxWidth, Math.round(crop.x + laneIndex * laneWidth + (laneWidth - boxWidth) / 2)));
      const rows = Array.from({ length: crop.h }, (_, offsetY) => {
        let sum = 0;
        for (let px = x; px < x + boxWidth; px += 1) sum += pixels[(crop.y + offsetY) * width + px];
        return sum / boxWidth;
      });
      return { x, rows, windows: windowAverages(rows, boxHeight) };
    });
    const common = profiles[0].windows.map((_, index) => profiles.reduce((sum, profile) => sum + (polarity === "dark" ? 255 - profile.windows[index] : profile.windows[index]), 0) / laneCount);
    let commonStart = 0;
    for (let index = 1; index < common.length; index += 1) {
      if (common[index] > common[commonStart]) commonStart = index;
    }
    const profileEdge = commonStart === 0 || commonStart === common.length - 1;
    const searchRadius = Math.max(1, Math.floor(boxHeight / 2));
    const lanes = profiles.map((profile, laneIndex) => {
      let start = Math.max(0, commonStart - searchRadius);
      let bestSignal = -Infinity;
      const last = Math.min(profile.windows.length - 1, commonStart + searchRadius);
      for (let index = start; index <= last; index += 1) {
        const signal = polarity === "dark" ? 255 - profile.windows[index] : profile.windows[index];
        if (signal > bestSignal) { bestSignal = signal; start = index; }
      }
      const band = { x: profile.x, y: crop.y + start, w: boxWidth, h: boxHeight };
      const gap = 2;
      const candidateStarts = [];
      const minimum = Math.max(0, start - boxHeight * 2 - gap);
      const maximum = Math.min(profile.windows.length - 1, start + boxHeight * 2 + gap);
      for (let index = minimum; index <= maximum; index += 1) {
        if (index + boxHeight + gap <= start || index >= start + boxHeight + gap) candidateStarts.push(index);
      }
      if (!candidateStarts.length) throw new Error(`Lane ${laneIndex + 1} has no non-overlapping local background region`);
      const backgroundStart = candidateStarts.reduce((best, index) => {
        const signal = polarity === "dark" ? 255 - profile.windows[index] : profile.windows[index];
        const bestValue = polarity === "dark" ? 255 - profile.windows[best] : profile.windows[best];
        return signal < bestValue ? index : best;
      }, candidateStarts[0]);
      const background = { x: profile.x, y: crop.y + backgroundStart, w: boxWidth, h: boxHeight };
      const measurement = quantifyRoiPair({ pixels, width, height, band, background, polarity });
      const contrastZ = polarity === "dark"
        ? (measurement.backgroundMean - measurement.bandMean) / Math.max(measurement.backgroundSd, 1)
        : (measurement.bandMean - measurement.backgroundMean) / Math.max(measurement.backgroundSd, 1);
      const qc = [...measurement.qc];
      if (profileEdge) qc.push("ROI_PROFILE_EDGE_CANDIDATE");
      if (!(measurement.corrected > 0) || contrastZ < 1.5) qc.push("ROI_SIGNAL_LOW_CONFIDENCE");
      else if (contrastZ < 3) qc.push("ROI_SIGNAL_REVIEW");
      return { band, background, contrastZ, qc: [...new Set(qc)] };
    });
    const warnings = lanes.flatMap((lane, index) => lane.qc.length ? [{ lane: index + 1, codes: lane.qc }] : []);
    const status = lanes.some((lane) => lane.qc.includes("ROI_SIGNAL_LOW_CONFIDENCE")) ? "low"
      : lanes.some((lane) => lane.qc.length) ? "review" : "clear";
    return { lanes, status, warnings, method: "row-contrast-v1" };
  }

  function assessExposureSeries(input) {
    if (!Array.isArray(input) || input.length < 2 || input.length > 8) throw new Error("Exposure series must contain 2–8 images");
    const series = input.map((exposure, index) => {
      const time = Number(exposure.time);
      if (!Number.isFinite(time) || time <= 0) throw new Error(`Exposure ${index + 1} time must be positive`);
      if (!Array.isArray(exposure.lanes) || !exposure.lanes.length) throw new Error(`Exposure ${index + 1} has no lane measurements`);
      return { ...exposure, time };
    }).sort((left, right) => left.time - right.time);
    if (new Set(series.map((exposure) => exposure.time)).size !== series.length) throw new Error("Exposure times must be unique");
    const laneCount = series[0].lanes.length;
    if (series.some((exposure) => exposure.lanes.length !== laneCount)) throw new Error("Exposure lane counts do not match");
    const lanes = Array.from({ length: laneCount }, (_, index) => {
      const points = series.map((exposure) => ({
        time: exposure.time,
        corrected: Number(exposure.lanes[index].corrected),
        clippedFraction: Number(exposure.lanes[index].signalClippedFraction || 0),
        signalClippedFraction: Number(exposure.lanes[index].signalClippedFraction || 0),
        backgroundClippedFraction: Number(exposure.lanes[index].backgroundClippedFraction || 0),
      }));
      const codes = [];
      if (points.some((point) => !Number.isFinite(point.corrected) || point.corrected <= 0)) codes.push("NON_POSITIVE_SIGNAL");
      if (points.some((point) => point.clippedFraction >= .01)) codes.push("SATURATION_HIGH");
      if (points.some((point) => point.backgroundClippedFraction >= .01)) codes.push("BACKGROUND_CLIPPING_HIGH");
      if (points.some((point) => point.signalClippedFraction > 0 && point.signalClippedFraction < .01)) codes.push("SIGNAL_ENDPOINT_PRESENT");
      if (points.some((point) => point.backgroundClippedFraction > 0 && point.backgroundClippedFraction < .01)) codes.push("BACKGROUND_ENDPOINT_PRESENT");
      const monotonic = points.every((point, pointIndex) => pointIndex === 0 || point.corrected > points[pointIndex - 1].corrected);
      if (!monotonic) codes.push("NON_MONOTONIC_RESPONSE");
      const xMean = mean(points.map((point) => point.time));
      const yMean = mean(points.map((point) => point.corrected));
      const denominator = points.reduce((sum, point) => sum + (point.time - xMean) ** 2, 0);
      const slope = denominator ? points.reduce((sum, point) => sum + (point.time - xMean) * (point.corrected - yMean), 0) / denominator : 0;
      const intercept = yMean - slope * xMean;
      const residual = points.reduce((sum, point) => sum + (point.corrected - (intercept + slope * point.time)) ** 2, 0);
      const total = points.reduce((sum, point) => sum + (point.corrected - yMean) ** 2, 0);
      const r2 = total ? Math.max(0, 1 - residual / total) : 0;
      const rates = points.map((point) => point.corrected / point.time);
      const rateMean = mean(rates);
      const responseCv = rateMean > 0 ? (sampleSd(rates) || 0) / rateMean : Infinity;
      if (series.length < 3) codes.push("TOO_FEW_EXPOSURES");
      else {
        if (r2 < .98) codes.push("R2_LOW");
        if (responseCv > .15) codes.push("RESPONSE_RATE_CV_HIGH");
      }
      const invalid = codes.includes("NON_POSITIVE_SIGNAL");
      const blockingCodes = codes.filter((code) => !["SIGNAL_ENDPOINT_PRESENT", "BACKGROUND_ENDPOINT_PRESENT"].includes(code));
      const status = invalid ? "invalid" : series.length < 3 ? "insufficient" : blockingCodes.length ? "review" : "consistent";
      return { lane: input[0].lanes[index].lane || index + 1, slope, intercept, r2, responseCv, monotonic, status, codes, points };
    });
    const status = lanes.some((lane) => lane.status === "invalid") ? "invalid"
      : series.length < 3 ? "insufficient"
        : lanes.every((lane) => lane.status === "consistent") ? "consistent" : "review";
    return { status, lanes, exposureCount: series.length, thresholds: { minimumPoints: 3, minimumR2: .98, maximumResponseCv: .15, saturationFraction: .01 } };
  }

  function boundedRoi(roi, width, height, label) {
    const normalized = [roi?.x, roi?.y, roi?.w, roi?.h].map(Number);
    if (normalized.some((value) => !Number.isFinite(value)) || normalized[2] < 1 || normalized[3] < 1) throw new Error(`${label} ROI is invalid`);
    const [x, y, w, h] = normalized.map(Math.round);
    if (x < 0 || y < 0 || x + w > width || y + h > height) throw new Error(`${label} ROI is outside the source image`);
    return { x, y, w, h };
  }

  function roiStats(pixels, width, roi, endpoint) {
    let sum = 0;
    let sumSquares = 0;
    let clipped = 0;
    for (let y = roi.y; y < roi.y + roi.h; y += 1) {
      for (let x = roi.x; x < roi.x + roi.w; x += 1) {
        const value = pixels[y * width + x];
        sum += value;
        sumSquares += value * value;
        if (value === endpoint) clipped += 1;
      }
    }
    const count = roi.w * roi.h;
    const mean = sum / count;
    const variance = count > 1 ? Math.max(0, (sumSquares - sum * sum / count) / (count - 1)) : 0;
    return { count, sum, mean, sd: Math.sqrt(variance), clipped, clippedFraction: clipped / count };
  }

  function quantifyRoiPair(input) {
    const pixels = bytes(input.pixels);
    const width = Number(input.width);
    const height = Number(input.height);
    if (pixels.length !== width * height) throw new Error("Grayscale byte length does not match dimensions");
    const band = boundedRoi(input.band, width, height, "Band");
    const background = boundedRoi(input.background, width, height, "Background");
    if (band.w !== background.w || band.h !== background.h) throw new Error("Band and background ROI must have identical dimensions");
    const overlaps = band.x < background.x + background.w && band.x + band.w > background.x && band.y < background.y + background.h && band.y + band.h > background.y;
    if (overlaps) throw new Error("Band and background ROI must not overlap");
    const polarity = input.polarity === "bright" ? "bright" : "dark";
    const signalEndpoint = polarity === "bright" ? 255 : 0;
    const backgroundEndpoint = polarity === "bright" ? 0 : 255;
    const bandStats = roiStats(pixels, width, band, signalEndpoint);
    const backgroundStats = roiStats(pixels, width, background, backgroundEndpoint);
    const corrected = polarity === "bright"
      ? bandStats.sum - backgroundStats.mean * bandStats.count
      : backgroundStats.mean * bandStats.count - bandStats.sum;
    const qc = [];
    if (corrected <= 0) qc.push("POLARITY_OR_SIGNAL_INVALID");
    if (bandStats.clipped) qc.push(bandStats.clippedFraction >= 0.01 ? "SIGNAL_SATURATION_HIGH" : "SIGNAL_ENDPOINT_PRESENT");
    if (backgroundStats.clipped) qc.push(backgroundStats.clippedFraction >= 0.01 ? "BACKGROUND_CLIPPING_HIGH" : "BACKGROUND_ENDPOINT_PRESENT");
    return {
      polarity,
      band,
      background,
      bandSum: bandStats.sum,
      bandMean: bandStats.mean,
      backgroundSum: backgroundStats.sum,
      backgroundMean: backgroundStats.mean,
      backgroundSd: backgroundStats.sd,
      corrected,
      signalClippedCount: bandStats.clipped,
      signalClippedFraction: bandStats.clippedFraction,
      backgroundClippedCount: backgroundStats.clipped,
      backgroundClippedFraction: backgroundStats.clippedFraction,
      qc,
    };
  }

  function normalizeMeasurements(targets, loading, samples, controlGroup) {
    if (!loading?.lanes || !Array.isArray(targets) || !Array.isArray(samples)) throw new Error("Quantification mapping is incomplete");
    const rows = [];
    targets.forEach((target) => {
      target.lanes.forEach((measurement, index) => {
        const sample = samples[index] || {};
        const loadingMeasurement = loading.lanes[index];
        const ratio = measurement?.corrected > 0 && loadingMeasurement?.corrected > 0
          ? measurement.corrected / loadingMeasurement.corrected
          : null;
        rows.push({
          targetKey: target.key,
          target: target.name,
          lane: index + 1,
          sampleId: sample.sampleId || `Lane ${index + 1}`,
          group: sample.group || "",
          biologicalReplicate: sample.biologicalReplicate || index + 1,
          technicalReplicate: sample.technicalReplicate || "",
          excluded: Boolean(sample.excluded),
          exclusionNote: sample.exclusionNote || "",
          targetMeasurement: measurement,
          loadingMeasurement,
          ratio,
          qc: [...(measurement?.qc || []), ...(loadingMeasurement?.qc || []), ...(ratio === null ? ["NORMALIZATION_INVALID"] : [])],
        });
      });
    });

    const technicalMeans = new Map();
    rows.filter((row) => !row.excluded && row.ratio !== null).forEach((row) => {
      const key = [row.targetKey, row.group, row.biologicalReplicate].join("\u001f");
      const values = technicalMeans.get(key) || [];
      values.push(row.ratio);
      technicalMeans.set(key, values);
    });
    const biologicalValues = new Map([...technicalMeans].map(([key, values]) => [key, values.reduce((sum, value) => sum + value, 0) / values.length]));
    const baselines = new Map();
    targets.forEach((target) => {
      const values = [...biologicalValues].filter(([key]) => key.startsWith(`${target.key}\u001f${controlGroup}\u001f`)).map(([, value]) => value);
      baselines.set(target.key, values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    });
    rows.forEach((row) => {
      const key = [row.targetKey, row.group, row.biologicalReplicate].join("\u001f");
      row.biologicalRatio = biologicalValues.get(key) ?? null;
      row.controlMean = baselines.get(row.targetKey);
      row.foldChange = row.biologicalRatio !== null && row.controlMean > 0 ? row.biologicalRatio / row.controlMean : null;
      if (row.controlMean === null) row.qc.push("CONTROL_BASELINE_MISSING");
    });
    return rows;
  }

  function prismColumnTables(normalizedRows) {
    const targets = new Map();
    normalizedRows.filter((row) => !row.excluded && row.foldChange !== null).forEach((row) => {
      const target = targets.get(row.targetKey) || { name: row.target, groups: new Map() };
      if (!target.groups.has(row.group)) target.groups.set(row.group, new Map());
      target.groups.get(row.group).set(String(row.biologicalReplicate), row.foldChange);
      targets.set(row.targetKey, target);
    });
    return [...targets].map(([key, target]) => {
      const groupNames = [...target.groups.keys()];
      const replicates = [...new Set(groupNames.flatMap((group) => [...target.groups.get(group).keys()]))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      return {
        key,
        name: target.name,
        rows: [groupNames, ...replicates.map((replicate) => groupNames.map((group) => target.groups.get(group).get(replicate) ?? ""))],
      };
    });
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function sampleSd(values) {
    if (values.length < 2) return null;
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
  }

  function summarizeNormalized(normalizedRows) {
    const groups = new Map();
    normalizedRows.filter((row) => !row.excluded && row.foldChange !== null).forEach((row) => {
      const key = [row.targetKey, row.group].join("\u001f");
      const item = groups.get(key) || { targetKey: row.targetKey, target: row.target, group: row.group, values: new Map() };
      item.values.set(String(row.biologicalReplicate), row.foldChange);
      groups.set(key, item);
    });
    return [...groups.values()].map((item) => {
      const values = [...item.values.values()];
      return { targetKey: item.targetKey, target: item.target, group: item.group, n: values.length, mean: mean(values), sd: sampleSd(values) };
    });
  }

  function runIntegrityChecks(input) {
    const errors = [];
    const warnings = [];
    const passes = [];
    const rows = input.rows || [];
    if (!rows.length) errors.push({ code: "NO_ROWS", message: "尚未添加任何条带行。" });
    else passes.push("已添加条带行");
    rows.forEach((row, index) => {
      const label = row.name || `第 ${index + 1} 行`;
      if (!row.hasSource) errors.push({ code: "SOURCE_MISSING", message: `${label} 缺少原始图片。` });
      if (!row.sha256) warnings.push({ code: "HASH_MISSING", message: `${label} 尚无 SHA-256 校验值。` });
      if (!row.mw) warnings.push({ code: "MW_MISSING", message: `${label} 未填写分子量。` });
      if (row.brightness !== 100 || row.contrast !== 100 || row.invert) warnings.push({ code: "IMAGE_ADJUSTED", message: `${label} 使用了亮度、对比度或反相调整；请确认调整应用于整张图。` });
      if (row.nonAdjacent && !(row.splices || []).length) errors.push({ code: "SPLICE_UNMARKED", message: `${label} 标记为非相邻泳道，但没有填写拼接边界。` });
      if ((row.splices || []).some((boundary) => !Number.isInteger(boundary) || boundary < 1 || boundary >= input.laneCount)) errors.push({ code: "SPLICE_INVALID", message: `${label} 的拼接边界超出泳道范围。` });
      if (row.signalClippedFraction > 0) warnings.push({ code: row.signalClippedFraction >= 0.01 ? "SATURATION_HIGH" : "SATURATION_PRESENT", message: `${label} 的已确认条带 ROI 中有 ${(row.signalClippedFraction * 100).toFixed(2)}% 端点像素。` });
      if (row.backgroundClippedFraction > 0) warnings.push({ code: row.backgroundClippedFraction >= 0.01 ? "BACKGROUND_CLIPPING_HIGH" : "BACKGROUND_CLIPPING_PRESENT", message: `${label} 的已确认背景 ROI 中有 ${(row.backgroundClippedFraction * 100).toFixed(2)}% 端点像素。` });
    });
    const hashes = new Map();
    rows.filter((row) => row.sha256).forEach((row) => {
      const items = hashes.get(row.sha256) || [];
      items.push(row.name);
      hashes.set(row.sha256, items);
    });
    [...hashes.values()].filter((items) => items.length > 1).forEach((items) => warnings.push({ code: "SOURCE_REUSED", message: `多个条带行使用同一个原始文件：${items.join("、")}。请确认这是有意的。` }));
    const loadingRows = rows.filter((row) => row.role === "loading");
    if (rows.some((row) => row.role === "target") && !loadingRows.length) warnings.push({ code: "LOADING_CONTROL_MISSING", message: "尚未指定内参条带行。" });
    rows.filter((row) => row.role === "target" && row.membraneId).forEach((row) => {
      if (!loadingRows.some((loading) => loading.membraneId === row.membraneId)) warnings.push({ code: "MEMBRANE_MISMATCH", message: `${row.name} 没有同膜编号的内参；跨膜定量不应自动归一化。` });
    });
    if (Number(input.labelSizePt) < 7) warnings.push({ code: "FONT_TOO_SMALL", message: `按当前导出尺寸，标签约 ${Number(input.labelSizePt).toFixed(1)} pt，低于 7 pt。` });
    if (Number(input.figureWidthCm) > Number(input.maxWidthCm || Infinity)) warnings.push({ code: "FIGURE_TOO_WIDE", message: `当前宽度 ${Number(input.figureWidthCm).toFixed(2)} cm 超过所选预设 ${Number(input.maxWidthCm).toFixed(2)} cm。` });
    if (!errors.length) passes.push("未发现阻止导出的完整性错误");
    if (!warnings.length) passes.push("未发现常规投稿警告");
    return { errors, warnings, passes };
  }

  return {
    ENGINE_VERSION,
    bytes,
    concat,
    crc32,
    zipStore,
    encodeTiffRgba,
    pdfFromJpegs,
    xlsxWorkbook,
    parseSampleMapTable,
    suggestLaneRois,
    assessExposureSeries,
    quantifyRoiPair,
    normalizeMeasurements,
    prismColumnTables,
    summarizeNormalized,
    runIntegrityChecks,
  };
});
