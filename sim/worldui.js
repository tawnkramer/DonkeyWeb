import { listWorlds, getWorldId, setWorld, onWorldChange } from './world.js';

// ---------- world picker ----------
// Rendered from the worlds/ registry rather than written into index.html,
// so adding a world module is the only step needed to make it selectable.

const list = document.getElementById('worldList');
const menu = document.getElementById('modelMenu');
const menuBtn = document.getElementById('modelMenuBtn');
const brandSub = document.getElementById('brandSub');

const buttons = new Map();
const names = new Map();

for (const w of listWorlds()) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'menuitem');
  btn.dataset.world = w.id;

  const name = document.createElement('span');
  name.className = 'worldName';
  name.textContent = w.name;
  const blurb = document.createElement('span');
  blurb.className = 'worldBlurb';
  blurb.textContent = w.blurb;
  btn.append(name, blurb);

  btn.addEventListener('click', () => {
    setWorld(w.id);
    // Same close-on-pick behaviour as the .menuModeBtn entries: switching
    // worlds is a "go look at it" action, so get the menu out of the way.
    menu.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
  });

  buttons.set(w.id, btn);
  names.set(w.id, w.name);
  list.appendChild(btn);
}

function syncActive() {
  const active = getWorldId();
  for (const [id, btn] of buttons) {
    btn.setAttribute('aria-current', String(id === active));
  }
  // The header subtitle used to name the one track that existed; now it
  // says which world you're actually on, which matters most on the small
  // screens where the menu is collapsed behind the hamburger.
  brandSub.textContent = `M2 · ${names.get(active)}`;
}
onWorldChange(syncActive);
syncActive();
