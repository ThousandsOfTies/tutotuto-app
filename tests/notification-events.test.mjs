import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/notification-events.js', import.meta.url), 'utf8');

function workerHarness(windows = []) {
  let handler;
  const opened = [];
  vm.runInNewContext(source, { URL, self: {
    registration: { scope: 'https://example.test/TutoTuto/' },
    addEventListener: (name, callback) => { assert.equal(name, 'notificationclick'); handler = callback; },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url) },
  } });
  return { opened, async click(url, tag = 'tutotuto-time-limit') {
    let pending, closed = false;
    handler({ notification: { tag, data: { url }, close: () => { closed = true; } }, waitUntil: promise => { pending = promise; } });
    await pending;
    return closed;
  } };
}

test('notification taps focus the existing timer without reloading its expired state', async () => {
  const url = 'https://example.test/TutoTuto/manage.html?returnUrl=.%2F%3FpdfId%3Dworksheet';
  let focused = 0;
  const h = workerHarness([{ url, focus: async () => { focused++; } }]);
  assert.equal(await h.click(url), true);
  assert.equal(focused, 1);
  assert.equal(h.opened.length, 0);
});

test('notification taps can reopen a timer when its window has closed', async () => {
  const url = 'https://example.test/TutoTuto/manage.html';
  const h = workerHarness();
  await h.click(url);
  assert.deepEqual(h.opened, [url]);
});

test('notification taps cannot open external destinations or other applications on the same origin', async () => {
  const h = workerHarness();
  await h.click('https://outside.example/');
  await h.click('https://example.test/DoriDori/');
  assert.equal(await h.click('https://example.test/TutoTuto/', 'another-app'), false);
  assert.equal(h.opened.length, 0);
});
