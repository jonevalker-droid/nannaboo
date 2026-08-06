// Profile photo capture: read a picked/taken image file and center-crop it
// to a 200×200 JPEG data URL (~10–20 KB). That's what localStorage keeps and
// what the WS relay sends the group — the circular look is pure CSS
// (border-radius) on the square image.
export const PHOTO_SIZE = 200;

export function fileToPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { reject(new Error('empty image')); return; }
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PHOTO_SIZE;
      canvas.getContext('2d').drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, PHOTO_SIZE, PHOTO_SIZE
      );
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not read image'));
    };
    img.src = url;
  });
}
