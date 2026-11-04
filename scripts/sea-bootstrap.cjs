'use strict';

// Generic bytecode loader. Application source is not embedded in this script.
const { runBytecode } = require('bytenode');
const { getAsset } = require('node:sea');
const { createRequire, Module } = require('node:module');
const path = require('node:path');
const filename = process.execPath;
const compiledModule = new Module(filename);
compiledModule.filename = filename;
try {
  const wrapper = runBytecode(Buffer.from(getAsset('application.jsc')));
  wrapper.call(compiledModule.exports, compiledModule.exports, createRequire(filename), compiledModule, filename, path.dirname(filename));
} catch (error) {
  console.error('TerraCode could not start: ' + error.message);
  process.exitCode = 1;
}
