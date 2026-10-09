'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const cache = new Map();

function archiveRole(name) {
  const parts = name.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (parts.length === 2 && parts[1] === '.icon.png') return 'icon';
  if (parts.length === 3 && parts[2] === 'preview.png') return 'preview';
  return null;
}

function verifiedPng(entry, role, data) {
  return data.length >= PNG_SIGNATURE.length && data.subarray(0, 8).equals(PNG_SIGNATURE)
    ? { entry, role, data }
    : null;
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function zipImages(archivePath) {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, 22 + 0xffff);
    const tail = await readAt(handle, tailLength, stat.size - tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return [];

    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return [];
    if (centralSize > 64 * 1024 * 1024 || centralOffset + centralSize > stat.size) return [];

    const central = await readAt(handle, centralSize, centralOffset);
    const candidates = [];
    let offset = 0;
    while (offset + 46 <= central.length && candidates.length < 100) {
      if (central.readUInt32LE(offset) !== 0x02014b50) break;
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const compressedSize = central.readUInt32LE(offset + 20);
      const imageSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localOffset = central.readUInt32LE(offset + 42);
      const nameStart = offset + 46;
      const name = central.subarray(nameStart, nameStart + nameLength).toString('utf8');
      const role = archiveRole(name);
      if (
        role
        && !(flags & 1)
        && imageSize <= MAX_IMAGE_BYTES
        && compressedSize <= MAX_IMAGE_BYTES + 1024 * 1024
        && (method === 0 || method === 8)
      ) {
        candidates.push({ name, role, method, compressedSize, imageSize, localOffset });
      }
      offset = nameStart + nameLength + extraLength + commentLength;
    }

    candidates.sort((a, b) => (a.role === 'icon' ? 0 : 1) - (b.role === 'icon' ? 0 : 1));
    const images = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (totalBytes + candidate.imageSize > MAX_TOTAL_BYTES) break;
      const local = await readAt(handle, 30, candidate.localOffset);
      if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) continue;
      const dataOffset = candidate.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const compressed = await readAt(handle, candidate.compressedSize, dataOffset);
      if (compressed.length !== candidate.compressedSize) continue;
      let data;
      try {
        data = candidate.method === 0
          ? compressed
          : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_IMAGE_BYTES });
      } catch (_) {
        continue;
      }
      if (data.length !== candidate.imageSize) continue;
      const image = verifiedPng(candidate.name, candidate.role, data);
      if (image) {
        images.push(image);
        totalBytes += data.length;
      }
    }
    return images;
  } finally {
    await handle.close();
  }
}

class StreamReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) return false;
        this.buffer = next.value;
      }
      const consumed = Math.min(remaining, this.buffer.length);
      this.buffer = this.buffer.subarray(consumed);
      remaining -= consumed;
    }
    return true;
  }
}

function tarString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
}

function tarSize(buffer) {
  const text = tarString(buffer).trim();
  return text ? parseInt(text, 8) : 0;
}

async function unityPackageImages(archivePath) {
  const gunzip = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
  const reader = new StreamReader(gunzip);
  const images = [];
  let totalBytes = 0;
  try {
    for (let count = 0; count < 200000; count += 1) {
      const header = await reader.read(512);
      if (!header || header.every((byte) => byte === 0)) break;
      let name = tarString(header.subarray(0, 100));
      const prefix = tarString(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
      name = name.replace(/\\/g, '/');
      const size = tarSize(header.subarray(124, 136));
      if (!Number.isFinite(size) || size < 0) break;

      const role = archiveRole(name);
      const regularFile = header[156] === 0 || header[156] === 48;
      if (role && regularFile && size <= MAX_IMAGE_BYTES && totalBytes + size <= MAX_TOTAL_BYTES) {
        const data = await reader.read(size);
        const image = data && verifiedPng(name, role, data);
        if (image) {
          images.push(image);
          totalBytes += data.length;
        }
        if (!await reader.skip(Math.ceil(size / 512) * 512 - size)) break;
      } else if (!await reader.skip(Math.ceil(size / 512) * 512)) {
        break;
      }
      if (images.length >= 100) break;
    }
  } finally {
    gunzip.destroy();
  }
  images.sort((a, b) => (a.role === 'icon' ? 0 : 1) - (b.role === 'icon' ? 0 : 1));
  return images;
}

async function getArchiveImages(archivePath) {
  const resolved = path.resolve(archivePath);
  const stat = await fs.promises.stat(resolved);
  const key = `${resolved}:${stat.size}:${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);

  const loading = path.extname(resolved).toLowerCase() === '.zip'
    ? zipImages(resolved)
    : unityPackageImages(resolved);
  cache.set(key, loading);
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  try {
    const images = await loading;
    cache.set(key, images);
    return images;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

module.exports = { getArchiveImages };