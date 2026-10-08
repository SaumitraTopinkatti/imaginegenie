const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

export function isAccepted(file: File): boolean {
  if (ACCEPT.includes(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp";
}

/** Downscale/compress an image file to a data URL, max dimension 2048px. */
export function fileToDataUrl(file: File, maxDim = 2048, quality = 0.86): Promise<string> {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        URL.revokeObjectURL(objUrl);
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not available."));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        // Keep PNG for transparency when small, else JPEG for size.
        const usePng = file.type === "image/png" && width * height < 900 * 900;
        resolve(canvas.toDataURL(usePng ? "image/png" : "image/jpeg", quality));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not process image."));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      reject(new Error(`Could not read ${file.name}.`));
    };
    img.src = objUrl;
  });
}

/** Build a small thumbnail data URL from a full data URL. */
export function makeThumb(dataUrl: string, maxDim = 384): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not available."));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Thumb failed."));
      }
    };
    img.onerror = () => reject(new Error("Thumb failed."));
    img.src = dataUrl;
  });
}

export function b64ToDataUrl(b64: string, mediaType: string): string {
  if (b64.startsWith("data:")) return b64;
  return `data:${mediaType || "image/png"};base64,${b64}`;
}

export function dataUrlToB64(dataUrl: string): string {
  const i = dataUrl.indexOf("base64,");
  return i >= 0 ? dataUrl.slice(i + 7) : dataUrl;
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
