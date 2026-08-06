'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { getPageType } = require('../lib/pagetype')
test('page type rules and fallback', () => {
  assert.equal(getPageType('https://x.com/blog/post'), 'Blog Post')
  assert.equal(getPageType('/2025/08/post'), 'Blog Post')
  assert.equal(getPageType('/personal-injury/'), 'Practice Area')
  assert.equal(getPageType('/chicago-lawyer'), 'Practice Area')
  assert.equal(getPageType('/about/'), 'Page')
  assert.equal(getPageType('/'), 'Page')
  assert.equal(getPageType('/guides/checklist'), 'Resource')
})
