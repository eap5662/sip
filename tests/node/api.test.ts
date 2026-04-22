import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PixelStream } from '../../src';
import { collect, inspect, ready, toReadableStream, transform } from '../../src';
import { probe } from '../../src/probe';
import { WasmJpegDecoder } from '../../src/wasm';

const ROOT = join(__dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

let largeJpeg: Uint8Array;
let colorBaselineJpeg: Uint8Array;
let colorProgressiveJpeg: Uint8Array;
let colorRestartJpeg: Uint8Array;
let colorExtraneousJpeg: Uint8Array;
let samplePng: Uint8Array;
let sampleWebp: Uint8Array;
let sampleAvif: Uint8Array;

function buildExifOrientationSegment(orientation: number): Uint8Array {
  const payload = new Uint8Array([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01,
    0x03, 0x00,
    0x01, 0x00, 0x00, 0x00,
    orientation & 0xff, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const length = payload.byteLength + 2;
  const segment = new Uint8Array(payload.byteLength + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = (length >> 8) & 0xff;
  segment[3] = length & 0xff;
  segment.set(payload, 4);
  return segment;
}

function injectOrientation(bytes: Uint8Array, orientation: number): Uint8Array {
  const segment = buildExifOrientationSegment(orientation);
  const merged = new Uint8Array(bytes.byteLength + segment.byteLength);
  merged.set(bytes.subarray(0, 2), 0);
  merged.set(segment, 2);
  merged.set(bytes.subarray(2), 2 + segment.byteLength);
  return merged;
}

function readJpegOrientation(bytes: Uint8Array): number | null {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= bytes.byteLength) {
      break;
    }
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    const segmentStart = offset + 2;
    if (
      marker === 0xe1 &&
      bytes[segmentStart] === 0x45 &&
      bytes[segmentStart + 1] === 0x78 &&
      bytes[segmentStart + 2] === 0x69 &&
      bytes[segmentStart + 3] === 0x66
    ) {
      const tiff = segmentStart + 6;
      const read16 = (index: number) => bytes[index] | (bytes[index + 1] << 8);
      const read32 = (index: number) => (
        (bytes[index] |
        (bytes[index + 1] << 8) |
        (bytes[index + 2] << 16) |
        (bytes[index + 3] << 24)) >>> 0
      );
      const ifd = tiff + read32(tiff + 4);
      const entries = read16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + (i * 12);
        if (read16(entry) === 0x0112) {
          return read16(entry + 8);
        }
      }
    }
    offset += segmentLength;
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function decodeFirstPixelRgb(jpeg: Uint8Array): [number, number, number] {
  const decoder = new WasmJpegDecoder();
  try {
    decoder.init(toArrayBuffer(jpeg));
    decoder.start();
    const row = decoder.readScanline();
    if (!row || row.data.byteLength < 3) {
      throw new Error('Decoded JPEG row missing first pixel');
    }

    return [row.data[0], row.data[1], row.data[2]];
  } finally {
    decoder.dispose();
  }
}

function makeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.byteLength !== width * height * 4) {
    throw new Error('RGBA byte length does not match dimensions');
  }

  const raw = new Uint8Array(height * (1 + (width * 4)));
  let srcOffset = 0;
  let dstOffset = 0;
  for (let y = 0; y < height; y++) {
    raw[dstOffset++] = 0;
    const rowBytes = width * 4;
    raw.set(rgba.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    srcOffset += rowBytes;
    dstOffset += rowBytes;
  }

  const ihdr = new Uint8Array(13);
  writeU32be(ihdr, 0, width);
  writeU32be(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = new Uint8Array(deflateSync(raw));
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', new Uint8Array(0)),
  ]);
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.byteLength);
  writeU32be(out, 0, data.byteLength);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32be(out, 8 + data.byteLength, crc32(concatBytes([typeBytes, data])));
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

function writeU32be(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkStream(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

async function expectPixelStreamsEqual(
  label: string,
  left: PixelStream,
  right: PixelStream
) {
  const [leftInfo, rightInfo] = await Promise.all([left.info, right.info]);
  expect(leftInfo, `${label} info should match`).toEqual(rightInfo);

  const leftIterator = left[Symbol.asyncIterator]();
  const rightIterator = right[Symbol.asyncIterator]();
  let rowCount = 0;

  while (true) {
    const [leftNext, rightNext] = await Promise.all([leftIterator.next(), rightIterator.next()]);
    if (leftNext.done !== rightNext.done) {
      throw new Error(`${label} did not finish both streams together at row ${rowCount}`);
    }

    if (leftNext.done || rightNext.done) {
      break;
    }

    if (leftNext.value.y !== rightNext.value.y) {
      throw new Error(`${label} row index mismatch: ${leftNext.value.y} !== ${rightNext.value.y}`);
    }
    if (leftNext.value.width !== rightNext.value.width) {
      throw new Error(`${label} row ${leftNext.value.y} width mismatch: ${leftNext.value.width} !== ${rightNext.value.width}`);
    }
    if (leftNext.value.data.byteLength !== rightNext.value.data.byteLength) {
      throw new Error(
        `${label} row ${leftNext.value.y} byte length mismatch: ` +
        `${leftNext.value.data.byteLength} !== ${rightNext.value.data.byteLength}`
      );
    }

    for (let i = 0; i < leftNext.value.data.byteLength; i++) {
      if (leftNext.value.data[i] !== rightNext.value.data[i]) {
        throw new Error(
          `${label} row ${leftNext.value.y} differs at byte ${i}: ` +
          `${leftNext.value.data[i]} !== ${rightNext.value.data[i]}`
        );
      }
    }

    rowCount++;
  }
}

async function expectEncodedJpegsEqual(
  label: string,
  left: ArrayBuffer,
  right: ArrayBuffer
) {
  await expectPixelStreamsEqual(
    label,
    decodeBufferedJpeg(new Uint8Array(left)),
    decodeBufferedJpeg(new Uint8Array(right))
  );
}

function decodeBufferedJpeg(bytes: Uint8Array): PixelStream {
  const infoPromise = Promise.resolve({
    width: probe(toArrayBuffer(bytes)).width,
    height: probe(toArrayBuffer(bytes)).height,
    originalFormat: 'jpeg' as const,
  });

  return {
    info: infoPromise,
    async *[Symbol.asyncIterator]() {
      const decoder = new WasmJpegDecoder();
      try {
        const buffer = toArrayBuffer(bytes);
        decoder.init(buffer);
        decoder.start();

        while (true) {
          const row = decoder.readScanline();
          if (!row) {
            break;
          }
          yield row;
        }
      } finally {
        decoder.dispose();
      }
    },
  };
}

beforeAll(async () => {
  [
    largeJpeg,
    colorBaselineJpeg,
    colorProgressiveJpeg,
    colorRestartJpeg,
    colorExtraneousJpeg,
    samplePng,
    sampleWebp,
    sampleAvif,
  ] = await Promise.all([
    readFile(join(FIXTURES, 'large.jpg')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'color-baseline.jpg')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'color-progressive.jpg')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'color-restart.jpg')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'color-extraneous.jpg')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'sample.png')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'sample.webp')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
    readFile(join(FIXTURES, 'sample.avif')).then((buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
  ]);

  const builtWasmLoaderPath = join(ROOT, 'dist', 'sip.js');
  const builtWasmBinaryPath = join(ROOT, 'dist', 'sip.wasm');

  if (existsSync(builtWasmLoaderPath)) {
    (globalThis as typeof globalThis & {
      __SIP_WASM_LOADER__?: () => Promise<unknown>;
    }).__SIP_WASM_LOADER__ = async () => {
      const { default: createSipModule } = await import(pathToFileURL(builtWasmLoaderPath).href);
      const wasmBinary = await readFile(builtWasmBinaryPath);
      return createSipModule({ wasmBinary });
    };
  }

  await ready();
});

