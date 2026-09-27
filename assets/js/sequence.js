// Frame-sequence engine: draws a video, extracted as numbered WebP frames,
// onto a canvas, with the frame chosen by scroll.
//
// Frames come from the 3d-site extract_frames.py script:
//   assets/sequences/hero/manifest.json, desktop/0001.webp ..., mobile/0001.webp ...

export async function loadManifest(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const FIRST_PASS_STRIDE = 16;

export function createSequence({ canvas, manifest, baseUrl, onProgress }) {
  const isMobile = window.matchMedia("(max-width: 768px)").matches && manifest.mobile;
  const set = isMobile ? manifest.mobile : manifest.desktop;
  const count = manifest.frameCount;
  const url = (i) => `${baseUrl}${set.dir}/${String(i + 1).padStart(4, "0")}.${set.ext}`;

  const ctx = canvas.getContext("2d", { alpha: false });
  const images = new Array(count);
  const state = { frame: 0 };
  let drawn = null; // the image currently on the canvas

  const ready = (img) => img && img.complete && img.naturalWidth > 0;

  // If the exact frame isn't loaded yet, draw the nearest one that is,
  // preferring earlier frames so the film never jumps ahead.
  function nearest(i) {
    for (let d = 0; d < count; d++) {
      if (ready(images[i - d])) return images[i - d];
      if (ready(images[i + d])) return images[i + d];
    }
    return null;
  }

  function render(force = false) {
    const img = nearest(Math.min(count - 1, Math.max(0, Math.round(state.frame))));
    if (!img || (img === drawn && !force)) return;
    drawn = img;
    const cw = canvas.width;
    const ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight); // object-fit: cover
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.fillStyle = "#030303";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.imageSmoothingQuality = "high";
    render(true);
  }

  function load(i) {
    return new Promise((res) => {
      if (images[i]) return res();
      const img = new Image();
      img.decoding = "async";
      img.onload = img.onerror = () => {
        if (img.decode) img.decode().catch(() => {}).finally(res);
        else res();
      };
      img.src = url(i);
      images[i] = img;
    });
  }

  // First frame, then every 16th, then fill in coarse-to-fine, so the film
  // can be scrubbed early while the rest arrives in the background.
  let firstPassDone;
  const firstPass = new Promise((r) => (firstPassDone = r));
  (async () => {
    await load(0);
    render(true);
    const firstBatch = [];
    for (let i = 0; i < count; i += FIRST_PASS_STRIDE) firstBatch.push(load(i));
    let n = 0;
    firstBatch.forEach((p) => p.then(() => onProgress?.(++n / firstBatch.length)));
    await Promise.all(firstBatch);
    render(true);
    firstPassDone();
    for (const stride of [8, 4, 2, 1]) {
      const batch = [];
      for (let i = 0; i < count; i += stride) batch.push(load(i));
      await Promise.all(batch);
      render(true);
    }
  })();

  window.addEventListener("resize", resize);
  resize();

  return {
    state,
    count,
    render,
    firstPass,
    // Adds the frame tween spanning timeline time 0 -> 1.
    addTo(tl) {
      tl.fromTo(state, { frame: 0 }, { frame: count - 1, ease: "none", duration: 1, onUpdate: () => render() }, 0);
      return tl;
    },
  };
}
