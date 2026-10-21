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

test('current-month aggregation uses Japan time, including December and leap February', async () => {
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

test('free and paid plans count completed responses and clean other months only when a PDF opens', async () => {
  const api = await usageClient(), now = Date.parse('2026-10-22T03:00:00Z')
  await Promise.all(Array.from({ length: 100 }, () => api.recordMonthlyAiResponse(false, now)))
  assert.equal((await api.getMonthlyAiUsage(false, now)).remaining, 0)
  assert.equal((await api.getMonthlyAiUsage(true, now)).remaining, 400)
  await Promise.all(Array.from({ length: 400 }, () => api.recordMonthlyAiResponse(true, now)))
  assert.equal((await api.getMonthlyAiUsage(true, now)).used, 500)
  assert.equal((await api.getMonthlyAiUsage(false, now)).remaining, 0)
  const nextMonth = Date.parse('2026-10-31T15:00:00Z')
  const next = await api.getMonthlyAiUsage(false, nextMonth)
  assert.equal(next.used, 0)
  assert.equal(next.remaining, 100)
  assert.equal((await api.entry('settings', 'requestUsage:tutotuto.ai')).timestamps.length, 500)
  await api.recordMonthlyAiResponse(false, nextMonth)
  assert.equal((await api.entry('settings', 'requestUsage:tutotuto.ai')).timestamps.length, 501)
  const opened = await api.getMonthlyAiUsage(false, nextMonth, { prune: true })
  assert.equal(opened.used, 1)
  assert.deepEqual((await api.entry('settings', 'requestUsage:tutotuto.ai')).timestamps, [nextMonth])
})

test('every response already received is counted even when two tabs finish at the allowance boundary', async () => {
  const api = await usageClient(), now = Date.parse('2026-10-22T03:00:00Z')
  await Promise.all(Array.from({ length: 99 }, () => api.recordMonthlyAiResponse(false, now)))
  assert.equal((await api.getMonthlyAiUsage(false, now)).remaining, 1)
  await Promise.all([api.recordMonthlyAiResponse(false, now), api.recordMonthlyAiResponse(false, now)])
  const usage = await api.getMonthlyAiUsage(false, now)
  assert.equal(usage.used, 101)
  assert.equal(usage.remaining, 0)
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