describe('new API surface', () => {
  it('inspects each supported format', async () => {
    const jpeg = await inspect(toArrayBuffer(largeJpeg));
    const png = await inspect(toArrayBuffer(samplePng));
    const webp = await inspect(toArrayBuffer(sampleWebp));
    const avif = await inspect(toArrayBuffer(sampleAvif));

    expect(jpeg.info.format).toBe('jpeg');
    expect(png.info.format).toBe('png');
    expect(webp.info.format).toBe('webp');
    expect(avif.info.format).toBe('avif');
  });

  it('transforms a large JPEG from a chunked stream with bounded buffered input', async () => {
    const streamed = await collect(
      transform(chunkStream(largeJpeg), {
        width: 1024,
        height: 1024,
        quality: 80,
      })
    );
    const buffered = await collect(
      transform(toArrayBuffer(largeJpeg), {
        width: 1024,
        height: 1024,
        quality: 80,
      })
    );

    expect(streamed.info.originalFormat).toBe('jpeg');
    expect(streamed.info.width).toBe(1024);
    expect(streamed.info.height).toBe(809);
    expect(streamed.stats.peakBufferedInputBytes).toBeLessThanOrEqual(70 * 1024);
    expect(streamed.stats.bytesOut).toBe(streamed.data.byteLength);
    await expectEncodedJpegsEqual('large streamed transform', streamed.data, buffered.data);

    const outputProbe = probe(streamed.data);
    expect(outputProbe.format).toBe('jpeg');
    expect(outputProbe.width).toBe(1024);
    expect(outputProbe.height).toBe(809);
  });

  it('matches buffered output for representative streamed JPEG variants', async () => {
    const cases = [
      ['baseline', colorBaselineJpeg],
      ['progressive', colorProgressiveJpeg],
      ['restart', colorRestartJpeg],
      ['extraneous', colorExtraneousJpeg],
    ] as const;

    for (const [label, bytes] of cases) {
      const streamed = await collect(
        transform(chunkStream(bytes), {
          width: 1024,
          height: 1024,
          quality: 82,
        })
      );
      const buffered = await collect(
        transform(toArrayBuffer(bytes), {
          width: 1024,
          height: 1024,
          quality: 82,
        })
      );

      await expectEncodedJpegsEqual(`${label} streamed JPEG`, streamed.data, buffered.data);
      expect(streamed.stats.peakBufferedInputBytes, `${label} should keep buffered compressed input bounded`)
        .toBeLessThanOrEqual(70 * 1024);
      expect(streamed.stats.peakPipelineBytes, `${label} should keep JPEG pipeline memory low`)
        .toBeLessThan(128 * 1024);
    }
  });

  it('matches buffered output for aggressively chunked JPEG streams', async () => {
    const cases = [
      ['large', largeJpeg, 997],
      ['baseline', colorBaselineJpeg, 257],
      ['progressive', colorProgressiveJpeg, 521],
    ] as const;

    for (const [label, bytes, chunkSize] of cases) {
      const streamed = await collect(
        transform(chunkStream(bytes, chunkSize), {
          width: 1024,
          height: 1024,
          quality: 82,
        })
      );
      const buffered = await collect(
        transform(toArrayBuffer(bytes), {
          width: 1024,
          height: 1024,
          quality: 82,
        })
      );

      await expectEncodedJpegsEqual(`${label} tiny-chunk streamed JPEG`, streamed.data, buffered.data);
    }
  });

  it('preserves jpeg exif orientation in the output', async () => {
    const oriented = injectOrientation(largeJpeg, 6);
    const result = await collect(
      transform(oriented.buffer.slice(oriented.byteOffset, oriented.byteOffset + oriented.byteLength), {
        width: 1024,
        height: 1024,
        quality: 80,
        exifOrientation: 'preserve',
      })
    );

    expect(readJpegOrientation(new Uint8Array(result.data))).toBe(6);
    expect(result.stats.notes).toContain('jpeg-orientation=6');
    expect(result.stats.notes).toContain('jpeg-exif-policy=preserve');
  });

  it('applies jpeg exif orientation to pixels when autorotate is enabled', async () => {
    const oriented = injectOrientation(largeJpeg, 6);
    const baseline = await collect(
      transform(toArrayBuffer(largeJpeg), {
        width: 1024,
        height: 1024,
        quality: 80,
        exifOrientation: 'preserve',
      })
    );

    const result = await collect(
      transform(toArrayBuffer(oriented), {
        width: 1024,
        height: 1024,
        quality: 80,
        exifOrientation: 'autorotate',
      })
    );

    expect(result.info.width).toBe(baseline.info.height);
    expect(result.info.height).toBe(baseline.info.width);
    expect(readJpegOrientation(new Uint8Array(result.data))).toBeNull();
    expect(result.stats.notes).toContain('jpeg-orientation=6');
    expect(result.stats.notes).toContain('jpeg-exif-policy=autorotate');
    expect(result.stats.notes.some((note) => note.startsWith('jpeg-orientation-buffered='))).toBe(true);
  });

  it('applies PNG alpha policy (discard vs flatten-white) deterministically', async () => {
    const transparentRed = makeRgbaPng(1, 1, new Uint8Array([255, 0, 0, 0]));

    const discard = await collect(
      transform(toArrayBuffer(transparentRed), {
        width: 1,
        height: 1,
        quality: 100,
        alpha: { mode: 'discard' },
      })
    );
    const flatten = await collect(
      transform(toArrayBuffer(transparentRed), {
        width: 1,
        height: 1,
        quality: 100,
        alpha: { mode: 'flatten', background: [255, 255, 255] },
      })
    );

    const discardPixel = decodeFirstPixelRgb(new Uint8Array(discard.data));
    const flattenPixel = decodeFirstPixelRgb(new Uint8Array(flatten.data));

    expect(discard.stats.notes).toContain('png-alpha=discard');
    expect(flatten.stats.notes).toContain('png-alpha=flatten:255,255,255');

    expect(discardPixel[0]).toBeGreaterThan(discardPixel[1] + 40);
    expect(discardPixel[0]).toBeGreaterThan(discardPixel[2] + 40);
    expect(flattenPixel[0]).toBeGreaterThan(220);
    expect(flattenPixel[1]).toBeGreaterThan(220);
    expect(flattenPixel[2]).toBeGreaterThan(220);
  });

  it('transforms PNG, WebP, and AVIF samples to JPEG', async () => {
    const png = await collect(transform(toArrayBuffer(samplePng), { width: 800, height: 800, quality: 85 }));
    const webp = await collect(transform(toArrayBuffer(sampleWebp), { width: 800, height: 800, quality: 85 }));
    const avif = await collect(transform(toArrayBuffer(sampleAvif), { width: 800, height: 800, quality: 85 }));

    for (const result of [png, webp, avif]) {
      const outputProbe = probe(result.data);
      expect(outputProbe.format).toBe('jpeg');
      expect(result.data.byteLength).toBeGreaterThan(0);
      expect(result.stats.bytesIn).toBeGreaterThan(0);
      expect(result.stats.bytesOut).toBe(result.data.byteLength);
    }

    expect(png.info.originalFormat).toBe('png');
    expect(webp.info.originalFormat).toBe('webp');
    expect(avif.info.originalFormat).toBe('avif');
  });

  it('exposes a readable stream helper', async () => {
    const image = transform(toArrayBuffer(samplePng), { width: 320, height: 320, quality: 80 });
    const readable = toReadableStream(image);
    const reader = readable.getReader();
    let total = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }

    expect(total).toBeGreaterThan(0);
  });
});
