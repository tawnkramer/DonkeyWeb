import duskLoop from './dusk-loop.js';
import speedway from './speedway.js';
import canyon from './canyon.js';
import city from './city.js';

// Registry order is menu order. Adding a world is: write the module,
// import it, append it here.
export const WORLDS = [duskLoop, speedway, canyon, city];

export const DEFAULT_WORLD_ID = duskLoop.id;

export function findWorld(id) {
  return WORLDS.find(w => w.id === id) || null;
}
