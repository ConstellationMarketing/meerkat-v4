'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { filterRoster } = require('../lib/roster')
test('roster applies content-production exclusions', () => {
  const rows = [{ id: 'keep', name: 'Real Firm', seo_level: ' Growth ' }, { id: 'essential', name: 'Firm', seo_level: 'Essential' }, { id: 'null', name: 'Firm', seo_level: null }, { id: 'test', name: 'Test Client', seo_level: 'Growth' }, { id: 'sample', name: 'sample firm', seo_level: 'Growth' }, { id: 'a001593a-ce1c-4da4-bd67-46a33ee7437c', name: 'Excluded', seo_level: 'Growth' }]
  assert.deepEqual(filterRoster(rows).map(x => x.id), ['keep'])
})
