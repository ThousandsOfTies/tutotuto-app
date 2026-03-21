// IndexedDB管理ユーティリティ

const DB_NAME = 'TutoTutoDB';
const DB_VERSION = 9; // バージョンを上げて解答ストア追加
const STORE_NAME = 'pdfFiles';
const SNS_STORE_NAME = 'snsLinks';
const GRADING_HISTORY_STORE_NAME = 'gradingHistory';
const SETTINGS_STORE_NAME = 'settings';
const SNS_USAGE_HISTORY_STORE_NAME = 'snsUsageHistory';


export interface PDFFileRecord {
  id: string; // ユニークID (ファイル名 + タイムスタンプ)
  fileName: string;
  thumbnail?: string; // 先頭ページのサムネイル画像（Base64）
  fileData?: Blob; // Blob形式のPDFデータ（v6から）
  lastOpened: number; // タイムスタンプ
  lastPageNumberA?: number; // 最後に開いていたページ番号 (A面)
  lastPageNumberB?: number; // 最後に開いていたページ番号 (B面)
  drawings: Record<number, string>; // ページ番号 -> JSON文字列のマップ
  textAnnotations?: Record<number, string>; // ページ番号 -> JSON文字列のマップ（テキストアノテーション）
  subjectId?: string; // 教科識別子 (math, japanese, etc)
}

export interface SNSLinkRecord {
  id: string; // ユニークID
  name: string; // SNS名（例: Twitter, Instagram）
  url: string; // リンク先URL
  icon: string; // 絵文字アイコン
  createdAt: number; // 作成日時
}

export interface GradingHistoryRecord {
  id: string; // ユニークID
  pdfId: string; // PDFファイルのID
  pdfFileName: string; // 問題集の名称
  pageNumber: number; // ページ番号
  problemNumber: string; // 問題番号
  studentAnswer: string; // 生徒の解答
  isCorrect: boolean; // 正解/不正解
  correctAnswer: string; // 正しい解答
  feedback: string; // フィードバック
  explanation: string; // 解説
  timestamp: number; // 実施時刻（タイムスタンプ）
  imageData?: string; // 採点時の画像データ（オプション）
  matchingMetadata?: {
    method: 'exact' | 'ai' | 'context' | 'hybrid';
    confidence?: string;
    reasoning?: string;
    candidates?: string[];
    similarity?: number;
  }; // マッチング詳細データ（デバッグ用）
}

export interface AppSettings {
  id: 'app-settings'; // 固定ID
  snsTimeLimitMinutes: number; // SNS利用制限時間（分）
  notificationEnabled: boolean; // 通知の有効/無効
  defaultGradingModel?: string; // 採点時のデフォルトAIモデル
  isPremium?: boolean; // 有料プラン（ファミリー解除）フラグ
}

export interface SNSUsageHistoryRecord {
  id: string; // ユニークID
  snsId: string; // SNSのID
  snsName: string; // SNS名（例: YouTube, Twitter）
  snsUrl: string; // アクセスしたURL
  timeLimitMinutes: number; // 設定されていた制限時間（分）
  timestamp: number; // アクセス日時（タイムスタンプ）
}



