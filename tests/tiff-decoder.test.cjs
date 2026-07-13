const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { decode } = require("../tiff.js");

const files = process.argv.slice(2);
assert.ok(files.length, "pass one or more TIFF paths");

const decoded = files.map((file) => {
  const bytes = fs.readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const image = decode(buffer);
  assert.ok(image.width > 0 && image.height > 0);
  assert.equal(image.pixels.length, image.width * image.height);
  const min = image.pixels.reduce((value, pixel) => Math.min(value, pixel), 255);
  const max = image.pixels.reduce((value, pixel) => Math.max(value, pixel), 0);
  const mean = image.pixels.reduce((sum, pixel) => sum + pixel, 0) / image.pixels.length;
  assert.ok(min >= 0 && max <= 255 && min <= max);
  return { file: path.basename(file), width: image.width, height: image.height, min, max, mean: Number(mean.toFixed(3)) };
});

console.log(JSON.stringify(decoded, null, 2));
