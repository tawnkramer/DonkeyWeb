import * as THREE from 'three';

// Getting a WebGL context is not the reliable one-liner it looks like on a
// phone. iOS Safari hands back a context OBJECT that is already dead --
// getContext() returns non-null, so three.js happily proceeds, and then the
// first real call comes back null:
//
//   TypeError: null is not an object
//     (evaluating 'gl.getShaderPrecisionFormat( 35633, 36338 ).precision')
//
// That is three.js's precision probe in WebGLCapabilities, and it is simply
// the first thing to touch the corpse. Safari does this when it cannot
// actually back the context: the per-process WebGL context budget is used up
// (repeated reloads during development leak contexts until the tab is closed),
// or the GPU is under memory pressure, or the requested attributes (MSAA at
// dpr 2 across a full-screen canvas) cost more than it will grant.
//
// So: validate the context before handing it to three.js, and if it is dead,
// retry with cheaper attributes. A canvas element remembers its context
// forever -- getContext() on the same element returns the SAME object and
// ignores the new attributes -- so each retry needs a brand new element
// swapped into the DOM in place of the old one.
const ATTEMPTS = [
  { label: 'preferred', antialias: true,  alpha: true,  logarithmicDepthBuffer: true },
  { label: 'no-msaa',   antialias: false, alpha: true,  logarithmicDepthBuffer: true },
  { label: 'minimal',   antialias: false, alpha: false, logarithmicDepthBuffer: false },
];

// A dead context returns null from every query, so any one of these would do
// as a liveness probe -- but three.js calls exactly these four and
// dereferences each result, so probing the full set is what actually proves
// the renderer will survive construction.
function usable(gl) {
  if (!gl || gl.isContextLost()) return false;
  for (const shader of [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]) {
    for (const precision of [gl.HIGH_FLOAT, gl.MEDIUM_FLOAT]) {
      if (!gl.getShaderPrecisionFormat(shader, precision)) return false;
    }
  }
  return true;
}

// A fresh element with the same id/classes/attributes, swapped in for `el`.
// Needed because a canvas cannot be asked for a second, differently
// configured context.
function replaceCanvas(el) {
  const fresh = el.cloneNode(false);
  el.replaceWith(fresh);
  return fresh;
}

export function createRenderer(canvasEl) {
  const failures = [];
  let el = canvasEl;

  for (let i = 0; i < ATTEMPTS.length; i++) {
    const { label, ...attrs } = ATTEMPTS[i];
    if (i > 0) el = replaceCanvas(el);

    // Safari puts its actual reason in this event and nowhere else -- without
    // it a refusal is indistinguishable from any other null.
    let why = '';
    el.addEventListener('webglcontextcreationerror',
      (e) => { why = e.statusMessage || ''; }, { once: true });

    const ctxAttrs = {
      alpha: attrs.alpha, depth: true, stencil: true,
      antialias: attrs.antialias, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    };
    const gl = el.getContext('webgl2', ctxAttrs) || el.getContext('webgl', ctxAttrs);

    if (usable(gl)) {
      // Passing the validated context in (rather than letting three.js call
      // getContext itself) is the whole point: three.js would get the same
      // cached object anyway, but this way nothing unvalidated ever reaches it.
      const renderer = new THREE.WebGLRenderer({ canvas: el, context: gl, ...attrs });
      watchForContextLoss(el);
      return { renderer, canvas: el, profile: label };
    }

    failures.push(`${label}: ${gl ? (why || 'context created but already lost') : (why || 'getContext returned null')}`);
  }

  // Thrown, not swallowed: without a renderer there is no sim, and the
  // in-page error overlay (index.html) is what puts this on screen -- which
  // on a phone is the only place it can be read at all.
  throw new Error(
    '3D graphics unavailable — the browser would not give this page a usable WebGL context.\n' +
    'On iPhone/iPad this usually clears after closing other tabs and reloading.\n' +
    failures.join('\n')
  );
}

// The context can also die AFTER startup -- backgrounding the tab on iOS is
// enough. three.js already stops rendering and rebuilds its GPU resources on
// restore, so nothing here touches the sim; this only explains the freeze,
// since a silently frozen 3D view reads as a crash.
function watchForContextLoss(el) {
  let banner = null;
  el.addEventListener('webglcontextlost', () => {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'glLostBanner';
    banner.textContent = '3D context lost — waiting for the browser to restore it…';
    Object.assign(banner.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '9998', background: 'rgba(24,27,36,.92)', border: '1px solid rgba(255,255,255,.14)',
      borderRadius: '8px', padding: '12px 18px', font: "13px 'IBM Plex Mono',monospace",
      color: '#f3efe8', textAlign: 'center',
    });
    document.body.appendChild(banner);
  });
  el.addEventListener('webglcontextrestored', () => {
    if (banner) { banner.remove(); banner = null; }
  });
}
