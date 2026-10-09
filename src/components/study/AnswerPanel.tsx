import { useAnswerWheel } from '@home-teacher/common/hooks/useAnswerWheel'
import { pinchViewport, touchPair } from '@thousands-of-ties/drawing-common'
import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { ICON_SVG } from '../../constants/icons'
import type { PDFStudyAnswerState } from '@home-teacher/common/utils/indexedDB'
import { CanvasUndoHistory, doPathsIntersect, isScratchPattern, type DrawingPath } from '@thousands-of-ties/drawing-common'
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

const toDrawingPath = (stroke: AnswerStroke): DrawingPath => ({
  points: stroke.points.map(([x, y]) => ({ x, y })),
  color: stroke.color,
  width: stroke.width,
})

const redrawAnswerStrokes = (canvas: HTMLCanvasElement, strokes: AnswerStroke[]) => {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue
    ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over'
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1])
    for (const [x, y] of stroke.points.slice(1)) ctx.lineTo(x, y)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}

interface AnswerSnapshot {
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
  const historyRef = useRef(new CanvasUndoHistory<AnswerSnapshot>())
  const strokesRef = useRef<AnswerStroke[]>([])
  const activeStrokeRef = useRef<AnswerStroke | null>(null)
  const questionLayoutRef = useRef<PDFStudyAnswerState['questionLayout']>(undefined)
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
  const [isPinching, setIsPinching] = useState(false)
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
    let imgW = Math.round(img.naturalWidth * displayScale)
    let imgH = Math.round(img.naturalHeight * displayScale)
    const orientation = paperOrientation ?? (imgW > imgH ? 'landscape' : 'portrait')
    const paperSize = (imageWidth: number, imageHeight: number) => {
      const writingH = Math.max(MIN_WRITING_HEIGHT, Math.round(imageHeight * 0.7))
      const contentHeight = TOP_MARGIN + imageHeight + writingH + BOTTOM_MARGIN
      const contentWidth = imageWidth + SIDE_MARGIN * 2
      if (orientation === 'landscape') {
        const height = Math.max(800, contentHeight, Math.ceil(Math.max(1200, contentWidth) / PAPER_ASPECT_RATIO))
        return { w: Math.ceil(height * PAPER_ASPECT_RATIO), h: height }
      }
      const width = Math.max(800, contentWidth, Math.ceil(Math.max(1132, contentHeight) / PAPER_ASPECT_RATIO))
      return { w: width, h: Math.ceil(width * PAPER_ASPECT_RATIO) }
    }

    const saved = initialAnswerState
    const hasSavedPaper = saved && saved.canvasWidth > 0 && saved.canvasHeight > 0
    const savedLayout = saved?.questionLayout
    const hasSavedLayout = savedLayout && savedLayout.width > 0 && savedLayout.height > 0 &&
      [savedLayout.x, savedLayout.y, savedLayout.width, savedLayout.height].every(Number.isFinite)
    if (hasSavedLayout) {
      imgW = savedLayout.width
      imgH = savedLayout.height
    } else if (hasSavedPaper) {
      // Older histories recorded the paper size but omitted image placement.
      // Recover the former display size where the paper dimensions constrain it.
      const ratio = img.naturalWidth / img.naturalHeight
      let best: { width: number; height: number; difference: number } | undefined
      for (let height = 1; height <= MAX_IMAGE_HEIGHT; height++) {
        const expectedWidth = Math.round(height * ratio)
        for (let width = Math.max(1, expectedWidth - 2); width <= Math.min(MAX_IMAGE_WIDTH, expectedWidth + 2); width++) {
          const candidate = paperSize(width, height)
          if (candidate.w !== saved.canvasWidth || candidate.h !== saved.canvasHeight) continue
          const difference = Math.abs(width - imgW) + Math.abs(height - imgH)
          if (!best || difference < best.difference) best = { width, height, difference }
        }
      }
      if (best) {
        imgW = best.width
        imgH = best.height
      }
    }
    const { w, h } = hasSavedPaper ? { w: saved.canvasWidth, h: saved.canvasHeight } : paperSize(imgW, imgH)
    const imageLeft = hasSavedLayout ? savedLayout.x : Math.round((w - imgW) / 2)
    const imageTop = hasSavedLayout ? savedLayout.y : TOP_MARGIN
    questionLayoutRef.current = { x: imageLeft, y: imageTop, width: imgW, height: imgH }
    console.log('[AnswerPanel] initCanvas:', { naturalW: img.naturalWidth, naturalH: img.naturalHeight, displayScale, imgW, imgH })

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
    ctx.drawImage(img, imageLeft, imageTop, imgW, imgH)

    // Clear draw canvas (fully transparent)
    const dCtx = drawCanvas.getContext('2d')!
    dCtx.clearRect(0, 0, w, h)

    historyRef.current.clear()
    strokesRef.current = []
    activeStrokeRef.current = null
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
      questionLayout: questionLayoutRef.current,
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
    if (!historyRef.current.push(drawCanvas, {
      strokes: [...strokesRef.current],
      texts: [...textAnnotationsRef.current],
    })) return
    setCanUndo(true)
    onCanUndoChange?.(true)
  }

  const handleUndo = () => {
    const drawCanvas = drawCanvasRef.current
    if (!drawCanvas) return
    const snapshot = historyRef.current.undo(drawCanvas)?.state
    if (!snapshot) return
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
      const path = toDrawingPath(stroke)
      if (!stroke.eraser && isScratchPattern(path)) {
        strokesRef.current = strokesRef.current.filter(existing =>
          existing.eraser || !doPathsIntersect(path, toDrawingPath(existing))
        )
        if (drawCanvasRef.current) redrawAnswerStrokes(drawCanvasRef.current, strokesRef.current)
      } else {
        strokesRef.current = [...strokesRef.current, stroke]
      }
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
  useAnswerWheel(containerRef, { zoom, panOffset, setZoom, setPanOffset })

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
          transition: isPanning || isPinching ? 'none' : 'transform 0.1s ease-out'
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
              setIsPinching(true)
              stopDraw()
              textTouchStartRef.current = null
              const pair = touchPair(e.touches)
              gestureRef.current = { startZoom: zoom, startPan: panOffset, startDist: pair.distance, startCenter: pair.center }
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
              const bounds = containerRef.current?.getBoundingClientRect()
              if (!bounds) return
              const view = pinchViewport(gestureRef.current, touchPair(e.touches), bounds, 0.2)
              if (view) { setZoom(view.zoom); setPanOffset(view.panOffset) }
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
            if (e.touches.length < 2) setIsPinching(false)
            if (isTextMode && e.touches.length === 0 && textTouchStartRef.current && !textTouchStartRef.current.moved) {
              beginText(textTouchStartRef.current.x, textTouchStartRef.current.y)
            }
            textTouchStartRef.current = null
            stopDraw(); stopPanning(); setEraserCursorPos(null); gestureRef.current = null
          }}
          onTouchCancel={() => {
            setIsPinching(false)
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
              position: 'absolute',
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
