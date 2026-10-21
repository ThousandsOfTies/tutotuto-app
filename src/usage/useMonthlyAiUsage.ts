import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppSettings } from '@home-teacher/common/utils/indexedDB'
import messages from '../i18n/locales/ja.json'
import { AI_USAGE_CHANGED_KEY, getMonthlyAiUsage, recordMonthlyAiResponse, type MonthlyAiUsage } from './monthlyAiUsage'

export function useMonthlyAiUsage(pdfId: string, accountPremium?: boolean) {
  const [usage, setUsage] = useState<MonthlyAiUsage | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const generation = useRef(0)
  const openedPdf = useRef<string | null>(null)
  const resolvePremium = useCallback(async () => accountPremium ?? (await getAppSettings()).isPremium === true, [accountPremium])

  const refresh = useCallback(async (prune = false) => {
    const version = ++generation.current
    try {
      const next = await getMonthlyAiUsage(await resolvePremium(), Date.now(), { prune })
      if (version === generation.current) { setUsage(next); setUnavailable(false) }
      return next
    } catch {
      if (version === generation.current) setUnavailable(true)
      return null
    }
  }, [resolvePremium])

  const canRequest = useCallback(async () => {
    const latest = await refresh()
    if (!latest) throw new Error(messages.errors.aiUsageUnavailable)
    return latest.remaining > 0
  }, [refresh])

  const record = useCallback(async () => {
    const version = ++generation.current
    try {
      const result = await recordMonthlyAiResponse(await resolvePremium())
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
    const prune = openedPdf.current !== pdfId
    openedPdf.current = pdfId
    void refresh(prune)
    const onStorage = (event: StorageEvent) => {
      if (event.key === AI_USAGE_CHANGED_KEY || event.key === null) void refresh()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      ++generation.current
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pdfId, refresh])

  return { usage, unavailable, disabled: !usage || unavailable || usage.remaining === 0, canRequest, refresh, record }
}
