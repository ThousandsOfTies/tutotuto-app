import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'dist')
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8')
for (const locale of ['ja', 'en']) {
  for (const extension of ['pdf', 'jpg']) {
    const name = `drills/starter-${locale}-v1.${extension}`
    const bytes = fs.readFileSync(path.join(root, name))
    assert.ok(bytes.length > 0, `Missing starter asset: ${name}`)
    assert.ok(worker.includes(name), `Starter asset is not available offline: ${name}`)
    if (extension === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
    else assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8')
  }
}
console.log('Starter PDFs and thumbnails are included in the offline cache.')
