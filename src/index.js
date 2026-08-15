'use strict';

const { compileFile, compileSource } = require('./compiler');
const { scan, WeldSyntaxError } = require('./scanner');
const { serialize, assertSerializable, MAX_DEPTH } = require('./serializer');
const { shared, clearShared } = require('./shared');

module.exports = {
  compileFile,
  compileSource,
  scan,
  serialize,
  assertSerializable,
  shared,
  clearShared,
  MAX_DEPTH,
  WeldSyntaxError
};
