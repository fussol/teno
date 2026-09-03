// App store singleton — extracted from main.js so pages can import the store
// without the pages→main.js circular dependency.

import { createStore } from './store.js';

// ─── Create store (single source of truth) ───
export const store = createStore();
