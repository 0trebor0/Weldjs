'use strict';

// Bounds the recursive walk below so hostile or accidental deep nesting fails
// with a clear error instead of a RangeError from stack exhaustion.
const MAX_DEPTH = 64;

// & < > and the U+2028/U+2029 line separators are the characters that can break
// out of, or prematurely terminate, the generated <script> element. Each one is
// replaced by its own \uXXXX escape, so no lookup table is needed.
const ESCAPE_PATTERN = /[&<>\u2028\u2029]/g;

function escapeChar(char) {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

// Validates while copying into a structure made only of plain data. Every
// property is read exactly once, so the value that gets checked is necessarily
// the value that gets written: JSON.stringify runs against the copy and cannot
// observe a different result from an accessor or proxy on the original.
function snapshot(value, depth, path, seen) {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Cannot export data nested deeper than ${MAX_DEPTH} levels at ${path}`);
  }

  if (value === null) return null;

  const type = typeof value;

  if (type === 'string' || type === 'boolean') return value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot export non-finite number at ${path}`);
    }
    return value;
  }

  if (type !== 'object') {
    throw new TypeError(`Cannot export ${type} at ${path}`);
  }

  if (seen.has(value)) {
    throw new TypeError(`Cannot export circular data at ${path}`);
  }
  seen.add(value);

  let copy;

  if (Array.isArray(value)) {
    copy = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      copy[i] = snapshot(value[i], depth + 1, `${path}[${i}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot export non-plain object at ${path}`);
    }

    copy = {};
    const keys = Object.keys(value);

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];

      // The output is spliced into a `const x = {...}` object literal, where a
      // "__proto__" key sets the prototype instead of defining a property.
      // Escaping the key does not help: the special case matches the string
      // value, which an escape sequence preserves.
      if (key === '__proto__') {
        throw new TypeError(`Cannot export "__proto__" key at ${path}`);
      }

      copy[key] = snapshot(value[key], depth + 1, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
  return copy;
}

function serialize(value) {
  const safe = snapshot(value, 0, '$', new WeakSet());
  return JSON.stringify(safe).replace(ESCAPE_PATTERN, escapeChar);
}

function assertSerializable(value) {
  snapshot(value, 0, '$', new WeakSet());
}

function clientScript(name, value) {
  return Buffer.from(`<script>const ${name}=${serialize(value)};</script>`);
}

module.exports = { serialize, clientScript, assertSerializable, MAX_DEPTH };
