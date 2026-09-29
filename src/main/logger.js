'use strict';

const { EventEmitter } = require('events');

const MAX_ENTRIES = 500;
const emitter = new EventEmitter();
const entries = [];

function log(level, scope, message) {
  const entry = { time: Date.now(), level, scope, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  emitter.emit('entry', entry);
  const prefix = `[${scope}]`;
  if (level === 'error') console.error(prefix, message);
  else console.log(prefix, message);
  return entry;
}

module.exports = {
  info: (scope, message) => log('info', scope, message),
  warn: (scope, message) => log('warn', scope, message),
  error: (scope, message) => log('error', scope, message),
  getEntries: () => entries.slice(),
  onEntry: (fn) => emitter.on('entry', fn),
};
