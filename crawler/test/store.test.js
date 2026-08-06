'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { splitPageChanges, chunks } = require('../lib/store')
test('split logic identifies new, existing, and gone pages', () => {
  const result = splitPageChanges([{ url: 'a' }, { url: 'b' }], ['b', 'c'])
  assert.deepEqual(result.newPages.map(x => x.url), ['a']); assert.deepEqual(result.existingPages.map(x => x.url), ['b']); assert.deepEqual(result.goneUrls, ['c'])
})
test('chunks values', () => assert.deepEqual(chunks([1, 2, 3], 2), [[1, 2], [3]]))
