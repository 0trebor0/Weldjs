'use strict';

const resources = new Map();

async function shared(key, factory) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('shared() requires a non-empty string key');
  }
  if (typeof factory !== 'function') {
    throw new TypeError('shared() requires a factory function');
  }

  if (resources.has(key)) return resources.get(key);

  const pending = Promise.resolve().then(factory);
  resources.set(key, pending);

  try {
    const value = await pending;
    resources.set(key, value);
    return value;
  } catch (error) {
    resources.delete(key);
    throw error;
  }
}

function clearShared() {
  resources.clear();
}

module.exports = { shared, clearShared };
