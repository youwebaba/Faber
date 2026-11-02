export const imageBytesLimit = 8 * 1024 * 1024;

export function validateChatImages(images = []) {
  if (!Array.isArray(images) || images.length > 8) throw new Error('At most 8 image attachments are allowed');
  if (images.some(image => typeof image !== 'string') || images.reduce((size, image) => size + image.length, 0) > imageBytesLimit) throw new Error('Image attachments exceed the 8 MiB encoded limit');
  for (const image of images) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image);
    if (!match || !match[2] || match[2].length % 4) throw new Error('Images must be PNG, JPEG or WebP base64 data URLs');
    const bytes = Buffer.from(match[2], 'base64');
    const signature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : match[1] === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signature || bytes.toString('base64') !== match[2]) throw new Error('Image attachment has invalid encoding or a mismatched image signature');
  }
  return images;
}