// Cached DB instance for Singleton pattern
let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Return cached instance if active
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    console.log('🔓 IndexedDB開く:', {
      dbName: DB_NAME,
      version: DB_VERSION,
      url: window.location.href,
      timestamp: new Date().toISOString()
    });

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('❌ IndexedDB開くエラー:', {
        error: request.error,
        dbName: DB_NAME,
        version: DB_VERSION
      });
      reject(new Error('IndexedDBを開けませんでした'));
    };

    request.onsuccess = () => {
      console.log('✅ IndexedDB開く成功:', {
        dbName: request.result.name,
        version: request.result.version,
        objectStoreNames: Array.from(request.result.objectStoreNames)
      });

      const db = request.result;
      dbInstance = db;

      // Handle connection closing (e.g. version change or manual close)
      db.onclose = () => {
        console.log('🔒 IndexedDB接続が閉じられました');
        dbInstance = null;
      };

      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      // PDFファイル用オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        objectStore.createIndex('lastOpened', 'lastOpened', { unique: false });
      }

      // SNSリンク用オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(SNS_STORE_NAME)) {
        const snsStore = db.createObjectStore(SNS_STORE_NAME, { keyPath: 'id' });
        snsStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // 採点履歴用オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(GRADING_HISTORY_STORE_NAME)) {
        const historyStore = db.createObjectStore(GRADING_HISTORY_STORE_NAME, { keyPath: 'id' });
        historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        historyStore.createIndex('pdfId', 'pdfId', { unique: false });
        historyStore.createIndex('pageNumber', 'pageNumber', { unique: false });
      }

      // 設定用オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'id' });
      }

      // SNS利用履歴用オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(SNS_USAGE_HISTORY_STORE_NAME)) {
        const snsUsageStore = db.createObjectStore(SNS_USAGE_HISTORY_STORE_NAME, { keyPath: 'id' });
        snsUsageStore.createIndex('timestamp', 'timestamp', { unique: false });
        snsUsageStore.createIndex('snsId', 'snsId', { unique: false });
      }

      // v6へのアップグレード: Base64からBlobへ移行
      if (oldVersion < 6 && db.objectStoreNames.contains(STORE_NAME)) {
        const transaction = (event.target as IDBOpenDBRequest).transaction!;
        const objectStore = transaction.objectStore(STORE_NAME);
        const getAllRequest = objectStore.getAll();

        getAllRequest.onsuccess = () => {
          const records = getAllRequest.result as Array<PDFFileRecord & { fileData?: string | Blob }>;
          console.log(`📦 Base64→Blob移行開始: ${records.length}件のPDF`);

          records.forEach(record => {
            // fileDataが文字列（Base64）でなければスキップ
            if (!record.fileData || typeof record.fileData !== 'string') return

            try {
              // Base64をBlobに変換
              const binaryString = atob(record.fileData);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              record.fileData = new Blob([bytes], { type: 'application/pdf' });
              objectStore.put(record);
              console.log(`✅ ${record.fileName} をBlobに変換`);
            } catch (error) {
              console.error(`❌ ${record.fileName} の変換失敗:`, error);
            }
          });

          console.log('✅ Base64→Blob移行完了');
        };
      }
    };
  });
}

// すべてのPDFファイルレコードを取得
export async function getAllPDFRecords(): Promise<PDFFileRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(STORE_NAME);
    const index = objectStore.index('lastOpened');
    const request = index.openCursor(null, 'prev'); // 最近開いた順

    const records: PDFFileRecord[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (!cursor) {
        console.log(`✅ 全PDFレコード取得完了: ${records.length}件`);
        resolve(records);
        return;
      }

      const record = cursor.value;
      console.log('📄 PDFレコード取得:', {
        id: record.id,
        fileName: record.fileName,
        hasFileData: !!record.fileData,
        fileDataType: record.fileData ? (record.fileData instanceof Blob ? 'Blob' : typeof record.fileData) : 'null',
        fileDataSize: record.fileData instanceof Blob ? record.fileData.size : 'N/A'
      });
      records.push(record);
      cursor.continue();
    };

    request.onerror = () => {
      console.error('❌ PDFレコード取得エラー:', request.error);
      reject(new Error('レコードの取得に失敗しました'));
    };
  });
}

// PDFファイルレコードを追加または更新
export async function savePDFRecord(record: PDFFileRecord): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(STORE_NAME);
    const request = objectStore.put(record);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('レコードの保存に失敗しました'));
    };
  });
}

// PDFファイルレコードの一部を更新
export async function updatePDFRecord(id: string, updates: Partial<PDFFileRecord>): Promise<void> {
  const record = await getPDFRecord(id);
  if (!record) {
    throw new Error(`PDF record not found: ${id}`);
  }
  const updatedRecord = { ...record, ...updates };
  await savePDFRecord(updatedRecord);
}

// 特定のPDFファイルレコードを取得
export async function getPDFRecord(id: string): Promise<PDFFileRecord | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(STORE_NAME);
    const request = objectStore.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error('レコードの取得に失敗しました'));
    };
  });
}

// PDFファイルレコードを削除
export async function deletePDFRecord(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(STORE_NAME);
    const request = objectStore.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('レコードの削除に失敗しました'));
    };
  });
}

