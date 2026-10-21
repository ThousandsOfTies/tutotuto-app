import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppSettings } from '@home-teacher/common/utils/indexedDB'
import messages from '../i18n/locales/ja.json'
import { AI_USAGE_CHANGED_KEY, getMonthlyAiUsage, recordMonthlyAiRequest, type MonthlyAiUsage } from './monthlyAiUsage'

export function useMonthlyAiUsage(pdfId: string, accountPremium?: boolean) {
  const [usage, setUsage] = useState<MonthlyAiUsage | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const generation = useRef(0)
  const resolvePremium = useCallback(async () => accountPremium ?? (await getAppSettings()).isPremium === true, [accountPremium])

  const refresh = useCallback(async () => {
    const version = ++generation.current
    try {
      const next = await getMonthlyAiUsage(await resolvePremium())
      if (version === generation.current) { setUsage(next); setUnavailable(false) }
    } catch {
      if (version === generation.current) setUnavailable(true)
    }
  }, [resolvePremium])

  const record = useCallback(async () => {
    const version = ++generation.current
    try {
      const result = await recordMonthlyAiRequest(await resolvePremium())
      if (version === generation.current) { setUsage(result.usage); setUnavailable(false) }
      if (result.recorded) {
        // Wake other tabs without storing request details in localStorage.
        try { localStorage.setItem(AI_USAGE_CHANGED_KEY, `${Date.now()}:${Math.random()}`) } catch {}
      }
      return result.recorded
    } catch {
      if (version === generation.current) setUnavailable(true)
      throw new Error(messages.errors.aiUsageUnavailable)
    }
  }, [resolvePremium])

  useEffect(() => {
    void refresh()
    const onStorage = (event: StorageEvent) => {
      if (event.key === AI_USAGE_CHANGED_KEY || event.key === null) void refresh()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisible)
    // Also notices the month changing while the PDF is left open.
    const timer = window.setInterval(() => { void refresh() }, 60_000)
    return () => {
      ++generation.current
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pdfId, refresh])

  return { usage, unavailable, disabled: !usage || unavailable || usage.remaining === 0, refresh, record }
}
