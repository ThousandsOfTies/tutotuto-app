import { updateRequestUsageLog } from '@home-teacher/common/utils/indexedDB'

export const AI_MONTHLY_LIMITS = { free: 100, premium: 500 } as const
export const AI_USAGE_CHANGED_KEY = 'tutotuto.aiUsage.changed'
const FEATURE = 'tutotuto.ai'
const JST_OFFSET = 9 * 60 * 60 * 1000

export function aiUsagePeriod(now = Date.now()) {
  const date = new Date(now + JST_OFFSET)
  const year = date.getUTCFullYear(), month = date.getUTCMonth()
  return {
    start: Date.UTC(year, month, 1) - JST_OFFSET,
    end: Date.UTC(year, month + 1, 1) - JST_OFFSET,
  }
}

export interface MonthlyAiUsage {
  used: number
  limit: number
  remaining: number
  resetsAt: number
}

async function updateUsage(premium: boolean, record: boolean, now: number) {
  const period = aiUsagePeriod(now)
  const limit = AI_MONTHLY_LIMITS[premium ? 'premium' : 'free']
  const result = await updateRequestUsageLog(FEATURE, period.start, period.end,
    record ? { timestamp: now, limit } : undefined)
  return { recorded: result.recorded, usage: { used: result.count, limit,
    remaining: Math.max(0, limit - result.count), resetsAt: period.end } }
}

/** One log per submitted grading/question request, including failed attempts. */
export function recordMonthlyAiRequest(premium: boolean, now = Date.now()) {
  return updateUsage(premium, true, now)
}

export async function getMonthlyAiUsage(premium: boolean, now = Date.now()): Promise<MonthlyAiUsage> {
  return (await updateUsage(premium, false, now)).usage
}
