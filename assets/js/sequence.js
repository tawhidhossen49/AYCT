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
  const phone = window.matchMedia("(max-width: 768px)").matches && Boolean(manifest.mobile);
  const count = manifest.frameCount;

  // Which frames fit this screen. Phones keep every second frame: half the
  // download and half the decoded images in memory. An upright phone gets
  // the "portrait" set, the middle of each frame cut to 9:16 at the size it
  // is shown, so nothing is decoded only to be cropped away. The picture on
  // screen is the same; the canvas just holds fewer wasted pixels.
  function pick() {
    if (!phone) return { set: manifest.desktop, step: 1, dpr: 2, batch: 64 };
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    if (manifest.portrait && aspect <= manifest.portrait.aspect) return { set: manifest.portrait, step: 2, dpr: 1.25, batch: 6 };
    return { set: manifest.mobile, step: 2, dpr: 1.5, batch: 6 };
  }
  let cur = pick();
  const wanted = (i) => i % cur.step === 0 || i === count - 1;
  const url = (i) => `${baseUrl}${cur.set.dir}/${String(i + 1).padStart(4, "0")}.${cur.set.ext}`;

  const ctx = canvas.getContext("2d", { alpha: false });
  let images = new Array(count);
  let generation = 0; // goes up when the screen turns and another set is needed
  const state = { frame: 0 };
  let drawn = null; // the image currently on the canvas

  const ready = (img) => img && img.complete && img.naturalWidth > 0;

  // If the exact frame isn't loaded yet, draw the nearest one that is,
  // preferring earlier frames so the film never jumps ahead.
  function nearest(i) {
    for (let d = 0; d < count; d++) {
      if (wanted(i - d) && ready(images[i - d])) return images[i - d];
      if (wanted(i + d) && ready(images[i + d])) return images[i + d];
    }
    return null;
  }

  function render(force = false) {
    // While another set is still arriving, the last picture stays up.
    const img = nearest(Math.min(count - 1, Math.max(0, Math.round(state.frame)))) ?? (force ? drawn : null);
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

  function load(i) {
    const into = images;
    return new Promise((res) => {
      if (into[i] || !wanted(i)) return res();
      const img = new Image();
      img.decoding = "async";
      img.onload = img.onerror = () => {
        if (img.decode) img.decode().catch(() => {}).finally(res);
        else res();
      };
      img.src = url(i);
      into[i] = img;
    });
  }

  // First frame, then every 16th, then fill in coarse-to-fine, so the film
  // can be scrubbed early while the rest arrives in the background. On a
  // phone the rest arrives a few frames at a time, so decoding them never
  // competes with the first scroll.
  let firstPassDone;
  const firstPass = new Promise((r) => (firstPassDone = r));
  async function fill(first) {
    const gen = generation;
    await load(0);
    if (gen !== generation) return;
    render(true);
    const firstBatch = [];
    for (let i = 0; i < count; i += FIRST_PASS_STRIDE) firstBatch.push(load(i));
    if (first) {
      let n = 0;
      firstBatch.forEach((p) => p.then(() => onProgress?.(++n / firstBatch.length)));
    }
    await Promise.all(firstBatch);
    if (gen !== generation) return;
    render(true);
    if (first) firstPassDone();
    for (const stride of [8, 4, 2, 1]) {
      const todo = [];
      for (let i = 0; i < count; i += stride) if (!images[i] && wanted(i)) todo.push(i);
      if (!todo.includes(count - 1) && !images[count - 1]) todo.push(count - 1);
      for (let k = 0; k < todo.length; k += cur.batch) {
        await Promise.all(todo.slice(k, k + cur.batch).map(load));
        if (gen !== generation) return;
      }
      render(true);
    }
  }

  function resize() {
    const next = pick();
    if (next.set !== cur.set) {
      cur = cur.eco ? { ...next, eco: true, step: next.step * 2, dpr: Math.min(next.dpr, 1) } : next;
      images = new Array(count);
      generation += 1;
      fill(false);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, cur.dpr);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    // A phone's address bar sliding away fires resize without changing the
    // canvas; reallocating it then would stutter mid-scroll.
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingQuality = "high";
    render(true);
  }

  window.addEventListener("resize", resize);
  resize();
  fill(true);

  return {
    state,
    count,
    render,
    firstPass,
    // For a phone that can't keep up: every other frame of what it was
    // showing, on a smaller canvas. Half the work, the same film.
    eco() {
      if (cur.eco) return;
      cur = { ...cur, eco: true, step: cur.step * 2, dpr: Math.min(cur.dpr, 1) };
      canvas.width = 0; // so resize() reallocates at the new size
      resize();
    },
    // Adds the frame tween spanning timeline time 0 -> 1.
    addTo(tl) {
      tl.fromTo(state, { frame: 0 }, { frame: count - 1, ease: "none", duration: 1, onUpdate: () => render() }, 0);
      return tl;
    },
  };
}
