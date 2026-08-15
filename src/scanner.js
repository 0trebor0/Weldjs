'use strict';

const OPEN = Buffer.from('<weld');
const CLOSE = Buffer.from('</weld>');
const GT = '>'.charCodeAt(0);

// A var name becomes `const <name>=...` in the emitted script. These cannot be
// binding identifiers, so they would produce a client-side SyntaxError that
// breaks every script on the page. The strict-mode-only words are included too:
// they are legal in the classic script that is emitted today, but relying on
// that would make the output brittle.
const RESERVED_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield'
]);

class WeldSyntaxError extends SyntaxError {
  constructor(message, offset) {
    super(`${message} (byte ${offset})`);
    this.name = 'WeldSyntaxError';
    this.offset = offset;
  }
}

function isWhitespaceByte(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
}

function findOpeningTag(source, from) {
  // Bounded by the buffer length: each pass moves cursor past the candidate.
  for (let cursor = from; cursor < source.length; ) {
    const start = source.indexOf(OPEN, cursor);
    if (start === -1) return -1;

    const after = source[start + OPEN.length];
    if (after === GT || isWhitespaceByte(after)) return start;

    cursor = start + OPEN.length;
  }

  return -1;
}

function findTagEnd(source, start) {
  let quote = 0;

  for (let i = start; i < source.length; i += 1) {
    const byte = source[i];

    if (quote) {
      if (byte === quote && source[i - 1] !== 0x5c) quote = 0;
      continue;
    }

    if (byte === 0x22 || byte === 0x27) { // " or '
      quote = byte;
      continue;
    }

    if (byte === GT) return i;
  }

  return -1;
}

function parseAttributes(source, start, end) {
  const text = source.subarray(start, end).toString('utf8').trim();
  if (!text) return Object.create(null);

  const attrs = Object.create(null);
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;

    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_$:-]/.test(text[i])) i += 1;
    if (i === nameStart) {
      throw new WeldSyntaxError('Invalid <weld> attribute name', start + i);
    }

    const name = text.slice(nameStart, i);
    while (i < text.length && /\s/.test(text[i])) i += 1;

    if (text[i] !== '=') {
      throw new WeldSyntaxError(`Attribute "${name}" requires a quoted value`, start + i);
    }

    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const quote = text[i];
    if (quote !== '"' && quote !== "'") {
      throw new WeldSyntaxError(`Attribute "${name}" requires a quoted value`, start + i);
    }

    i += 1;
    const valueStart = i;
    while (i < text.length && text[i] !== quote) i += 1;

    if (i >= text.length) {
      throw new WeldSyntaxError(`Unclosed value for attribute "${name}"`, start + valueStart);
    }

    if (Object.prototype.hasOwnProperty.call(attrs, name)) {
      throw new WeldSyntaxError(`Duplicate <weld> attribute "${name}"`, start + nameStart);
    }

    attrs[name] = text.slice(valueStart, i);
    i += 1;
  }

  return attrs;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function scan(input) {
  // Checked explicitly rather than left to Buffer.from, which accepts an array
  // and silently reinterprets its elements as bytes.
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError(`Weld source must be a string or Buffer, received ${describe(input)}`);
  }

  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const parts = [];
  const declared = new Set();
  let cursor = 0;

  while (cursor < source.length) {
    const tagStart = findOpeningTag(source, cursor);

    if (tagStart === -1) {
      if (cursor < source.length) {
        parts.push({ type: 'html', start: cursor, end: source.length });
      }
      break;
    }

    if (tagStart > cursor) {
      parts.push({ type: 'html', start: cursor, end: tagStart });
    }

    const openEnd = findTagEnd(source, tagStart + OPEN.length);
    if (openEnd === -1) {
      throw new WeldSyntaxError('Unclosed <weld> opening tag', tagStart);
    }

    const closeStart = source.indexOf(CLOSE, openEnd + 1);
    if (closeStart === -1) {
      throw new WeldSyntaxError('Missing </weld>', tagStart);
    }

    const nested = findOpeningTag(source, openEnd + 1);
    if (nested !== -1 && nested < closeStart) {
      throw new WeldSyntaxError('Nested <weld> blocks are not supported', nested);
    }

    const attrs = parseAttributes(source, tagStart + OPEN.length, openEnd);
    const allowed = new Set(['var', 'src']);
    for (const name of Object.keys(attrs)) {
      if (!allowed.has(name)) {
        throw new WeldSyntaxError(`Unsupported <weld> attribute "${name}"`, tagStart);
      }
    }

    if (attrs.src !== undefined) {
      if (attrs.var !== undefined) {
        throw new WeldSyntaxError('A <weld src> block cannot also declare var', tagStart);
      }

      if (attrs.src.length === 0) {
        throw new WeldSyntaxError('<weld src> requires a file path', tagStart);
      }

      // The body would be silently discarded by the include, so a non-empty one
      // is almost certainly a mistake.
      if (source.subarray(openEnd + 1, closeStart).toString('utf8').trim().length > 0) {
        throw new WeldSyntaxError('A <weld src> block must be empty', tagStart);
      }
    }

    if (attrs.var !== undefined) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(attrs.var)) {
        throw new WeldSyntaxError(`Invalid client variable name "${attrs.var}"`, tagStart);
      }

      if (RESERVED_NAMES.has(attrs.var)) {
        throw new WeldSyntaxError(`Reserved client variable name "${attrs.var}"`, tagStart);
      }

      if (declared.has(attrs.var)) {
        throw new WeldSyntaxError(`Duplicate client variable name "${attrs.var}"`, tagStart);
      }

      declared.add(attrs.var);
    }

    parts.push({
      type: 'weld',
      mode: attrs.src !== undefined
        ? 'include'
        : (attrs.var === undefined ? 'setup' : 'request'),
      src: attrs.src,
      varName: attrs.var,
      tagStart,
      tagEnd: closeStart + CLOSE.length,
      codeStart: openEnd + 1,
      codeEnd: closeStart
    });

    cursor = closeStart + CLOSE.length;
  }

  return { source, parts };
}

module.exports = { scan, WeldSyntaxError };
