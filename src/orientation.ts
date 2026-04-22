export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function isExifOrientation(value: number | null | undefined): value is ExifOrientation {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8;
}

export function getExifOrientedDimensions(
  srcWidth: number,
  srcHeight: number,
  orientation: ExifOrientation
): { width: number; height: number } {
  if (orientation >= 5 && orientation <= 8) {
    return { width: srcHeight, height: srcWidth };
  }

  return { width: srcWidth, height: srcHeight };
}

export function mapExifDestinationToSource(
  orientation: ExifOrientation,
  dstX: number,
  dstY: number,
  srcWidth: number,
  srcHeight: number
): { sx: number; sy: number } {
  switch (orientation) {
    case 1:
      return { sx: dstX, sy: dstY };
    case 2:
      return { sx: srcWidth - 1 - dstX, sy: dstY };
    case 3:
      return { sx: srcWidth - 1 - dstX, sy: srcHeight - 1 - dstY };
    case 4:
      return { sx: dstX, sy: srcHeight - 1 - dstY };
    case 5:
      return { sx: dstY, sy: dstX };
    case 6:
      return { sx: dstY, sy: srcHeight - 1 - dstX };
    case 7:
      return { sx: srcWidth - 1 - dstY, sy: srcHeight - 1 - dstX };
    case 8:
      return { sx: srcWidth - 1 - dstY, sy: dstX };
    default:
      return { sx: dstX, sy: dstY };
  }
}

export function applyExifOrientationToRgb(
  source: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  orientation: ExifOrientation
): { data: Uint8Array; width: number; height: number } {
  const oriented = getExifOrientedDimensions(srcWidth, srcHeight, orientation);
  const output = new Uint8Array(oriented.width * oriented.height * 3);

  for (let y = 0; y < oriented.height; y++) {
    for (let x = 0; x < oriented.width; x++) {
      const { sx, sy } = mapExifDestinationToSource(orientation, x, y, srcWidth, srcHeight);
      const srcIndex = ((sy * srcWidth) + sx) * 3;
      const dstIndex = ((y * oriented.width) + x) * 3;
      output[dstIndex] = source[srcIndex];
      output[dstIndex + 1] = source[srcIndex + 1];
      output[dstIndex + 2] = source[srcIndex + 2];
    }
  }

  return {
    data: output,
    width: oriented.width,
    height: oriented.height,
  };
}
