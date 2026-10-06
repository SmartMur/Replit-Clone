import sharp from 'sharp';

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);

export class ImageError extends Error {}

/**
 * Turn any accepted image into a web-ready JPEG: decoded and validated by sharp (never trusting the
 * declared type), orientation applied, all metadata (EXIF, GPS) dropped, transparency flattened to
 * white, width capped, input pixels capped against decompression bombs. SVG is rejected on purpose:
 * it can carry script.
 */
export async function toSiteJpeg(input: Buffer, maxWidth = 1600) {
  if (input.length === 0) throw new ImageError('The file is empty.');
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new ImageError('That file is not a readable image.');
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw new ImageError('Use a JPG, PNG, WebP, GIF, HEIC or AVIF image (SVG is not accepted).');
  }
  try {
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    throw new ImageError('That image could not be processed.');
  }
}

/** Small preview for the agent to look at. */
export async function toThumbnailJpeg(jpeg: Buffer, width = 640) {
  return sharp(jpeg).resize({ width, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
}
