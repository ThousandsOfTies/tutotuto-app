import { useEffect, useState } from 'react'
import { GradingHistoryRecord, getAllGradingHistory, deleteGradingHistory, SNSUsageHistoryRecord, getSNSUsageHistory } from '../../utils/indexedDB'
import './GradingHistory.css'
import { useTranslation } from 'react-i18next'

interface GradingHistoryProps {
  onClose: () => void
  onSelectHistory?: (history: GradingHistoryRecord) => void
}

const GradingHistory = ({ onClose, onSelectHistory }: GradingHistoryProps) => {
  const { t } = useTranslation()
  const [historyList, setHistoryList] = useState<GradingHistoryRecord[]>([])
  const [snsHistoryList, setSnsHistoryList] = useState<SNSUsageHistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedHistory, setSelectedHistory] = useState<GradingHistoryRecord | null>(null)
  const [filterType, setFilterType] = useState<'all' | 'grading' | 'sns'>('all')
  const [filterCorrect, setFilterCorrect] = useState<'all' | 'correct' | 'incorrect'>('all')
  const [searchQuery, setSearchQuery] = useState('')


  // 履歴を読み込む
  useEffect(() => {
    loadHistory()
  }, [])

  const loadHistory = async () => {
    setLoading(true)
    try {
      const records = await getAllGradingHistory()
      setHistoryList(records)
      const snsRecords = await getSNSUsageHistory()
      setSnsHistoryList(snsRecords)
    } catch (error) {
      console.error('履歴の読み込みに失敗:', error)
    } finally {
      setLoading(false)
    }
  }

  // 履歴を削除
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(t('gradingHistory.deleteConfirm'))) return

    try {
      await deleteGradingHistory(id)
      await loadHistory()
      if (selectedHistory?.id === id) {
        setSelectedHistory(null)
      }
    } catch (error) {
      console.error('履歴の削除に失敗:', error)
      alert(t('gradingHistory.deleteError'))
    }
  }

  // 統合履歴型
  type UnifiedHistoryItem =
    | { type: 'grading'; data: GradingHistoryRecord }
    | { type: 'sns'; data: SNSUsageHistoryRecord }

  // 統合＆ソート
  const unifiedHistory: UnifiedHistoryItem[] = [
    ...historyList.map(item => ({ type: 'grading' as const, data: item })),
    ...snsHistoryList.map(item => ({ type: 'sns' as const, data: item }))
  ].sort((a, b) => b.data.timestamp - a.data.timestamp) // 新しい順

  // フィルタリング
  const filteredHistory = unifiedHistory.filter(item => {
    // タイプフィルター
    if (filterType === 'grading' && item.type !== 'grading') return false
    if (filterType === 'sns' && item.type !== 'sns') return false

    // 採点履歴の場合の正解/不正解フィルター
    if (item.type === 'grading') {
      if (filterCorrect === 'correct' && !item.data.isCorrect) return false
      if (filterCorrect === 'incorrect' && item.data.isCorrect) return false

      // 検索クエリフィルター
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        return (
          item.data.pdfFileName.toLowerCase().includes(query) ||
          item.data.problemNumber.toLowerCase().includes(query) ||
          item.data.studentAnswer.toLowerCase().includes(query)
        )
      }
    }

    // SNS履歴の場合の検索フィルター
    if (item.type === 'sns' && searchQuery) {
      const query = searchQuery.toLowerCase()
      return item.data.snsName.toLowerCase().includes(query)
    }

    return true
  })

  // 統計情報を計算
  const totalCount = historyList.length
  const correctCount = historyList.filter(r => r.isCorrect).length
  const incorrectCount = totalCount - correctCount
  const correctRate = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0
  const snsCount = snsHistoryList.length

  // 日付をフォーマット
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div className="grading-history-overlay">
      <div className="grading-history-panel">
        <div className="history-header">
          <h2>{t('gradingHistory.title')}</h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 統計情報 */}
        <div className="history-stats">
          <div className="stat-item">
            <span className="stat-value" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span className="result-badge correct" style={{ width: '20px', height: '20px', fontSize: '12px' }}>✓</span>
                {correctCount}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span className="result-badge incorrect" style={{ width: '20px', height: '20px', fontSize: '12px' }}>✗</span>
                {incorrectCount}
              </span>
              <span>📱 {t('gradingHistory.snsCount')}: {snsCount}{t('gradingHistory.times')}</span>
              <span>{t('gradingHistory.correctRate')}: {correctRate}%</span>
            </span>
          </div>
        </div>

        {/* フィルターと検索 */}
        <div className="history-filters">
          <div className="filter-buttons">
            <button
              className={filterType === 'all' ? 'active' : ''}
              onClick={() => setFilterType('all')}
              title="すべて表示"
            >
              {t('gradingHistory.filterAll')}
            </button>
            <button
              className={filterType === 'grading' ? 'active' : ''}
              onClick={() => setFilterType('grading')}
              title="採点のみ"
            >
              {t('gradingHistory.filterGrading')}
            </button>
            <button
              className={filterType === 'sns' ? 'active' : ''}
              onClick={() => setFilterType('sns')}
              title="SNSのみ"
            >
              {t('gradingHistory.filterSNS')}
            </button>

            {filterType !== 'sns' && (
              <>
                <div style={{ width: '1px', height: '20px', backgroundColor: '#ddd', margin: '0 4px' }}></div>
                <button
                  className={filterCorrect === 'correct' ? 'active' : ''}
                  onClick={() => setFilterCorrect('correct')}
                  title="正解のみ"
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px' }}
                >
                  <span className="result-badge correct" style={{ width: '20px', height: '20px', fontSize: '12px' }}>✓</span>
                </button>
                <button
                  className={filterCorrect === 'incorrect' ? 'active' : ''}
                  onClick={() => setFilterCorrect('incorrect')}
                  title="不正解のみ"
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px' }}
                >
                  <span className="result-badge incorrect" style={{ width: '20px', height: '20px', fontSize: '12px' }}>✗</span>
                </button>
              </>
            )}
          </div>
          <input
            type="text"
            className="search-input"
            placeholder={t('gradingHistory.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* 統合タイムライン */}
        <div className="history-content">
          {loading ? (
            <div className="loading">{t('gradingHistory.loading')}</div>
          ) : filteredHistory.length === 0 ? (
            <div className="empty-message">
              {searchQuery || filterType !== 'all'
                ? t('gradingHistory.noResults')
                : t('gradingHistory.noHistory')}
            </div>
          ) : (
            <div className="history-list">
              {filteredHistory.map((item, index) => (
                <div key={`${item.type}-${item.data.id}-${index}`}>
                  {item.type === 'grading' ? (
                    // 採点履歴
                    <div
                      className={`history-item ${item.data.isCorrect ? 'correct' : 'incorrect'} ${selectedHistory?.id === item.data.id ? 'selected' : ''
                        }`}
                      onClick={() => setSelectedHistory(item.data)}
                    >
                      <div className="history-item-header">
                        <span className={`result-badge ${item.data.isCorrect ? 'correct' : 'incorrect'}`}>
                          {item.data.isCorrect ? '✓' : '✗'}
                        </span>
                        <span className="problem-info">
                          {item.data.pdfFileName} - {t('gradingHistory.page')}{item.data.pageNumber} - {t('gradingHistory.problem')}{item.data.problemNumber}
                        </span>
                        <button
                          className="delete-btn"
                          onClick={(e) => handleDelete(item.data.id, e)}
                          title="削除"
                        >
                          🗑️
                        </button>
                      </div>
                      <div className="history-item-content">
                        <div className="timestamp">{formatDate(item.data.timestamp)}</div>
                        <div className="answer-preview">
                          解答: {item.data.studentAnswer?.substring(0, 50) || '(なし)'}
                          {(item.data.studentAnswer?.length || 0) > 50 ? '...' : ''}
                        </div>
                      </div>
                    </div>
                  ) : (
                    // SNS利用履歴
                    <div className="history-item sns-item">
                      <div className="history-item-header" style={{ backgroundColor: '#f8f9fa' }}>
                        <span style={{ fontSize: '20px' }}>📱</span>
                        <span className="problem-info" style={{ color: '#7f8c8d' }}>
                          {item.data.snsName} - {item.data.timeLimitMinutes}{t('gradingHistory.minutes_short')}
                        </span>
                      </div>
                      <div className="history-item-content">
                        <div className="timestamp">{formatDate(item.data.timestamp)}</div>
                        <div className="answer-preview" style={{ fontSize: '12px', color: '#95a5a6' }}>
                          {item.data.snsUrl}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 詳細パネル（採点履歴のみ） */}
        {selectedHistory && (
          <div className="history-detail">
            <div className="detail-header">
              <h3>{t('gradingHistory.detailTitle')}</h3>
              <button className="close-detail-btn" onClick={() => setSelectedHistory(null)}>
                ✕
              </button>
            </div>
            <div className="detail-content">
              <div className="detail-section">
                <h4>{t('gradingHistory.problemInfo')}</h4>
                <p><strong>{t('gradingHistory.workbook')}:</strong> {selectedHistory.pdfFileName}</p>
                <p><strong>{t('gradingHistory.page')}:</strong> {selectedHistory.pageNumber}</p>
                <p><strong>{t('gradingHistory.problemNumber')}:</strong> {selectedHistory.problemNumber}</p>
                <p><strong>{t('gradingHistory.dateTime')}:</strong> {formatDate(selectedHistory.timestamp)}</p>
              </div>

              <div className="detail-section">
                <h4>{t('gradingHistory.answer')}</h4>
                <div className={`result-indicator ${selectedHistory.isCorrect ? 'correct' : 'incorrect'}`}>
                  {selectedHistory.isCorrect ? t('gradingHistory.correct') : t('gradingHistory.incorrect')}
                </div>
                <p><strong>{t('gradingHistory.yourAnswer')}:</strong></p>
                <div className="answer-box">{selectedHistory.studentAnswer}</div>
              </div>

              {!selectedHistory.isCorrect && (
                <div className="detail-section">
                  <h4>{t('gradingHistory.correctAnswer')}</h4>
                  <div className="answer-box">{selectedHistory.correctAnswer}</div>
                </div>
              )}

              <div className="detail-section">
                <h4>{t('gradingHistory.feedback')}</h4>
                <div className="feedback-box">{selectedHistory.feedback}</div>
              </div>

              <div className="detail-section">
                <h4>{t('gradingHistory.explanation')}</h4>
                <div className="explanation-box">{selectedHistory.explanation}</div>
              </div>

              {selectedHistory.imageData && (
                <div className="detail-section">
                  <h4>{t('gradingHistory.gradingImage')}</h4>
                  <img
                    src={selectedHistory.imageData}
                    alt="採点時の画像"
                    className="grading-image"
                  />
                </div>
              )}

              {selectedHistory.matchingMetadata && (
                <div className="detail-section">
                  <h4>Matching Metadata (Debug)</h4>
                  <div className="metadata-box" style={{
                    backgroundColor: '#f8f9fa',
                    padding: '12px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    border: '1px solid #e9ecef'
                  }}>
                    <p style={{ margin: '4px 0' }}><strong>Method:</strong> {selectedHistory.matchingMetadata.method}</p>
                    {selectedHistory.matchingMetadata.confidence && (
                      <p style={{ margin: '4px 0' }}><strong>Confidence:</strong> {selectedHistory.matchingMetadata.confidence}</p>
                    )}
                    {selectedHistory.matchingMetadata.similarity !== undefined && (
                      <p style={{ margin: '4px 0' }}><strong>Similarity:</strong> {selectedHistory.matchingMetadata.similarity.toFixed(4)}</p>
                    )}
                    {selectedHistory.matchingMetadata.reasoning && (
                      <div style={{ margin: '4px 0' }}>
                        <strong>Reasoning:</strong>
                        <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap' }}>{selectedHistory.matchingMetadata.reasoning}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="history-footer">
          <button className="close-button" onClick={onClose}>
            {t('gradingHistory.closeButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default GradingHistory
