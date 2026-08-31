// Run with: node --test lib/interstitial.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeInterstitial } = require('./optimize');

test('the SiteGround captcha stub that got stored as before_html is caught', () => {
  // Verbatim shape of the 186-byte snapshot on the ATT cuban-adjustment-act row.
  const stub = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fcuban-adjustment-act&y=ipc:1.2.3.4:1788014211"></head><body></body></html>';
  assert.equal(looksLikeInterstitial(stub), true);
});

test('sgcaptcha markers are caught at any size', () => {
  assert.equal(looksLikeInterstitial('<html>' + 'x'.repeat(10000) + '/.well-known/sgcaptcha/ </html>'), true);
});

test('a tiny meta-refresh redirect stub is not the content either', () => {
  assert.equal(looksLikeInterstitial('<html><head><meta http-equiv=refresh content="0;url=/new-home/"></head></html>'), true);
});

test('a real page passes, even one that mentions refresh in copy', () => {
  const page = '<html><head><title>T</title></head><body><h1>Workers Comp</h1>' + '<p>content</p>'.repeat(400) + '<p>How often do we refresh our data?</p></body></html>';
  assert.equal(looksLikeInterstitial(page), false);
});

test('a big page with an http-equiv refresh tag still passes on size', () => {
  const page = '<html><head><meta http-equiv="refresh" content="300"></head><body>' + '<p>real content</p>'.repeat(500) + '</body></html>';
  assert.equal(looksLikeInterstitial(page), false);
});

test('empty input is not an interstitial', () => {
  assert.equal(looksLikeInterstitial(''), false);
  assert.equal(looksLikeInterstitial(null), false);
});
