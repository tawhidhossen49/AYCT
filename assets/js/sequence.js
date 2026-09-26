// Frame-sequence engine for a scroll-scrubbed hero video (added later).
//
// To use a clip: run the 3d-site extract_frames.py script so that
// assets/sequences/hero/manifest.json and its frames exist. The landing page
// finds the manifest and scrubs it with the hero; until then it is skipped.

export async function loadManifest(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function createSequence({ canvas, manifest, baseUrl, onProgress }) {
  const isMobile = window.matchMedia("(max-width: 768px)").matches && manifest.mobile;
  const set = isMobile ? manifest.mobile : manifest.desktop;
  const count = manifest.frameCount;
  const url = (i) => `${baseUrl}${set.dir}/${String(i + 1).padStart(4, "0")}.${set.ext}`;

  const ctx = canvas.getContext("2d");
  const images = new Array(count);
  const state = { frame: 0 };
  let loaded = 0;

  const ready = (img) => img && img.complete && img.naturalWidth > 0;

  // If the exact frame isn't loaded yet, draw the nearest one that is.
  function nearest(i) {
    for (let d = 0; d < count; d++) {
      if (ready(images[i - d])) return images[i - d];
      if (ready(images[i + d])) return images[i + d];
    }
    return null;
  }

  function render() {
    const img = nearest(Math.round(state.frame));
    if (!img) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight); // cover
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    render();
  }

  function load(i) {
    return new Promise((res) => {
      if (images[i]) return res();
      const img = new Image();
      img.decoding = "async";
      img.onload = img.onerror = () => {
        loaded++;
        onProgress?.(loaded / count);
        res();
      };
      img.src = url(i);
      images[i] = img;
    });
  }

  // First frame, then coarse-to-fine so scrubbing works early.
  async function loadAll() {
    await load(0);
    render();
    for (const stride of [16, 8, 4, 2, 1]) {
      const batch = [];
      for (let i = 0; i < count; i += stride) batch.push(load(i));
      await Promise.all(batch);
      render();
    }
  }

  window.addEventListener("resize", resize);
  resize();
  loadAll();

  return {
    state,
    render,
    // Adds the frame tween spanning timeline time 0 -> 1.
    addTo(tl) {
      tl.to(state, { frame: count - 1, snap: "frame", ease: "none", duration: 1, onUpdate: render }, 0);
      return tl;
    },
  };
}
