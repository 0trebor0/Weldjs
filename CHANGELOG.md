# Changelog

## Unreleased — 2026-08-15

### Changed — project renamed to WeldJS

- The project is now **WeldJS**; the package name is `weldjs`.
- **The block delimiter is now `<weld>` / `</weld>`.** Every page must be updated — `<node>` is no longer recognised and will be passed through as ordinary HTML rather than executed. This is silent at compile time, so check existing pages.
- `NodeHtmlSyntaxError` is renamed `WeldSyntaxError`.
- `scan()` parts now use `type: 'weld'` where they previously used `type: 'node'`.
- `test/nodehtml.test.js` is renamed `test/weld.test.js`.

### Added

- `docs/index.html` — self-contained documentation page covering the tutorial, block model, request isolation, `req`/`res` access, Express integration, API reference, and security notes. No external assets, so it can be opened directly or served as a static file.

### Security

- Exported values are now validated and copied in a single walk, so the value that passes validation is necessarily the value that is written to the page. Previously validation and serialization were two separate walks over the same data, which let an accessor property (or a proxy) return a benign value to the validator and a different value to the serializer, making every export restriction advisory rather than enforced.
- Objects containing a `__proto__` key are now rejected. Exported data is spliced into a `const name = {...}` object literal, where a `__proto__` key replaces the object's prototype on the client instead of defining a property. Escaping the key does not avoid this, because the object-literal special case matches the key's string value, which an escape sequence preserves.
- Exported data nested deeper than 64 levels is now rejected with a `TypeError`. Deeply nested data previously exhausted the call stack and failed the request with a `RangeError`.

### Changed

- `assertSerializable(value)` no longer accepts the internal `seen` and `path` arguments that were previously part of its signature.
- `MAX_DEPTH` is now exported from the package root.
- A compiled page's `parts` array now holds `{ type: 'html', buffer }` entries instead of `{ type: 'html', start, end }` byte ranges, and no longer contains `{ type: 'setup' }` placeholders. This is a breaking change only for code that inspects `page.parts` directly; `render()` and `renderToBuffer()` are unaffected and produce identical bytes.

### Fixed

- Duplicate `var` names across `<weld var="...">` blocks are now rejected at compile time. They previously emitted two `const` declarations of the same name, a client-side `SyntaxError` that disabled every script on the page while the server still returned 200.
- Reserved words such as `class` and `let` are now rejected as `var` names, for the same reason.
- Runs of static HTML separated only by a setup `<weld>` block are joined once at compile time, so streaming a page issues one write per run rather than one per original slice. A page with twelve setup blocks interleaved with markup drops from 15 writes to 3.
- `findOpeningTag` in the scanner now uses a loop explicitly bounded by the buffer length instead of `while (true)`.
