const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { requestUsageHarness } = require('../../home-teacher-common/tests/helpers/requestUsageHarness.cjs')

async function usageClient() {
  const h = await requestUsageHarness(), exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../src/usage/monthlyAiUsage.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date, require: id => {
    assert.equal(id, '@home-teacher/common/utils/indexedDB')
    return { updateRequestUsageLog: h.update }
  } })
  return { ...exports, ...h }
}

test('allowances reset at Japan midnight, including December and leap February', async () => {
  const api = await usageClient()
  for (const [before, after] of [
    ['2026-10-31T14:59:59.999Z', '2026-10-31T15:00:00.000Z'],
    ['2026-12-31T14:59:59.999Z', '2026-12-31T15:00:00.000Z'],
    ['2028-02-29T14:59:59.999Z', '2028-02-29T15:00:00.000Z'],
  ]) {
    const first = api.aiUsagePeriod(Date.parse(before)), second = api.aiUsagePeriod(Date.parse(after))
    assert.equal(first.end, Date.parse(after))
    assert.equal(second.start, first.end)
    assert.ok(second.end > second.start)
  }
})

test('free and paid plans share the monthly count, allow 100 and 500 submissions, and start fresh next month', async () => {
  const api = await usageClient(), now = Date.parse('2026-10-22T03:00:00Z')
  const free = await Promise.all(Array.from({ length: 101 }, () => api.recordMonthlyAiRequest(false, now)))
  assert.equal(free.filter(result => result.recorded).length, 100)
  assert.equal((await api.getMonthlyAiUsage(false, now)).remaining, 0)
  assert.equal((await api.getMonthlyAiUsage(true, now)).remaining, 400)
  const premium = await Promise.all(Array.from({ length: 401 }, () => api.recordMonthlyAiRequest(true, now)))
  assert.equal(premium.filter(result => result.recorded).length, 400)
  assert.equal((await api.getMonthlyAiUsage(true, now)).used, 500)
  assert.equal((await api.getMonthlyAiUsage(false, now)).remaining, 0)
  const next = await api.getMonthlyAiUsage(false, Date.parse('2026-10-31T15:00:00Z'))
  assert.equal(next.used, 0)
  assert.equal(next.remaining, 100)
  assert.deepEqual((await api.entry('settings', 'requestUsage:tutotuto.ai')).timestamps, [])
})

test('the real toolbar disables grading and questions when their shared allowance is exhausted', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
  const exports = {}, empty = () => null
  const dependencies = {
    react: React,
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '../../i18n': { useAppTranslation: () => ({ t: key => key }) },
    '@home-teacher/common/components/study/StudyToolbarFrame': {
      StudyToolbarFrame: ({ children }) => React.createElement('div', null, children),
    },
    '@home-teacher/common/components/study/StudyToolSettings': { StudyEraserTool: empty, StudyTextTool: empty },
    '@home-teacher/common/hooks/useStudyToolPopups': { useStudyToolPopups: () => ({}) },
    'react-icons/fi': { FiCheckCircle: empty, FiMessageCircle: empty, FiLoader: empty, FiEdit2: empty },
    'react-icons/bi': { BiSelection: empty },
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../src/components/study/StudyToolbar.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports, require: id => {
    assert.ok(dependencies[id], id)
    return dependencies[id]
  } })
  for (const submissionKind of ['grade', 'ask']) {
    for (const aiDisabled of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(exports.StudyToolbar, {
        viewControls: {}, onGrade() {}, submissionKind, aiDisabled, aiDisabledReason: 'monthly allowance reached',
      }))
      const button = html.match(/<button[^>]*class="btn-submit"[^>]*>/)[0]
      assert.equal(button.includes('disabled=""'), aiDisabled)
      assert.ok(button.includes(`aria-label="toolbar.${submissionKind}"`))
      if (aiDisabled) assert.ok(button.includes('title="monthly allowance reached"'))
    }
  }
})
