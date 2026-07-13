const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { decode } = require("../tiff.js");

const files = process.argv.slice(2);
assert.equal(files.length, 2, "pass the GAPDH and HER2 TIFF paths");
const expectedHashes = [
  "86981e4b5246cf26725be782b5f5e9a8e89d6939a1dc307290aa62b73d83779c",
  "aeb1a2d954ba75116ebeca0e74e0456df55ab84bf15ff0bd99d2aa0a7d49e37f"
];
const expectedCorners = [[90, 0], [91, 1]];

const decoded = files.map((file, fileIndex) => {
  const bytes = fs.readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const image = decode(buffer);
  assert.equal(image.width, 1376);
  assert.equal(image.height, 1104);
  assert.equal(image.pixels.length, 1376 * 1104);
  const min = image.pixels.reduce((value, pixel) => Math.min(value, pixel), 255);
  const max = image.pixels.reduce((value, pixel) => Math.max(value, pixel), 0);
  const mean = image.pixels.reduce((sum, pixel) => sum + pixel, 0) / image.pixels.length;
  assert.equal(min, 0);
  assert.equal(max, 255);
  assert.ok(mean > 56 && mean < 58);
  assert.equal(image.pixels[0], expectedCorners[fileIndex][0]);
  assert.equal(image.pixels.at(-1), expectedCorners[fileIndex][1]);
  assert.equal(crypto.createHash("sha256").update(image.pixels).digest("hex"), expectedHashes[fileIndex]);
  return { file: path.basename(file), width: image.width, height: image.height, min, max, mean: Number(mean.toFixed(3)) };
});

assert.notEqual(decoded[0].mean, decoded[1].mean);
console.log(JSON.stringify(decoded, null, 2));
