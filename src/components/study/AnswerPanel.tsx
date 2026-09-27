import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { ICON_SVG } from '../../constants/icons'
import type { PDFStudyAnswerState } from '@home-teacher/common/utils/indexedDB'
import VoiceTextEditor from './VoiceTextEditor'
import './AnswerPanel.css'

export interface AnswerPanelHandle {
  getCompositeImage: () => Promise<string | null>
  getAnswerState: () => PDFStudyAnswerState | null
  undo: () => void
  clear: () => void
  canUndo: boolean
}

interface AnswerPanelProps {
  questionImage: string | null
  initialAnswerState?: PDFStudyAnswerState
  onAnswerStateChange?: (state: PDFStudyAnswerState) => void
  paperOrientation?: 'portrait' | 'landscape'
  penColor: string
  penSize: number
  isEraserMode: boolean
  isTextMode: boolean
  textFontSize: number
  textDirection: 'horizontal' | 'vertical-rl' | 'vertical-lr'
  eraserSize: number
  onCanUndoChange?: (canUndo: boolean) => void
}

type AnswerText = PDFStudyAnswerState['texts'][number]
type AnswerStroke = PDFStudyAnswerState['strokes'][number]

interface AnswerSnapshot {
  drawing: ImageData
  strokes: AnswerStroke[]
  texts: AnswerText[]
}

function drawAnswerText(ctx: CanvasRenderingContext2D, annotation: AnswerText): void {
  ctx.save()
  ctx.fillStyle = annotation.color
  ctx.font = `${annotation.fontSize}px sans-serif`
  ctx.textBaseline = 'top'
  const lines = annotation.text.split('\n')
  const lineHeight = annotation.fontSize * 1.3
  if (annotation.direction === 'horizontal') {
    lines.forEach((line, index) => ctx.fillText(line, annotation.x, annotation.y + index * lineHeight))
  } else {
    lines.forEach((line, column) => {
      const columnX = annotation.x + (annotation.direction === 'vertical-rl' ? lines.length - 1 - column : column) * lineHeight
      Array.from(line).forEach((character, row) => ctx.fillText(character, columnX, annotation.y + row * lineHeight))
    })
  }
  ctx.restore()
}

// Canvas layout constants
const SIDE_MARGIN = 48
const TOP_MARGIN = 36
const BOTTOM_MARGIN = 48
const MIN_IMAGE_WIDTH = 600  // enlarge small captures when the height limit allows it
const MAX_IMAGE_WIDTH = 1400
const MAX_IMAGE_HEIGHT = 900
const MIN_WRITING_HEIGHT = 420
const PAPER_ASPECT_RATIO = 297 / 210  // A4 long side / short side

