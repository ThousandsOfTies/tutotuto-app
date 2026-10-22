const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { PDFDocument } = require('pdf-lib')
const { IDBFactory, IDBObjectStore } = require(require.resolve('fake-indexeddb', { paths: [path.join(__dirname, '../../home-teacher-common')] }))

const resources = Object.fromEntries(['ja', 'en'].map(language => [language,
  JSON.parse(fs.readFileSync(path.join(__dirname, `../src/i18n/locales/${language}.json`), 'utf8')).starterMaterial]))
const implementation = ts.transpileModule(fs.readFileSync(path.join(__dirname,
  '../src/services/starterMaterial.ts'), 'utf8').replaceAll('import.meta.env.BASE_URL', JSON.stringify('/TutoTuto/')), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

test('both bundled worksheets have two landscape pages for the page-turn tutorial', async () => {
  for (const language of ['ja', 'en']) {
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(__dirname,
      `../public/drills/starter-${language}-v1.pdf`)))
    assert.equal(pdf.getTitle(), resources[language].title)
    assert.equal(pdf.getPageCount(), 2)
    for (const page of pdf.getPages()) {
      assert.deepEqual(page.getSize(), { width: 960, height: 640 })
    }
  }
})

async function fixture(t) {
  const indexedDB = new IDBFactory()
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('TutoTutoDB', 16)
    request.onupgradeneeded = () => {
      for (const name of ['pdfFiles', 'settings']) request.result.createObjectStore(name, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  t.after(() => db.close())
  const calls = []
  const settings = { id: 'app-settings', notificationEnabled: true, snsTimeLimitMinutes: 45 }
  async function entries(storeName, mutate) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], mutate ? 'readwrite' : 'readonly')
      const store = tx.objectStore(storeName)
      const request = mutate ? mutate(store) : store.getAll()
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
  }
  await entries('settings', store => store.add(settings))
  const fetchAsset = async url => {
    calls.push(url)
    const file = path.join(__dirname, '../public/drills', path.basename(url))
    return new Response(fs.readFileSync(file), { headers: {
      'Content-Type': url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
    } })
  }
  function client(fetch = fetchAsset) {
    const exports = {}
    class FileReader {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(data => {
          this.result = `data:${blob.type};base64,${Buffer.from(data).toString('base64')}`
          this.onload()
        })
      }
    }
    vm.runInNewContext(implementation, {
      exports, indexedDB, fetch, FileReader, AbortController, setTimeout, clearTimeout,
      require: id => {
        assert.equal(id, '@home-teacher/common/utils/indexedDB')
        return { DB_NAME: 'TutoTutoDB', getAppSettings: async () => settings }
      },
    })
    return language => exports.ensureStarterMaterial(language, resources[language.startsWith('ja') ? 'ja' : 'en'].fileName)
  }
  return { entries, calls, client, settings, fetchAsset }
}

test('a fresh library gets the localized PDF and offline thumbnail without changing app settings', async t => {
  for (const language of ['ja', 'en']) {
    const h = await fixture(t)
    await h.client()(language)
    const [record] = await h.entries('pdfFiles')
    assert.equal(record.fileName, resources[language].fileName)
    assert.equal(await record.fileData.slice(0, 5).text(), '%PDF-')
    assert.ok(record.thumbnail.startsWith('data:image/jpeg;base64,'))
    assert.ok(h.calls.every(url => url.startsWith(`/TutoTuto/drills/starter-${language}-v1.`)))
    assert.deepEqual((await h.entries('settings')).find(item => item.id === 'app-settings'), h.settings)
  }
})

test('reloads and language changes keep the saved content, drawings and name; deleting it is permanent', async t => {
  const h = await fixture(t)
  await h.client()('ja')
  const [record] = await h.entries('pdfFiles')
  record.fileName = 'My renamed worksheet.pdf'
  record.drawings = { 1: 'saved drawing' }
  await h.entries('pdfFiles', store => store.put(record))
  h.calls.length = 0
  await h.client()('en')
  const [saved] = await h.entries('pdfFiles')
  assert.equal(saved.fileName, record.fileName)
  assert.deepEqual(saved.drawings, record.drawings)
  assert.equal(h.calls.length, 0)
  await h.entries('pdfFiles', store => store.delete(record.id))
  await h.client()('ja')
  assert.equal((await h.entries('pdfFiles')).length, 0)
  assert.equal(h.calls.length, 0)
})

test('existing users get no sample, including after they empty the library later', async t => {
  const h = await fixture(t)
  const record = { id: 'user-pdf', fileName: 'My textbook.pdf', drawings: { 3: 'original' } }
  await h.entries('pdfFiles', store => store.add(record))
  await h.client()('ja')
  assert.deepEqual(await h.entries('pdfFiles'), [record])
  await h.entries('pdfFiles', store => store.delete(record.id))
  await h.client()('en')
  assert.equal((await h.entries('pdfFiles')).length, 0)
  assert.equal(h.calls.length, 0)
})

test('StrictMode and concurrent tabs register a single sample', async t => {
  const h = await fixture(t)
  const first = h.client()
  await Promise.all([first('ja'), first('ja'), h.client()('en')])
  assert.equal((await h.entries('pdfFiles')).length, 1)
  assert.equal((await h.entries('settings')).filter(item => item.status === 'installed').length, 1)
  assert.equal(h.calls.length, 4)
})

test('a failed download or HTML fallback leaves registration retryable', async t => {
  for (const invalid of [() => new Response('unavailable', { status: 503 }),
    () => new Response('<html>app fallback</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    const h = await fixture(t)
    let failed = true
    const initialize = h.client(url => failed ? invalid() : h.fetchAsset(url))
    await assert.rejects(initialize('ja'), /Starter material download failed|Invalid bundled starter material/)
    assert.equal((await h.entries('pdfFiles')).length, 0)
    assert.deepEqual(await h.entries('settings'), [h.settings])
    failed = false
    await initialize('ja')
    assert.equal((await h.entries('pdfFiles')).length, 1)
  }
})

test('a user import during the download wins without being overwritten', async t => {
  const h = await fixture(t)
  let release
  let downloading
  const started = new Promise(resolve => { downloading = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const initialize = h.client(async url => {
    downloading()
    await gate
    return h.fetchAsset(url)
  })('ja')
  await started
  const record = { id: 'user-pdf', fileName: 'Imported while loading.pdf', drawings: {} }
  await h.entries('pdfFiles', store => store.add(record))
  release()
  await initialize
  assert.deepEqual(await h.entries('pdfFiles'), [record])
})

test('an aborted save rolls back both the PDF and completion marker and can be retried', async t => {
  const h = await fixture(t)
  const add = IDBObjectStore.prototype.add
  let abort = true
  IDBObjectStore.prototype.add = function (value, ...args) {
    const request = add.call(this, value, ...args)
    if (abort && value.id === 'tutotuto:starter-material:v1') {
      abort = false
      queueMicrotask(() => this.transaction.abort())
    }
    return request
  }
  t.after(() => { IDBObjectStore.prototype.add = add })
  const initialize = h.client()
  await assert.rejects(initialize('ja'), /Starter material registration failed/)
  assert.equal((await h.entries('pdfFiles')).length, 0)
  assert.deepEqual(await h.entries('settings'), [h.settings])
  await initialize('ja')
  assert.equal((await h.entries('pdfFiles')).length, 1)
  assert.equal((await h.entries('settings')).filter(item => item.status === 'installed').length, 1)
})
