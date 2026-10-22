import { DB_NAME, getAppSettings, type PDFFileRecord } from '@home-teacher/common/utils/indexedDB'

const STATE_ID = 'tutotuto:starter-material:v1'
const PDF_ID = 'tutotuto-starter-v1'
let initialization: Promise<void> | undefined

async function openDatabase(): Promise<IDBDatabase> {
  // Let the shared storage layer create or upgrade its schema first.
  await getAppSettings()
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  })
}

function registerIfEmpty(db: IDBDatabase, record?: PDFFileRecord): Promise<'done' | 'empty'> {
  return new Promise((resolve, reject) => {
    // The PDF and completion marker commit together, including across tabs.
    const transaction = db.transaction(['pdfFiles', 'settings'], 'readwrite')
    const files = transaction.objectStore('pdfFiles')
    const settings = transaction.objectStore('settings')
    let result: 'done' | 'empty' = 'done'
    const state = settings.get(STATE_ID)
    state.onsuccess = () => {
      if (state.result) return
      const count = files.count()
      count.onsuccess = () => {
        if (count.result > 0) {
          settings.add({ id: STATE_ID, status: 'skipped' })
        } else if (record) {
          files.add(record)
          settings.add({ id: STATE_ID, status: 'installed' })
        } else {
          result = 'empty'
        }
      }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Starter material registration failed'))
  })
}

function imageDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function installStarterMaterial(language: string, fileName: string): Promise<void> {
  const db = await openDatabase()
  try {
    if (await registerIfEmpty(db) === 'done') return

    const locale = language.startsWith('ja') ? 'ja' : 'en'
    const stem = `${import.meta.env.BASE_URL}drills/starter-${locale}-v1`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const [pdfResponse, imageResponse] = await Promise.all([
        fetch(`${stem}.pdf`, { signal: controller.signal }),
        fetch(`${stem}.jpg`, { signal: controller.signal }),
      ])
      if (!pdfResponse.ok || !imageResponse.ok) throw new Error('Starter material download failed')
      const [fileData, image] = await Promise.all([pdfResponse.blob(), imageResponse.blob()])
      if (await fileData.slice(0, 5).text() !== '%PDF-' || !image.type.startsWith('image/')) {
        throw new Error('Invalid bundled starter material')
      }
      const thumbnail = await imageDataURL(image)
      await registerIfEmpty(db, {
        id: PDF_ID,
        fileName,
        fileData,
        thumbnail,
        lastOpened: Date.now(),
        drawings: {},
      })
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  } finally {
    db.close()
  }
}

export function ensureStarterMaterial(language: string, fileName: string): Promise<void> {
  // React StrictMode can initialize twice. Failed attempts remain retryable.
  initialization ??= installStarterMaterial(language, fileName).catch(error => {
    initialization = undefined
    throw error
  })
  return initialization
}
