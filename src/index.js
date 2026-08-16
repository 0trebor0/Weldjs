'use strict';

const { compileFile, compileSource, load, watch, clearLoaded } = require('./compiler');
const { scan, WeldSyntaxError } = require('./scanner');
const { router } = require('./router');
const {
  serialize,
  assertSerializable,
  NAMESPACE,
  MAX_DEPTH,
  MAX_EXPORT_BYTES
} = require('./serializer');
const { shared, clearShared } = require('./shared');

module.exports = {
  load,
  watch,
  router,
  clearLoaded,
  compileFile,
  compileSource,
  scan,
  serialize,
  assertSerializable,
  shared,
  clearShared,
  NAMESPACE,
  MAX_DEPTH,
  MAX_EXPORT_BYTES,
  WeldSyntaxError
};