// ペン跡を保存
export async function saveDrawing(id: string, pageNumber: number, drawingData: string): Promise<void> {
  const record = await getPDFRecord(id);
  if (!record) {
    throw new Error('PDFレコードが見つかりません');
  }

  record.drawings[pageNumber] = drawingData;
  record.lastOpened = Date.now();

  await savePDFRecord(record);
}

// ペン跡を取得
export async function getDrawing(id: string, pageNumber: number): Promise<string | null> {
  const record = await getPDFRecord(id);
  if (!record) {
    return null;
  }

  return record.drawings[pageNumber] || null;
}

// テキストアノテーションを保存
export async function saveTextAnnotation(id: string, pageNumber: number, textData: string): Promise<void> {
  const record = await getPDFRecord(id);
  if (!record) {
    throw new Error('PDFレコードが見つかりません');
  }

  if (!record.textAnnotations) {
    record.textAnnotations = {};
  }
  record.textAnnotations[pageNumber] = textData;
  record.lastOpened = Date.now();

  await savePDFRecord(record);
}

// テキストアノテーションを取得
export async function getTextAnnotation(id: string, pageNumber: number): Promise<string | null> {
  const record = await getPDFRecord(id);
  if (!record) {
    return null;
  }

  return record.textAnnotations?.[pageNumber] || null;
}

// IDを生成（ファイル名とタイムスタンプから）
export function generatePDFId(fileName: string): string {
  // ファイル名をベースにしたユニークID
  return `${fileName}_${Date.now()}`;
}

// すべてのSNSリンクを取得
export async function getAllSNSLinks(): Promise<SNSLinkRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SNS_STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(SNS_STORE_NAME);
    const index = objectStore.index('createdAt');
    const request = index.openCursor(null, 'next'); // 作成日時順

    const records: SNSLinkRecord[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        resolve(records);
      }
    };

    request.onerror = () => {
      reject(new Error('SNSリンクの取得に失敗しました'));
    };
  });
}

// SNSリンクを追加または更新
export async function saveSNSLink(record: SNSLinkRecord): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SNS_STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(SNS_STORE_NAME);
    const request = objectStore.put(record);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('SNSリンクの保存に失敗しました'));
    };
  });
}

// SNSリンクを削除
export async function deleteSNSLink(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SNS_STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(SNS_STORE_NAME);
    const request = objectStore.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('SNSリンクの削除に失敗しました'));
    };
  });
}

// SNSリンクIDを生成
export function generateSNSLinkId(name: string): string {
  return `sns_${name}_${Date.now()}`;
}

// 採点履歴を保存
export async function saveGradingHistory(record: GradingHistoryRecord): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([GRADING_HISTORY_STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(GRADING_HISTORY_STORE_NAME);
    const request = objectStore.put(record);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('採点履歴の保存に失敗しました'));
    };
  });
}

// すべての採点履歴を取得（新しい順）
export async function getAllGradingHistory(): Promise<GradingHistoryRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([GRADING_HISTORY_STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(GRADING_HISTORY_STORE_NAME);
    const index = objectStore.index('timestamp');
    const request = index.openCursor(null, 'prev'); // 新しい順

    const records: GradingHistoryRecord[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        resolve(records);
      }
    };

    request.onerror = () => {
      reject(new Error('採点履歴の取得に失敗しました'));
    };
  });
}

// 特定のPDFの採点履歴を取得
export async function getGradingHistoryByPdfId(pdfId: string): Promise<GradingHistoryRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([GRADING_HISTORY_STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(GRADING_HISTORY_STORE_NAME);
    const index = objectStore.index('pdfId');
    const request = index.openCursor(IDBKeyRange.only(pdfId), 'prev');

    const records: GradingHistoryRecord[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        resolve(records);
      }
    };

    request.onerror = () => {
      reject(new Error('採点履歴の取得に失敗しました'));
    };
  });
}

// 特定の採点履歴を取得
export async function getGradingHistory(id: string): Promise<GradingHistoryRecord | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([GRADING_HISTORY_STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(GRADING_HISTORY_STORE_NAME);
    const request = objectStore.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error('採点履歴の取得に失敗しました'));
    };
  });
}

