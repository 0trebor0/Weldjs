'use strict';

const OPEN = Buffer.from('<weld');
const CLOSE = Buffer.from('</weld>');
const GT = '>'.charCodeAt(0);

// A var name becomes a property on the export namespace, `weld.<name>`, where a
// reserved word is in fact legal JavaScript — `weld.class` parses. These are
// still rejected, and deliberately so: the restriction predates the namespace,
// relaxing it would widen what pages may declare, and `weld.new` reads as a
// mistake at the call site. Narrowing it back later would be breaking, so it
// stays until there is a reason to change it.
const RESERVED_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield'
]);

// A byte offset is unhelpful in a 50 KB file. Bounded by the offset, which is
// bounded by the buffer length.
function positionOf(source, offset) {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);

  for (let i = 0; i < limit; i += 1) {
    if (source[i] === 0x0a) {
      line += 1;
      lineStart = i + 1;
    }
  }

  return { line, column: offset - lineStart + 1 };
}

class WeldSyntaxError extends SyntaxError {
  constructor(message, offset, source) {
    const where = source
      ? (() => {
          const at = positionOf(source, offset);
          return `line ${at.line}, column ${at.column}`;
        })()
      : `byte ${offset}`;

    super(`${message} (${where})`);
    this.name = 'WeldSyntaxError';
    this.offset = offset;

    if (source) {
      const at = positionOf(source, offset);
      this.line = at.line;
      this.column = at.column;
    }
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

// Reports why the tag end was not found, not just that it was not: an
// unterminated attribute value and a genuinely unclosed tag look identical from
// a bare -1, and they need different messages. Distinguishing them here also
// makes the quotes provably balanced for parseAttributes, which would otherwise
// need its own guard against a case it can never see.
function findTagEnd(source, start) {
  let quote = 0;
  let quoteAt = -1;

  for (let i = start; i < source.length; i += 1) {
    const byte = source[i];

    if (quote) {
      if (byte === quote && source[i - 1] !== 0x5c) quote = 0;
      continue;
    }

    if (byte === 0x22 || byte === 0x27) { // " or '
      quote = byte;
      quoteAt = i;
      continue;
    }

    if (byte === GT) return { end: i };
  }

  return quote ? { unterminatedQuoteAt: quoteAt } : { end: -1 };
}

function parseAttributes(source, start, end) {
  const text = source.subarray(start, end).toString('utf8').trim();
  if (!text) return Object.create(null);

  const attrs = Object.create(null);
  let i = 0;

  while (i < text.length) {
    // No trailing-whitespace check is needed: text is trimmed, so skipping
    // whitespace here can never run to the end.
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_$:-]/.test(text[i])) i += 1;
    if (i === nameStart) {
      throw new WeldSyntaxError('Invalid <weld> attribute name', start + i, source);
    }

    const name = text.slice(nameStart, i);
    while (i < text.length && /\s/.test(text[i])) i += 1;

    if (text[i] !== '=') {
      throw new WeldSyntaxError(`Attribute "${name}" requires a quoted value`, start + i, source);
    }

    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const quote = text[i];
    if (quote !== '"' && quote !== "'") {
      throw new WeldSyntaxError(`Attribute "${name}" requires a quoted value`, start + i, source);
    }

    i += 1;
    const valueStart = i;
    // Guaranteed to terminate: findTagEnd rejects the tag outright if a quote is
    // never closed, so the text handed here always has balanced quotes.
    while (i < text.length && text[i] !== quote) i += 1;

    if (Object.prototype.hasOwnProperty.call(attrs, name)) {
      throw new WeldSyntaxError(`Duplicate <weld> attribute "${name}"`, start + nameStart, source);
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

// Exports are emitted onto a single `window.weld` namespace, so a var block no
// longer collides with same-named page code — `weld.users` and a page's own
// `const users` coexist. What does collide is a page script declaring the
// namespace itself. A top-level `var weld` or `function weld` in a classic
// script writes to `window.weld` and destroys the exports; a `const weld`
// shadows them for the rest of that script. Both are silent server-side, so
// they are worth catching at compile time.
//
// Deliberately conservative: it looks only for declarations at the start of a
// line, so an occurrence inside a string or a nested block is not mistaken for
// one.
const SCRIPT_BLOCK = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const TOP_LEVEL_DECLARATION = /^[ \t]*(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

// Kept in step with NAMESPACE in serializer.js. Not imported, because the
// scanner is otherwise independent of how a value is emitted.
const NAMESPACE = 'weld';

// Returns the offset of the offending <script>, or -1. An offset of 0 is a
// legitimate answer, so the result is compared against -1 rather than tested
// for truthiness.
function declaresNamespace(source) {
  const text = source.toString('utf8');
  let at = -1;

  let script;
  while (at === -1 && (script = SCRIPT_BLOCK.exec(text)) !== null) {
    let declaration;
    while ((declaration = TOP_LEVEL_DECLARATION.exec(script[1])) !== null) {
      if (declaration[1] === NAMESPACE) {
        at = script.index;
        break;
      }
    }
    TOP_LEVEL_DECLARATION.lastIndex = 0;
  }

  SCRIPT_BLOCK.lastIndex = 0;
  return at;
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
  const namespaceClashAt = declaresNamespace(source);
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

    const tagEnd = findTagEnd(source, tagStart + OPEN.length);

    if (tagEnd.unterminatedQuoteAt !== undefined) {
      throw new WeldSyntaxError(
        'Unterminated attribute value in <weld> tag',
        tagEnd.unterminatedQuoteAt,
        source
      );
    }

    if (tagEnd.end === -1) {
      throw new WeldSyntaxError('Unclosed <weld> opening tag', tagStart, source);
    }

    const openEnd = tagEnd.end;

    const closeStart = source.indexOf(CLOSE, openEnd + 1);
    if (closeStart === -1) {
      throw new WeldSyntaxError('Missing </weld>', tagStart, source);
    }

    const nested = findOpeningTag(source, openEnd + 1);
    if (nested !== -1 && nested < closeStart) {
      throw new WeldSyntaxError('Nested <weld> blocks are not supported', nested, source);
    }

    const attrs = parseAttributes(source, tagStart + OPEN.length, openEnd);
    const allowed = new Set(['var', 'src']);
    for (const name of Object.keys(attrs)) {
      if (!allowed.has(name)) {
        throw new WeldSyntaxError(`Unsupported <weld> attribute "${name}"`, tagStart, source);
      }
    }

    if (attrs.src !== undefined) {
      if (attrs.var !== undefined) {
        throw new WeldSyntaxError('A <weld src> block cannot also declare var', tagStart, source);
      }

      if (attrs.src.length === 0) {
        throw new WeldSyntaxError('<weld src> requires a file path', tagStart, source);
      }

      // The body would be silently discarded by the include, so a non-empty one
      // is almost certainly a mistake.
      if (source.subarray(openEnd + 1, closeStart).toString('utf8').trim().length > 0) {
        throw new WeldSyntaxError('A <weld src> block must be empty', tagStart, source);
      }
    }

    if (attrs.var !== undefined) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(attrs.var)) {
        throw new WeldSyntaxError(`Invalid client variable name "${attrs.var}"`, tagStart, source);
      }

      if (RESERVED_NAMES.has(attrs.var)) {
        throw new WeldSyntaxError(`Reserved client variable name "${attrs.var}"`, tagStart, source);
      }

      if (declared.has(attrs.var)) {
        throw new WeldSyntaxError(`Duplicate client variable name "${attrs.var}"`, tagStart, source);
      }

      // Only worth reporting on a page that actually exports something.
      if (namespaceClashAt !== -1) {
        throw new WeldSyntaxError(
          `A <script> on this page declares "${NAMESPACE}" at the top level, which is ` +
          `the namespace exports are written to; "${NAMESPACE}.${attrs.var}" would be ` +
          'destroyed or shadowed by it',
          namespaceClashAt,
          source
        );
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
