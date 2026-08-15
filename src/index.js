'use strict';

const { compileFile, compileSource, load, clearLoaded } = require('./compiler');
const { scan, WeldSyntaxError } = require('./scanner');
const { serialize, assertSerializable, MAX_DEPTH, MAX_EXPORT_BYTES } = require('./serializer');
const { shared, clearShared } = require('./shared');

module.exports = {
  load,
  clearLoaded,
  compileFile,
  compileSource,
  scan,
  serialize,
  assertSerializable,
  shared,
  clearShared,
  MAX_DEPTH,
  MAX_EXPORT_BYTES,
  WeldSyntaxError
};
