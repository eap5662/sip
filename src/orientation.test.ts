import { describe, expect, it } from 'vitest';

import { applyExifOrientationToRgb, getExifOrientedDimensions, type ExifOrientation } from './orientation';

function makeRgbGrid(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  let value = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = ((y * width) + x) * 3;
      out[index] = value;
      out[index + 1] = 0;
      out[index + 2] = 0;
      value++;
    }
  }

  return out;
}

function readRGrid(data: Uint8Array, width: number, height: number): number[][] {
  const out: number[][] = [];

  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      row.push(data[((y * width) + x) * 3]);
    }
    out.push(row);
  }

  return out;
}

describe('EXIF destination-to-source orientation mapping', () => {
  it('produces expected dimensions for all orientations', () => {
    expect(getExifOrientedDimensions(3, 2, 1)).toEqual({ width: 3, height: 2 });
    expect(getExifOrientedDimensions(3, 2, 2)).toEqual({ width: 3, height: 2 });
    expect(getExifOrientedDimensions(3, 2, 3)).toEqual({ width: 3, height: 2 });
    expect(getExifOrientedDimensions(3, 2, 4)).toEqual({ width: 3, height: 2 });
    expect(getExifOrientedDimensions(3, 2, 5)).toEqual({ width: 2, height: 3 });
    expect(getExifOrientedDimensions(3, 2, 6)).toEqual({ width: 2, height: 3 });
    expect(getExifOrientedDimensions(3, 2, 7)).toEqual({ width: 2, height: 3 });
    expect(getExifOrientedDimensions(3, 2, 8)).toEqual({ width: 2, height: 3 });
  });

  it('produces expected pixel arrangement for orientations 1-8', () => {
    const source = makeRgbGrid(3, 2);

    const expected = {
      1: [[0, 1, 2], [3, 4, 5]],
      2: [[2, 1, 0], [5, 4, 3]],
      3: [[5, 4, 3], [2, 1, 0]],
      4: [[3, 4, 5], [0, 1, 2]],
      5: [[0, 3], [1, 4], [2, 5]],
      6: [[3, 0], [4, 1], [5, 2]],
      7: [[5, 2], [4, 1], [3, 0]],
      8: [[2, 5], [1, 4], [0, 3]],
    } as const;

    const orientations: ExifOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const orientation of orientations) {
      const rotated = applyExifOrientationToRgb(source, 3, 2, orientation);
      const grid = readRGrid(rotated.data, rotated.width, rotated.height);
      expect(grid).toEqual(expected[orientation]);
    }
  });
});