const AnswerPanel = forwardRef<AnswerPanelHandle, AnswerPanelProps>(({
  questionImage,
  initialAnswerState,
  onAnswerStateChange,
  paperOrientation,
  penColor,
  penSize,
  isEraserMode,
  isTextMode,
  textFontSize,
  textDirection,
  eraserSize,
  onCanUndoChange,
}, ref) => {
  // bgCanvas: question image + writing area background (never modified by user)
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)
  // drawCanvas: transparent overlay for pen strokes only
  const drawCanvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawingRef = useRef(false)
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef<AnswerSnapshot[]>([])
  const strokesRef = useRef<AnswerStroke[]>([])
  const activeStrokeRef = useRef<AnswerStroke | null>(null)
  const textAnnotationsRef = useRef<AnswerText[]>([])
  const [textAnnotations, setTextAnnotations] = useState<AnswerText[]>([])
  const editingTextRef = useRef<{ x: number; y: number; id?: string; initialText: string } | null>(null)
  const [editingText, setEditingText] = useState<{ x: number; y: number; id?: string; initialText: string } | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [eraserCursorPos, setEraserCursorPos] = useState<{ x: number; y: number; diameter: number } | null>(null)

  // Zoom & Pan state
  const [zoom, setZoom] = useState(1.0)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [isCtrlPressed, setIsCtrlPressed] = useState(false)
  const panStartRef = useRef<{ x: number; y: number } | null>(null)
  const gestureRef = useRef<{ startZoom: number; startPan: { x: number; y: number }; startDist: number; startCenter: { x: number; y: number } } | null>(null)
  const textTouchStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onCanUndoChange?.(canUndo)
  }, [canUndo, onCanUndoChange])

  // Match the source PDF page orientation while keeping the capture centered above the writing space.
  const initCanvas = (img: HTMLImageElement) => {
    const bgCanvas = bgCanvasRef.current
    const drawCanvas = drawCanvasRef.current
    if (!bgCanvas || !drawCanvas) return

    // Keep tall captures within the top portion so the sheet remains writable.
    const displayScale = Math.min(
      Math.max(1, MIN_IMAGE_WIDTH / img.naturalWidth),
      MAX_IMAGE_WIDTH / img.naturalWidth,
      MAX_IMAGE_HEIGHT / img.naturalHeight,
    )
    const imgW = Math.round(img.naturalWidth * displayScale)
    const imgH = Math.round(img.naturalHeight * displayScale)
    console.log('[AnswerPanel] initCanvas:', { naturalW: img.naturalWidth, naturalH: img.naturalHeight, displayScale, imgW, imgH })

    const writingH = Math.max(MIN_WRITING_HEIGHT, Math.round(imgH * 0.7))
    const orientation = paperOrientation ?? (imgW > imgH ? 'landscape' : 'portrait')
    const contentHeight = TOP_MARGIN + imgH + writingH + BOTTOM_MARGIN
    const contentWidth = imgW + SIDE_MARGIN * 2
    let w: number
    let h: number
    if (orientation === 'landscape') {
      h = Math.max(800, contentHeight, Math.ceil(Math.max(1200, contentWidth) / PAPER_ASPECT_RATIO))
      w = Math.ceil(h * PAPER_ASPECT_RATIO)
    } else {
      w = Math.max(800, contentWidth, Math.ceil(Math.max(1132, contentHeight) / PAPER_ASPECT_RATIO))
      h = Math.ceil(w * PAPER_ASPECT_RATIO)
    }
    const imageLeft = Math.round((w - imgW) / 2)  // 常に水平中央

    bgCanvas.width = w
    bgCanvas.height = h
    drawCanvas.width = w
    drawCanvas.height = h
    console.log('[AnswerPanel] canvas size:', { w, h, orientation })

    const ctx = bgCanvas.getContext('2d')!

    // White background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    // Question image
    ctx.drawImage(img, imageLeft, TOP_MARGIN, imgW, imgH)


    // Clear draw canvas (fully transparent)
    const dCtx = drawCanvas.getContext('2d')!
    dCtx.clearRect(0, 0, w, h)

    historyRef.current = []
    strokesRef.current = []
    activeStrokeRef.current = null
    const saved = initialAnswerState
    let restoredTexts: AnswerText[] = []
    if (saved && saved.canvasWidth > 0 && saved.canvasHeight > 0) {
      const scaleX = w / saved.canvasWidth
      const scaleY = h / saved.canvasHeight
      const lineScale = Math.sqrt(scaleX * scaleY)
      for (const stroke of saved.strokes ?? []) {
        if (stroke.points.length < 2) continue
        dCtx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over'
        dCtx.strokeStyle = stroke.color
        dCtx.lineWidth = stroke.width * lineScale
        dCtx.lineCap = 'round'
        dCtx.lineJoin = 'round'
        dCtx.beginPath()
        dCtx.moveTo(stroke.points[0][0] * scaleX, stroke.points[0][1] * scaleY)
        for (const [x, y] of stroke.points.slice(1)) dCtx.lineTo(x * scaleX, y * scaleY)
        dCtx.stroke()
      }
      dCtx.globalCompositeOperation = 'source-over'
      strokesRef.current = (saved.strokes ?? []).map(stroke => ({
        ...stroke,
        width: stroke.width * lineScale,
        points: stroke.points.map(([x, y]): [number, number] => [x * scaleX, y * scaleY]),
      }))
      restoredTexts = (saved.texts ?? []).map(annotation => ({
        ...annotation,
        x: annotation.x * scaleX,
        y: annotation.y * scaleY,
        fontSize: annotation.fontSize * lineScale,
      }))
    }
    textAnnotationsRef.current = restoredTexts
    setTextAnnotations(restoredTexts)
    editingTextRef.current = null
    setEditingText(null)
    setCanUndo(false)
    onCanUndoChange?.(false)
  }

  // Load image and init canvas when questionImage changes
  useEffect(() => {
    if (!questionImage) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      initCanvas(img)
      // Reset zoom/pan on new image
      setZoom(1.0)
      const container = containerRef.current
      const style = container ? getComputedStyle(container) : null
      const imageWidth = bgCanvasRef.current?.width ?? 0
      const availableWidth = container && style
        ? container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        : imageWidth
      setPanOffset({ x: Math.min(0, (availableWidth - imageWidth) / 2), y: 0 })
    }
    img.src = questionImage
    return () => {
      cancelled = true
      img.onload = null
    }
  }, [questionImage, paperOrientation, initialAnswerState])

  // Ctrl Key detection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Control') setIsCtrlPressed(true) }
    const handleKeyUp = (e: KeyboardEvent) => { if (e.key === 'Control') setIsCtrlPressed(false) }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  const getAnswerState = (): PDFStudyAnswerState | null => {
    const canvas = drawCanvasRef.current
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null
    const activeStroke = activeStrokeRef.current
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      strokes: activeStroke && activeStroke.points.length > 1
        ? [...strokesRef.current, activeStroke]
        : strokesRef.current,
      texts: textAnnotationsRef.current,
    }
  }

  const publishAnswerState = () => {
    const state = getAnswerState()
    if (state) onAnswerStateChange?.(state)
  }

  const updateTextAnnotations = (next: AnswerText[]) => {
    textAnnotationsRef.current = next
    setTextAnnotations(next)
    publishAnswerState()
  }

  const saveSnapshot = () => {
    const drawCanvas = drawCanvasRef.current
    if (!drawCanvas) return
    const ctx = drawCanvas.getContext('2d')!
    historyRef.current.push({
      drawing: ctx.getImageData(0, 0, drawCanvas.width, drawCanvas.height),
      strokes: [...strokesRef.current],
      texts: [...textAnnotationsRef.current],
    })
    setCanUndo(true)
    onCanUndoChange?.(true)
  }

  const handleUndo = () => {
    const drawCanvas = drawCanvasRef.current
    if (!drawCanvas) return
    const snapshot = historyRef.current.pop()
    if (!snapshot) return
    const ctx = drawCanvas.getContext('2d')!
    ctx.putImageData(snapshot.drawing, 0, 0)
    strokesRef.current = snapshot.strokes
    activeStrokeRef.current = null
    updateTextAnnotations(snapshot.texts)
    const hasHistory = historyRef.current.length > 0
    setCanUndo(hasHistory)
    onCanUndoChange?.(hasHistory)
  }

  const handleClear = () => {
    const drawCanvas = drawCanvasRef.current
    if (!drawCanvas) return
    saveSnapshot()
    const ctx = drawCanvas.getContext('2d')!
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height)
    strokesRef.current = []
    activeStrokeRef.current = null
    updateTextAnnotations([])
    editingTextRef.current = null
    setEditingText(null)
  }

  // Composite bg + draw canvases into a single PNG
  const getCompositeImage = async (): Promise<string | null> => {
    const bgCanvas = bgCanvasRef.current
    const drawCanvas = drawCanvasRef.current
    if (!bgCanvas || !drawCanvas) return null

    const out = document.createElement('canvas')
    out.width = bgCanvas.width
    out.height = bgCanvas.height
    const ctx = out.getContext('2d')!
    ctx.drawImage(bgCanvas, 0, 0)
    ctx.drawImage(drawCanvas, 0, 0)
    textAnnotationsRef.current.forEach(annotation => drawAnswerText(ctx, annotation))
    return out.toDataURL('image/png')
  }

  useImperativeHandle(ref, () => ({
    getCompositeImage,
    getAnswerState,
    undo: handleUndo,
    clear: handleClear,
    canUndo,
  }), [canUndo, questionImage, onCanUndoChange, onAnswerStateChange])

  const getPos = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = drawCanvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }

  const beginText = (clientX: number, clientY: number) => {
    if (editingTextRef.current || !drawCanvasRef.current) return
    const canvas = drawCanvasRef.current
    const pos = getPos(clientX, clientY)
    const editing = {
      x: Math.max(0, Math.min(canvas.width - 1, pos.x)),
      y: Math.max(0, Math.min(canvas.height - 1, pos.y)),
      initialText: '',
    }
    editingTextRef.current = editing
    setEditingText(editing)
  }

  const editText = (annotation: AnswerText) => {
    if (editingTextRef.current) return
    const editing = { x: annotation.x, y: annotation.y, id: annotation.id, initialText: annotation.text }
    editingTextRef.current = editing
    setEditingText(editing)
  }

  const cancelText = () => {
    editingTextRef.current = null
    setEditingText(null)
  }

  const commitText = (value: string) => {
    const editing = editingTextRef.current
    if (!editing) return
    cancelText()
    const nextText = value.trim()
    const current = textAnnotationsRef.current
    if (editing.id) {
      const existing = current.find(annotation => annotation.id === editing.id)
      if (!existing || existing.text === nextText) return
      saveSnapshot()
      updateTextAnnotations(nextText
        ? current.map(annotation => annotation.id === editing.id ? { ...annotation, text: nextText } : annotation)
        : current.filter(annotation => annotation.id !== editing.id))
    } else if (nextText) {
      saveSnapshot()
      updateTextAnnotations([...current, {
        id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        x: editing.x,
        y: editing.y,
        text: nextText,
        fontSize: textFontSize,
        color: penColor,
        direction: textDirection,
      }])
    }
  }

  const eraseText = (id: string) => {
    saveSnapshot()
    updateTextAnnotations(textAnnotationsRef.current.filter(annotation => annotation.id !== id))
  }

  const startDraw = (clientX: number, clientY: number) => {
    saveSnapshot()
    isDrawingRef.current = true
    const canvas = drawCanvasRef.current!
    const pos = getPos(clientX, clientY)
    const scale = canvas.width / canvas.getBoundingClientRect().width
    lastPosRef.current = pos
    activeStrokeRef.current = {
      points: [[Math.round(pos.x * 10) / 10, Math.round(pos.y * 10) / 10]],
      width: (isEraserMode ? eraserSize : penSize) * scale,
      color: penColor,
      eraser: isEraserMode,
    }
  }

  const drawTo = (clientX: number, clientY: number) => {
    if (!isDrawingRef.current || !lastPosRef.current || !drawCanvasRef.current) return
    const canvas = drawCanvasRef.current
    const ctx = canvas.getContext('2d')!
    const pos = getPos(clientX, clientY)
    const stroke = activeStrokeRef.current
    if (!stroke) return

    ctx.beginPath()
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over'
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
    stroke.points.push([Math.round(pos.x * 10) / 10, Math.round(pos.y * 10) / 10])
    lastPosRef.current = pos
  }

  const stopDraw = () => {
    const stroke = activeStrokeRef.current
    if (stroke && stroke.points.length > 1) {
      strokesRef.current = [...strokesRef.current, stroke]
      activeStrokeRef.current = null
      publishAnswerState()
    }
    activeStrokeRef.current = null
    if (drawCanvasRef.current) {
      drawCanvasRef.current.getContext('2d')!.globalCompositeOperation = 'source-over'
    }
    isDrawingRef.current = false
    lastPosRef.current = null
  }

  const getEraserCursorPos = (clientX: number, clientY: number) => {
    const canvas = drawCanvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      diameter: eraserSize,
    }
  }

  const cursor = isPanning ? 'grabbing' : (isCtrlPressed ? 'grab' : (isTextMode ? 'text' : (isEraserMode ? 'none' : ICON_SVG.penCursor(penColor))))
  const editedAnnotation = editingText?.id
    ? textAnnotations.find(annotation => annotation.id === editingText.id)
    : undefined
  const editingDirection = editedAnnotation?.direction ?? textDirection

  // Zoom/Pan Helpers
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheelNative = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()

        const delta = -e.deltaY
        const scaleFactor = 1.1
        const newZoom = delta > 0 ? zoom * scaleFactor : zoom / scaleFactor
        const clampedZoom = Math.min(Math.max(newZoom, 0.2), 5.0)

        // Zoom toward mouse pointer
        const rect = container.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top

        const contentX = (mouseX - panOffset.x) / zoom
        const contentY = (mouseY - panOffset.y) / zoom

        setPanOffset({
          x: mouseX - contentX * clampedZoom,
          y: mouseY - contentY * clampedZoom
        })
        setZoom(clampedZoom)
      } else {
        // Normal scroll translates to pan
        setPanOffset(prev => ({ ...prev, y: prev.y - e.deltaY }))
      }
    }

    container.addEventListener('wheel', handleWheelNative, { passive: false })
    return () => container.removeEventListener('wheel', handleWheelNative)
  }, [zoom, panOffset])

  const startPanning = (clientX: number, clientY: number) => {
    setIsPanning(true)
    panStartRef.current = { x: clientX - panOffset.x, y: clientY - panOffset.y }
  }

  const doPanning = (clientX: number, clientY: number) => {
    if (!isPanning || !panStartRef.current) return
    setPanOffset({
      x: clientX - panStartRef.current.x,
      y: clientY - panStartRef.current.y
    })
  }

  const stopPanning = () => {
    setIsPanning(false)
    panStartRef.current = null
  }

  return (
    <div
      className="answer-panel-content"
      ref={containerRef}
      style={{ overflow: 'hidden', touchAction: 'none' }}
    >
      <div
        className="answer-canvas-stack"
        style={{
          transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isPanning ? 'none' : 'transform 0.1s ease-out'
        }}
      >
        {/* Background layer: question image + writing area */}
        <canvas ref={bgCanvasRef} className="answer-bg-canvas" />
        {/* Drawing layer: transparent overlay for strokes */}
        <canvas
          ref={drawCanvasRef}
          className="answer-draw-canvas"
          style={{ cursor }}
          onMouseDown={(e) => {
            if (isCtrlPressed || e.button === 1) {
              startPanning(e.clientX, e.clientY)
            } else if (e.button === 0 && !isTextMode) {
              startDraw(e.clientX, e.clientY)
            }
          }}
          onClick={(e) => {
            if (isTextMode && !isCtrlPressed && e.button === 0) beginText(e.clientX, e.clientY)
          }}
          onMouseMove={(e) => {
            if (isPanning) {
              doPanning(e.clientX, e.clientY)
            } else {
              if (!isTextMode) {
                if (isEraserMode) setEraserCursorPos(getEraserCursorPos(e.clientX, e.clientY))
                if (e.buttons === 1) drawTo(e.clientX, e.clientY)
              }
            }
          }}
          onMouseUp={() => { stopDraw(); stopPanning() }}
          onMouseLeave={() => { stopDraw(); stopPanning(); setEraserCursorPos(null) }}
          onTouchStart={(e) => {
            if (e.touches.length === 2) {
              stopDraw()
              textTouchStartRef.current = null
              const t1 = e.touches[0]; const t2 = e.touches[1]
              const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
              const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
              gestureRef.current = { startZoom: zoom, startPan: panOffset, startDist: dist, startCenter: center }
            } else if (e.touches.length === 1) {
              const t = e.touches[0]
              if (isTextMode) {
                e.preventDefault()
                textTouchStartRef.current = { x: t.clientX, y: t.clientY, moved: false }
              } else {
                startDraw(t.clientX, t.clientY)
              }
            }
          }}
          onTouchMove={(e) => {
            if (e.touches.length === 2 && gestureRef.current) {
              const t1 = e.touches[0]; const t2 = e.touches[1]
              const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
              const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
              const { startZoom, startPan, startDist, startCenter } = gestureRef.current
              const scale = dist / startDist
              const newZoom = Math.min(Math.max(startZoom * scale, 0.2), 5.0)
              const rect = containerRef.current!.getBoundingClientRect()
              const contentX = (startCenter.x - rect.left - startPan.x) / startZoom
              const contentY = (startCenter.y - rect.top - startPan.y) / startZoom
              setZoom(newZoom)
              setPanOffset({ x: center.x - rect.left - contentX * newZoom, y: center.y - rect.top - contentY * newZoom })
            } else if (e.touches.length === 1) {
              const t = e.touches[0]
              if (isTextMode && textTouchStartRef.current) {
                if (Math.hypot(t.clientX - textTouchStartRef.current.x, t.clientY - textTouchStartRef.current.y) > 8) {
                  textTouchStartRef.current.moved = true
                }
              } else if (!isTextMode) {
                if (isEraserMode) setEraserCursorPos(getEraserCursorPos(t.clientX, t.clientY))
                drawTo(t.clientX, t.clientY)
              }
            }
          }}
          onTouchEnd={(e) => {
            if (isTextMode && e.touches.length === 0 && textTouchStartRef.current && !textTouchStartRef.current.moved) {
              beginText(textTouchStartRef.current.x, textTouchStartRef.current.y)
            }
            textTouchStartRef.current = null
            stopDraw(); stopPanning(); setEraserCursorPos(null); gestureRef.current = null
          }}
        />
        {textAnnotations.map(annotation => editingText?.id === annotation.id ? null : (
          <div
            key={annotation.id}
            className="answer-text-annotation"
            style={{
              left: annotation.x,
              top: annotation.y,
              fontSize: annotation.fontSize,
              color: annotation.color,
              writingMode: annotation.direction === 'horizontal' ? 'horizontal-tb' : annotation.direction,
              pointerEvents: isTextMode || isEraserMode ? 'auto' : 'none',
              cursor: isTextMode ? 'text' : isEraserMode ? 'crosshair' : 'default',
            }}
            onClick={() => {
              if (isTextMode) editText(annotation)
              else if (isEraserMode) eraseText(annotation.id)
            }}
          >
            {annotation.text}
          </div>
        ))}
        {editingText && (
          <VoiceTextEditor
            key={editingText.id ?? `${editingText.x}-${editingText.y}`}
            className="answer-text-editor"
            initialText={editingText.initialText}
            style={{
              left: editingText.x,
              top: editingText.y,
            }}
            textStyle={{
              fontSize: editedAnnotation?.fontSize ?? textFontSize,
              color: editedAnnotation?.color ?? penColor,
              writingMode: editingDirection === 'horizontal' ? 'horizontal-tb' : editingDirection,
            }}
            onCommit={commitText}
            onCancel={cancelText}
          />
        )}
        {/* Eraser circle cursor */}
        {isEraserMode && eraserCursorPos && (
          <div
            style={{
              position: 'absolute',
              left: `${eraserCursorPos.x}px`,
              top: `${eraserCursorPos.y}px`,
              width: `${eraserSize}px`,
              height: `${eraserSize}px`,
              borderRadius: '50%',
              backgroundColor: 'rgba(255, 100, 100, 0.2)',
              border: '2px solid rgba(255, 100, 100, 0.6)',
              pointerEvents: 'none',
              transform: 'translate(-50%, -50%)',
              zIndex: 9999,
            }}
          />
        )}
      </div>
    </div>
  )
})

AnswerPanel.displayName = 'AnswerPanel'

export default AnswerPanel
