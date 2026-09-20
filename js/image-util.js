/**
 * Client-side image resize (max long edge) → JPEG base64 (no data-URL prefix).
 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

export function resizeImageFile(file, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像のデコードに失敗しました'));
      img.onload = () => {
        try {
          resolve(resizeImageElement(img, maxEdge, quality));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function resizeImageElement(img, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('画像サイズが不正です');

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tw, th);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1] || '';
  return {
    base64,
    mime: 'image/jpeg',
    width: tw,
    height: th,
    dataUrl
  };
}
