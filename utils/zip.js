// Minimal ZIP support for model bundles. The app writes uncompressed ZIP
// entries (method 0), which keeps the format dependency-free; TensorFlow
// weights are already binary and usually do not benefit much from deflate.

const U16 = 2;
const U32 = 4;

export function zipEntries(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30); local.set(data, 30 + name.length);
    locals.push(local);

    const c = new Uint8Array(46 + name.length); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); c.set(name, 46); central.push(c);
    offset += local.length;
  }
  const centralBytes = concat(central); const localBytes = concat(locals);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, localBytes.length, true);
  return concat([localBytes, centralBytes, end]);
}

export function unzipEntries(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= 0 && i >= data.length - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('invalid ZIP: end record not found');
  const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true);
  let pos = 0; const result = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x04034b50) throw new Error('invalid ZIP: local entry missing');
    const method = view.getUint16(pos + 8, true), compressed = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true), extraLen = view.getUint16(pos + 28, true);
    if (method !== 0) throw new Error('this model ZIP uses unsupported compression');
    const name = new TextDecoder().decode(data.subarray(pos + 30, pos + 30 + nameLen));
    const start = pos + 30 + nameLen + extraLen;
    result.set(name, data.slice(start, start + compressed)); pos = start + compressed;
  }
  // centralSize is intentionally read above as a sanity check for malformed files.
  if (!centralSize) throw new Error('invalid ZIP: empty central directory');
  return result;
}

function concat(parts) {
  const total = parts.reduce((n, part) => n + part.length, 0); const out = new Uint8Array(total); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
function crc32(data) { let c = 0xffffffff; for (const byte of data) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
