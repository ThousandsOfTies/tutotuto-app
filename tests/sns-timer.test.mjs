import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPageTranslator } from '../public/page-i18n.js';

const html = fs.readFileSync(new URL('../public/manage.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s+\{[^}]*\}\s+from\s+'[^']+';/g, '');
const notificationHelper = fs.readFileSync(new URL('../../home-teacher-common/src/utils/browserNotifications.js', import.meta.url), 'utf8')
  .replace('export async function', 'async function');
const resources = JSON.parse(fs.readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function timerHarness({ notificationEnabled = true, mobile = true, notificationError } = {}) {
  let now = 1000000;
  let nextTimerId = 0;
  const timers = new Map(), listeners = new Map(), elements = new Map();
  const sent = [], navigations = [], vibrations = [], errors = [];
  function element(id) {
    if (!elements.has(id)) {
      const handlers = new Map(), classes = new Set();
      elements.set(id, { style: {}, textContent: '', innerHTML: '', children: [], handlers,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
        appendChild(child) { this.children.push(child); },
        addEventListener: (type, callback) => handlers.set(type, callback), focus() {},
      });
    }
    return elements.get(id);
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) element(match[1]);
  element('countdownView').style.display = 'none';
  const document = { hidden: false, title: '', body: element('body'), getElementById: element,
    createElement: () => element(`created-${elements.size}`),
    addEventListener: (type, callback) => listeners.set(type, callback) };
  const snsLink = { id: 'youtube', name: 'YouTube', url: 'https://example.test/social' };
  const location = new URL('https://example.test/TutoTuto/manage.html?time=1&returnUrl=.%2F%3FpdfId%3Dworksheet');
  location.searchParams.set('snsLinks', JSON.stringify([snsLink]));
  location.replace = url => navigations.push(url);
  class Notification {
    static permission = 'granted';
    constructor(title, options) {
      if (mobile) throw new TypeError('Use ServiceWorkerRegistration.showNotification');
      if (notificationError) throw notificationError;
      sent.push({ title, options });
      this.close = () => {};
    }
  }
  const registration = { active: {}, showNotification: async (title, options) => {
    if (notificationError) throw notificationError;
    sent.push({ title, options });
  }, getNotifications: async () => [] };
  const schedule = (callback, delay, repeat = false) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, due: now + delay, delay, repeat });
    return id;
  };
  const window = { location, Notification, open: () => ({ closed: false }), focus() {},
    addEventListener: (type, callback) => listeners.set(type, callback) };
  const navigator = { serviceWorker: { getRegistration: async () => registration },
    vibrate: pattern => vibrations.push(pattern) };
  const indexedDB = { open: () => {
    const request = { result: { close() {}, transaction: () => ({ objectStore: () => ({
      get: () => { const settings = {}; queueMicrotask(() => settings.onsuccess?.());
        settings.result = { snsTimeLimitMinutes: 1, notificationEnabled }; return settings; },
      add: () => ({}),
    }) }) } };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
  const context = vm.createContext({ window, document, navigator, indexedDB, Notification, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    console: { log() {}, error: (...args) => errors.push(args) },
    loadPageTranslations: async () => createPageTranslator(resources),
    alert: () => assert.fail('Unexpected popup-blocked alert'),
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) });
  vm.runInContext(notificationHelper, context);
  const api = await vm.runInContext(`(async () => { ${script}\nreturn { startCountdownForSNS }; })()`, context);
  await flush();
  return { sent, navigations, vibrations, errors, document, element, timers,
    start: () => api.startCountdownForSNS(snsLink),
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.repeat) timer.due += timer.delay;
        else timers.delete(id);
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
    jump: ms => { now += ms; },
    async resume() { document.hidden = false; listeners.get('visibilitychange')?.(); await flush(); },
    async click(id) { await element(id).handlers.get('click')?.(); await flush(); },
  };
}

test('mobile time-up uses the active worker and a valid application-relative icon', async () => {
  const h = await timerHarness();
  h.start(); h.document.hidden = true;
  await h.advance(60000);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].title, /Time is up for YouTube/);
  assert.equal(new URL(h.sent[0].options.icon).pathname, '/TutoTuto/app.png');
  assert.equal(h.element('countdown').textContent, '00:00');
  assert.equal(h.element('instruction').style.display, 'block');
  assert.match(h.element('detectedEndTime').textContent, /page in background/);
  assert.match(h.element('notificationStatus').textContent, /accepted the notification request/);
});

test('switching back to the timer does not silently cancel it before the deadline', async () => {
  const h = await timerHarness();
  h.start(); h.document.hidden = true;
  h.jump(10000); await h.resume();
  await h.advance(600);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.element('countdown').textContent, '00:50');
  h.document.hidden = true;
  await h.advance(50000);
  assert.equal(h.sent.length, 1);
});

test('resuming after iOS suspended the page shows time-up once and waits for acknowledgement', async () => {
  const h = await timerHarness();
  h.start(); h.document.hidden = true;
  h.jump(70000); await h.resume();
  assert.equal(h.element('countdown').textContent, '00:00');
  assert.equal(h.element('title').textContent, 'Time is up');
  const timeFormat = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  assert.equal(h.element('expectedEndTime').textContent, `Expected end: ${new Date(1060000).toLocaleTimeString(undefined, timeFormat)}`);
  assert.equal(h.element('detectedEndTime').textContent, `End detected: ${new Date(1070000).toLocaleTimeString(undefined, timeFormat)} (page visible)`);
  await h.resume(); await h.resume();
  assert.equal(h.sent.length, 1);
  assert.equal(h.navigations.length, 0);
  await h.click('returnToStudy');
  assert.deepEqual(h.navigations, ['./?pdfId=worksheet']);
  assert.equal(h.timers.size, 0);
});

test('notification failures leave the visible warning and vibration working', async () => {
  const h = await timerHarness({ notificationError: new Error('Notification unavailable') });
  h.start(); await h.advance(60000);
  assert.equal(h.element('instruction').style.display, 'block');
  assert.equal(h.element('title').textContent, 'Time is up');
  assert.ok(h.vibrations.length > 0);
  assert.ok(h.errors.length > 0);
  assert.match(h.element('warningMessage').textContent, /notification/i);
  assert.match(h.element('notificationStatus').textContent, /Notification unavailable/);
});

test('disabled notifications do not send browser notifications even when permission is granted', async () => {
  const h = await timerHarness({ notificationEnabled: false, mobile: false });
  h.start(); h.document.hidden = true;
  await h.advance(66000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.element('countdown').textContent, '00:00');
  assert.match(h.element('notificationStatus').textContent, /turned off in the app settings/);
});
