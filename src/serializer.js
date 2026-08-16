'use strict';

// Bounds the recursive walk below so hostile or accidental deep nesting fails
// with a clear error instead of a RangeError from stack exhaustion.
const MAX_DEPTH = 64;

// Bounds the total size of a single exported value. Without it, one block
// returning an unbounded query result serializes the whole thing into the page:
// the copy, the JSON string, and the response buffer all sit in memory at once,
// and the client has to parse it. The budget is spent during the walk, so an
// oversized value fails as soon as the limit is crossed rather than after the
// whole structure has been copied.
const MAX_EXPORT_BYTES = 1024 * 1024;

// & < > and the U+2028/U+2029 line separators are the characters that can break
// out of, or prematurely terminate, the generated <script> element. Each one is
// replaced by its own \uXXXX escape, so no lookup table is needed.
const ESCAPE_PATTERN = /[&<>\u2028\u2029]/g;

function escapeChar(char) {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

// One budget covers a whole render rather than a single value. The cap exists to
// bound the memory one request can hold, and a per-value cap does not do that: a
// page with five blocks could produce five times the limit.
function createBudget(limit = MAX_EXPORT_BYTES) {
  if (!Number.isInteger(limit) || limit < 1024) {
    throw new TypeError('Export limit must be an integer of at least 1024 bytes');
  }

  return { used: 0, limit };
}

// Approximates the serialized size as the walk proceeds. It need not match
// JSON.stringify exactly; it must be cheap, monotonic, and never undercount by
// enough to matter.
function spend(budget, cost, path) {
  budget.used += cost;
  if (budget.used > budget.limit) {
    throw new TypeError(
      `Cannot export more than ${budget.limit} bytes per page; limit reached at ${path}`
    );
  }
}

// Validates while copying into a structure made only of plain data. Every
// property is read exactly once, so the value that gets checked is necessarily
// the value that gets written: JSON.stringify runs against the copy and cannot
// observe a different result from an accessor or proxy on the original.
function snapshot(value, depth, path, seen, budget) {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Cannot export data nested deeper than ${MAX_DEPTH} levels at ${path}`);
  }

  if (value === null) {
    spend(budget, 4, path);
    return null;
  }

  const type = typeof value;

  if (type === 'string') {
    // Checked before anything is copied, so a single huge string is rejected
    // without first being measured against the rest of the structure.
    spend(budget, value.length + 2, path);
    return value;
  }

  if (type === 'boolean') {
    spend(budget, 5, path);
    return value;
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot export non-finite number at ${path}`);
    }
    spend(budget, 24, path);
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
    // The per-element charge is spent up front so a huge sparse or hostile array
    // is rejected before a copy of it is allocated.
    spend(budget, 2 + value.length, path);
    copy = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      copy[i] = snapshot(value[i], depth + 1, `${path}[${i}]`, seen, budget);
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

      spend(budget, key.length + 4, path);
      copy[key] = snapshot(value[key], depth + 1, `${path}.${key}`, seen, budget);
    }
  }

  seen.delete(value);
  return copy;
}

function serialize(value, budget = createBudget()) {
  const safe = snapshot(value, 0, '$', new WeakSet(), budget);
  return JSON.stringify(safe).replace(ESCAPE_PATTERN, escapeChar);
}

function assertSerializable(value, budget = createBudget()) {
  snapshot(value, 0, '$', new WeakSet(), budget);
}

// A nonce must be exactly what the Content-Security-Policy header advertises.
// Anything outside this set could close the attribute and inject markup, so a
// bad nonce is refused rather than escaped: silently altering it would produce a
// tag the policy does not match, which fails as a blank page rather than an
// error. Base64 covers what crypto.randomBytes().toString('base64') produces.
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{8,256}={0,2}$/;

function clientScript(name, value, nonce, budget) {
  const serialized = serialize(value, budget);

  if (nonce === undefined || nonce === null) {
    return Buffer.from(`<script>const ${name}=${serialized};</script>`);
  }

  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError(
      'CSP nonce must be a base64-ish string of 8 to 256 characters'
    );
  }

  return Buffer.from(`<script nonce="${nonce}">const ${name}=${serialized};</script>`);
}

module.exports = {
  serialize,
  createBudget,
  clientScript,
  assertSerializable,
  MAX_DEPTH,
  MAX_EXPORT_BYTES
};