// 採点履歴を削除
export async function deleteGradingHistory(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([GRADING_HISTORY_STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(GRADING_HISTORY_STORE_NAME);
    const request = objectStore.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('採点履歴の削除に失敗しました'));
    };
  });
}

// アプリ設定を取得
export async function getAppSettings(): Promise<AppSettings> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(SETTINGS_STORE_NAME);
    const request = objectStore.get('app-settings');

    request.onsuccess = () => {
      const settings = request.result as AppSettings | undefined;
      // デフォルト値: 30分、通知無効、モデルは未指定（バックエンドのデフォルト使用）
      resolve(settings || {
        id: 'app-settings',
        snsTimeLimitMinutes: 30,
        notificationEnabled: false,
        defaultGradingModel: undefined
      });
    };

    request.onerror = () => {
      reject(new Error('設定の取得に失敗しました'));
    };
  });
}

// アプリ設定を保存
export async function saveAppSettings(settings: AppSettings): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(SETTINGS_STORE_NAME);
    const request = objectStore.put(settings);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('設定の保存に失敗しました'));
    };
  });
}

// 採点履歴IDを生成
export function generateGradingHistoryId(): string {
  return `grading_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// SNS利用履歴を保存
export async function saveSNSUsageHistory(record: Omit<SNSUsageHistoryRecord, 'id'>): Promise<void> {
  return new Promise((resolve, reject) => {
    openDB().then((db) => {
      const transaction = db.transaction([SNS_USAGE_HISTORY_STORE_NAME], 'readwrite');
      const objectStore = transaction.objectStore(SNS_USAGE_HISTORY_STORE_NAME);

      const historyRecord: SNSUsageHistoryRecord = {
        id: `sns_usage_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        ...record
      };

      const request = objectStore.add(historyRecord);

      transaction.oncomplete = () => {
        console.log('✅ SNS利用履歴を保存:', historyRecord);
        resolve();
      };

      request.onerror = () => {
        console.error('❌ SNS利用履歴の保存に失敗:', request.error);
        reject(new Error('SNS利用履歴の保存に失敗しました'));
      };
    }).catch(reject);
  });
}

// SNS利用履歴を取得（新しい順）
export async function getSNSUsageHistory(): Promise<SNSUsageHistoryRecord[]> {
  return new Promise((resolve, reject) => {
    openDB().then((db) => {
      const transaction = db.transaction([SNS_USAGE_HISTORY_STORE_NAME], 'readonly');
      const objectStore = transaction.objectStore(SNS_USAGE_HISTORY_STORE_NAME);
      const index = objectStore.index('timestamp');
      const request = index.openCursor(null, 'prev'); // 新しい順

      const results: SNSUsageHistoryRecord[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          console.log('✅ SNS利用履歴を取得:', results.length);
          resolve(results);
        }
      };

      request.onerror = () => {
        console.error('❌ SNS利用履歴の取得に失敗:', request.error);
        reject(new Error('SNS利用履歴の取得に失敗しました'));
      };
    }).catch(reject);
  });
}

// PDFデータを直接ArrayBufferとして取得（iPadのStale Blob対策）
export async function fetchPDFData(id: string): Promise<ArrayBuffer> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const objectStore = transaction.objectStore(STORE_NAME);
    const request = objectStore.get(id);

    request.onsuccess = async () => {
      const record = request.result as PDFFileRecord | undefined;
      if (!record || !record.fileData) {
        reject(new Error('PDFデータが見つかりません'));
        return;
      }

      try {
        let buffer: ArrayBuffer;
        if (record.fileData instanceof Blob) {
          if (record.fileData.size === 0) {
            reject(new Error('PDFファイルのサイズが0バイトです'));
            return;
          }
          // Blobを即座にbufferに読み込むことで、transaction終了後の無効化を防ぐ
          buffer = await record.fileData.arrayBuffer();
        } else {
          // Base64 -> ArrayBuffer
          const binaryString = atob(record.fileData as unknown as string);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          buffer = bytes.buffer;
        }
        resolve(buffer);
      } catch (e) {
        reject(new Error('PDFデータの読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e))));
      }
    };

    request.onerror = () => {
      reject(new Error('PDFデータの取得に失敗しました'));
    };
  });
}
