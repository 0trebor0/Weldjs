'use strict';

// Bounds the recursive walk below so hostile or accidental deep nesting fails
// with a clear error instead of a RangeError from stack exhaustion.
const MAX_DEPTH = 64;

// Bounds the total size of a single exported value. Without it, one block
// returning an unbounded query result serializes the whole thing into the page:
// the copy, the JSON string, and the response buffer all sit in memory at once,
// and the client has to parse it.
//
// The limit is measured against the complete emitted `<script>` payload in UTF-8
// bytes, summed across every block on the page — tags, nonce attribute and
// variable name included, not just the JSON.
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
//
// Two counters, because they answer different questions. `bytes` is the real
// measurement and the one the limit is defined against, but it can only be taken
// once a value has been walked, copied and stringified — by which point the
// memory the limit exists to bound has already been allocated. `floor` is spent
// during the walk to stop that happening.
function createBudget(limit = MAX_EXPORT_BYTES) {
  if (!Number.isInteger(limit) || limit < 1024) {
    throw new TypeError('Export limit must be an integer of at least 1024 bytes');
  }

  return { floor: 0, bytes: 0, limit };
}

// Spent during the walk, before the copy is complete. Every charge below is a
// strict lower bound on the UTF-8 bytes that member can contribute to the
// output, so crossing the limit here proves the finished payload would cross it
// too. Undercounting only costs a later rejection; overcounting would reject a
// payload that actually fits, so the charges stay deliberately pessimistic in
// the one safe direction.
function spendFloor(budget, cost, path) {
  budget.floor += cost;
  if (budget.floor > budget.limit) {
    throw new TypeError(
      `Cannot export more than ${budget.limit} bytes per page; limit reached at ${path}`
    );
  }
}

// The authoritative check: actual UTF-8 bytes of what will be written, summed
// across every block on the page.
function spendBytes(budget, bytes) {
  budget.bytes += bytes;
  if (budget.bytes > budget.limit) {
    throw new TypeError(
      `Cannot export more than ${budget.limit} bytes per page; ` +
      `the emitted <script> payload reached ${budget.bytes} bytes`
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
    spendFloor(budget, 4, path);           // "null"
    return null;
  }

  const type = typeof value;

  if (type === 'string') {
    // Checked before anything is copied, so a single huge string is rejected
    // without first being measured against the rest of the structure.
    // A JS string is never fewer UTF-8 bytes than it is code units, and both
    // JSON and script escaping only ever expand, so length + 2 quotes is a floor.
    spendFloor(budget, value.length + 2, path);
    return value;
  }

  if (type === 'boolean') {
    spendFloor(budget, 4, path);           // "true" is the shorter of the two
    return value;
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot export non-finite number at ${path}`);
    }
    spendFloor(budget, 1, path);           // a single digit is the shortest form
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
    // The brackets, plus the separating commas — one fewer than the element
    // count. The elements themselves are charged by the recursion below, but a
    // sparse array recurses into `undefined`, which is rejected outright, so a
    // hostile length is still paid for before any copy is allocated.
    spendFloor(budget, 2 + Math.max(0, value.length - 1), path);
    copy = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      copy[i] = snapshot(value[i], depth + 1, `${path}[${i}]`, seen, budget);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot export non-plain object at ${path}`);
    }

    spendFloor(budget, 2, path);           // the braces
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

      // `"key":` plus the comma before every key but the first.
      spendFloor(budget, key.length + (i === 0 ? 3 : 4), path);
      copy[key] = snapshot(value[key], depth + 1, `${path}.${key}`, seen, budget);
    }
  }

  seen.delete(value);
  return copy;
}

// The floor spent during the walk is only a lower bound, and a deliberately
// loose one: `<`, `>` and `&` each become a six-character escape, and a
// multi-byte character costs more bytes than it does code units. A value that
// passed the walk can still be several times the limit once written, so the
// finished string is measured here and charged for real.
function serialize(value, budget = createBudget()) {
  const safe = snapshot(value, 0, '$', new WeakSet(), budget);
  const serialized = JSON.stringify(safe).replace(ESCAPE_PATTERN, escapeChar);
  spendBytes(budget, Buffer.byteLength(serialized, 'utf8'));
  return serialized;
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

function clientScript(name, value, nonce, budget = createBudget()) {
  const serialized = serialize(value, budget);
  let script;

  if (nonce === undefined || nonce === null) {
    script = `<script>const ${name}=${serialized};</script>`;
  } else {
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
      throw new TypeError(
        'CSP nonce must be a base64-ish string of 8 to 256 characters'
      );
    }

    script = `<script nonce="${nonce}">const ${name}=${serialized};</script>`;
  }

  // The limit covers the whole emitted element, so the tags, the variable name
  // and the nonce attribute are charged too. serialize() has already charged the
  // data, so only the wrapper is added here.
  spendBytes(
    budget,
    Buffer.byteLength(script, 'utf8') - Buffer.byteLength(serialized, 'utf8')
  );

  return Buffer.from(script);
}

module.exports = {
  serialize,
  createBudget,
  clientScript,
  assertSerializable,
  MAX_DEPTH,
  MAX_EXPORT_BYTES
};
