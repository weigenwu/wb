(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WBTiff = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function decode(arrayBuffer, maxPixels = 50_000_000) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 8) throw new Error("TIFF 文件不完整");
    const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
    if (byteOrder !== "II" && byteOrder !== "MM") throw new Error("无法识别 TIFF 字节序");
    const little = byteOrder === "II";
    if (view.getUint16(2, little) !== 42) throw new Error("暂不支持 BigTIFF 或非标准 TIFF");

    const ifdOffset = view.getUint32(4, little);
    if (ifdOffset + 2 > view.byteLength) throw new Error("TIFF 图像目录损坏");
    const entryCount = view.getUint16(ifdOffset, little);
    const directoryEnd = ifdOffset + 2 + entryCount * 12;
    if (directoryEnd + 4 > view.byteLength) throw new Error("TIFF 图像目录不完整");

    const tags = new Map();
    const uniqueTags = new Set([256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 284, 317, 339]);
    for (let index = 0; index < entryCount; index += 1) {
      const offset = ifdOffset + 2 + index * 12;
      const tag = view.getUint16(offset, little);
      if (uniqueTags.has(tag) && tags.has(tag)) throw new Error(`TIFF 标签 ${tag} 重复`);
      if (!tags.has(tag)) {
        tags.set(tag, {
          type: view.getUint16(offset + 2, little),
          count: view.getUint32(offset + 4, little),
          valueOffset: view.getUint32(offset + 8, little),
          inlineOffset: offset + 8
        });
      }
    }

    const readValues = (tag, fallback) => {
      const entry = tags.get(tag);
      if (!entry) return fallback;
      const typeBytes = TYPE_BYTES[entry.type];
      if (!typeBytes || entry.count > 1_000_000) throw new Error(`TIFF 标签 ${tag} 无法读取`);
      const byteLength = typeBytes * entry.count;
      const offset = byteLength <= 4 ? entry.inlineOffset : entry.valueOffset;
      if (offset < 0 || offset + byteLength > view.byteLength) throw new Error(`TIFF 标签 ${tag} 越界`);
      const values = [];
      for (let index = 0; index < entry.count; index += 1) {
        const position = offset + index * typeBytes;
        if (entry.type === 1 || entry.type === 7) values.push(view.getUint8(position));
        else if (entry.type === 3) values.push(view.getUint16(position, little));
        else if (entry.type === 4) values.push(view.getUint32(position, little));
        else if (entry.type === 8) values.push(view.getInt16(position, little));
        else if (entry.type === 9) values.push(view.getInt32(position, little));
        else throw new Error(`TIFF 标签 ${tag} 使用了暂不支持的数据类型`);
      }
      return values;
    };

    const first = (tag, fallback) => readValues(tag, [fallback])[0];
    const width = first(256, 0);
    const height = first(257, 0);
    const bits = readValues(258, [1]);
    const compression = first(259, 1);
    const photometric = first(262, 1);
    const orientation = first(274, 1);
    const samplesPerPixel = first(277, 1);
    const rowsPerStrip = first(278, height);
    const planarConfiguration = first(284, 1);
    const predictor = first(317, 1);
    const sampleFormat = first(339, 1);
    const stripOffsets = readValues(273, []);
    const stripByteCounts = readValues(279, []);

    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("TIFF 图像尺寸无效");
    if (width * height > maxPixels) throw new Error("TIFF 图片像素过大，请控制在 5000 万像素以内");
    if (bits.length !== 1 || bits[0] !== 8 || samplesPerPixel !== 1) throw new Error("目前仅支持 8-bit 单通道灰度 TIFF");
    if (compression !== 1) throw new Error("目前仅支持无压缩 TIFF");
    if (photometric !== 0 && photometric !== 1) throw new Error("目前仅支持黑白灰度 TIFF");
    if (orientation !== 1 || planarConfiguration !== 1) throw new Error("该 TIFF 的方向或通道布局暂不支持");
    if (predictor !== 1 || sampleFormat !== 1) throw new Error("该 TIFF 的像素编码暂不支持");
    if (!rowsPerStrip || !stripOffsets.length || stripOffsets.length !== stripByteCounts.length) throw new Error("TIFF 条带索引不完整");
    if (view.getUint32(directoryEnd, little) !== 0) throw new Error("目前仅支持单页 TIFF");

    const stripCount = Math.ceil(height / rowsPerStrip);
    if (stripOffsets.length !== stripCount) throw new Error("TIFF 条带数量不匹配");
    const pixels = new Uint8ClampedArray(width * height);
    for (let strip = 0; strip < stripCount; strip += 1) {
      const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip);
      const needed = rows * width;
      const offset = stripOffsets[strip];
      if (!Number.isSafeInteger(offset) || offset < 0 || stripByteCounts[strip] !== needed || offset + needed > view.byteLength) throw new Error("TIFF 像素条带损坏");
      const source = new Uint8Array(arrayBuffer, offset, needed);
      const destination = strip * rowsPerStrip * width;
      if (photometric === 1) pixels.set(source, destination);
      else for (let index = 0; index < needed; index += 1) pixels[destination + index] = 255 - source[index];
    }

    return { width, height, pixels, bitsPerSample: 8, photometric, compression, pages: 1 };
  }

  return { decode };
});
