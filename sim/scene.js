import * as THREE from 'three';
import { createRenderer } from './gl.js';
export { isGLAvailable } from './gl.js';

// Not `new THREE.WebGLRenderer(...)` directly: on iOS Safari that throws deep
// inside three.js on a context the browser refused to actually back. See gl.js
// -- it validates the context first and retries with cheaper attributes, so
// `canvas` here may be a replacement element, not the one in the HTML.
const gl = createRenderer(document.getElementById('view'));
export const renderer = gl.renderer;
export const canvas = gl.canvas;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xf2b98e, 60, 240);

// Sky as a real background texture (matching the page's CSS dusk gradient)
// rather than relying on the canvas's alpha:true letting the CSS show
// through -- that trick only works for the main visible canvas. The
// offscreen POV render target has no such backdrop, so it needs an actual
// scene.background to render a matching sky instead of empty/transparent
// pixels (which the pov canvas's black CSS background then shows as black).
{
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 1; skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#8ea0d8');
  grad.addColorStop(0.55, '#c3a7c9');
  grad.addColorStop(1, '#f2b98e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1, 256);
  scene.background = new THREE.CanvasTexture(skyCanvas);
}

// far planes trimmed to roughly the fog/track extent: an oversized far
// plane starves the depth buffer of precision, which was causing the
// road ribbon (only ~2cm above the ground) to lose the depth test and
// disappear anywhere more than a few meters from the camera.
export const chaseCam = new THREE.PerspectiveCamera(58, 1, 0.1, 280);
export const povCam   = new THREE.PerspectiveCamera(80, 160/120, 0.05, 280); // wide FOV like a donkey cam

// POV render target + blit path (real pixel buffer = future training input)
export const POV_W = 160, POV_H = 120;
export const povTarget = new THREE.WebGLRenderTarget(POV_W, POV_H);
export const povPixels = new Uint8Array(POV_W * POV_H * 4);
export const povCanvas = document.getElementById('pov');
export const povCtx = povCanvas.getContext('2d');
export const povImage = povCtx.createImageData(POV_W, POV_H);

// ---------- light ----------
const hemi = new THREE.HemisphereLight(0xbcc7ff, 0xd8a06a, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe3c0, 1.0);
sun.position.set(-60, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90;   sun.shadow.camera.bottom = -90;
scene.add(sun);

// ---------- ground ----------
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(320, 48),
  new THREE.MeshLambertMaterial({color:0x8fae7e})
);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);
