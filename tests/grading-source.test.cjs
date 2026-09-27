const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real component handlers with deterministic canvas/API/storage adapters.
const filename = path.join(__dirname, '../src/components/study/StudyPanel.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const answerFilename = path.join(__dirname, '../src/components/study/AnswerPanel.tsx');
const answerAst = ts.createSourceFile(answerFilename, fs.readFileSync(answerFilename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, adapters, componentAst = ast) {
    let initializer;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(componentAst) === name) initializer = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(componentAst);
    assert.ok(initializer, name);
    const code = ts.transpileModule('const run = ' + initializer.getText(componentAst), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    return vm.runInNewContext(code + '\nrun', adapters);
}

function capture({ activeTab = 'A', isSplitView = false, pageA = 1, pageB = 5, pageAOrientation = 'landscape', pageBOrientation = 'portrait' } = {}) {
    const bounds = (left, right) => ({ left, right, top: 0, bottom: 100, width: right - left, height: 100 });
    // A's zoomed canvas extends under B; it must be clipped at the pane edge.
    const pane = (left, right, canvasRight, orientation) => ({
        getBoundingClientRect: () => bounds(left, right),
        querySelector: () => ({
            getBoundingClientRect: () => ({
                ...bounds(left, canvasRight),
                bottom: orientation === 'landscape' ? 100 : 200,
                height: orientation === 'landscape' ? 100 : 200,
            }),
            width: 1, height: 1, // PDFPane can use a 1x1 bitmap while keeping its page-sized layout.
        }),
    });
    const panes = {
        '.pane-a': pane(0, 100, 250, pageAOrientation),
        '.pane-b': pane(100, 200, 200, pageBOrientation),
    };
    return handler('captureSelectionArea', {
        activeTab, isSplitView, pageA, pageB,
        containerRef: { current: {
            getBoundingClientRect: () => bounds(0, 200),
            querySelector: selector => panes[selector],
        } },
        paneARef: { current: { getCanvas: () => ({ width: 250, height: 100 }) } },
        paneBRef: { current: { getCanvas: () => ({ width: 100, height: 100 }) } },
        document: { createElement: () => ({
            getContext: () => ({ drawImage() {}, fillRect() {} }),
            toDataURL: () => 'data:image/png;base64,test',
        }) },
    });
}
const rect = (x, width) => ({ x, y: 0, width, height: 100 });
test('captures A, B, both panes, duplicate pages and empty selections accurately', async () => {
    for (const [options, selection, expected] of [
        [{}, rect(0, 100), [1]],
        [{ activeTab: 'B' }, rect(100, 100), [5]],
        [{ isSplitView: true }, rect(110, 80), [5]],
        [{ isSplitView: true }, rect(0, 200), [1, 5]],
        [{ isSplitView: true, pageB: 1 }, rect(0, 200), [1]],
    ]) {
        const result = await capture(options)(selection);
        assert.deepEqual(Array.from(result.sourcePageNumbers), expected);
    }
    const zoomed = await capture({ isSplitView: true })(rect(0, 200));
    assert.deepEqual(Array.from(zoomed.regions, region => [region.pageNumber, region.x, region.width]), [
        [1, 0, 0.4], [5, 0, 1],
    ]);
    assert.equal((await capture()(rect(0, 40))).paperOrientation, 'landscape');
    assert.equal((await capture({ activeTab: 'B' })(rect(100, 40))).paperOrientation, 'portrait');
    assert.equal(await capture({ isSplitView: true })(rect(300, 100)), null);
});

test('reads the orientation of the source PDF page', async () => {
    const run = handler('getPDFPageOrientation', {
        pdfDoc: { getPage: async pageNumber => ({
            getViewport: () => pageNumber === 1 ? { width: 297, height: 210 } : { width: 210, height: 297 },
        }) },
        console,
    });
    assert.equal(await run(1), 'landscape');
    assert.equal(await run(2), 'portrait');
});

test('answer paper follows PDF orientation and centers the selected image', () => {
    for (const [paperOrientation, imageWidth, imageHeight] of [
        ['landscape', 300, 700],
        ['portrait', 700, 300],
    ]) {
        let imagePlacement;
        const bgCanvas = { getContext: () => ({
            fillRect() {}, drawImage: (...args) => { imagePlacement = args; },
        }) };
        const drawCanvas = { getContext: () => ({ clearRect() {} }) };
        const run = handler('initCanvas', {
            bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas },
            paperOrientation, initialAnswerState: undefined,
            SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
            MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
            MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
            historyRef: { current: [] }, textAnnotationsRef: { current: [] },
            strokesRef: { current: [] }, activeStrokeRef: { current: null },
            editingTextRef: { current: null },
            setTextAnnotations() {}, setEditingText() {}, setCanUndo() {}, onCanUndoChange() {},
            console: { log() {} },
        }, answerAst);
        run({ naturalWidth: imageWidth, naturalHeight: imageHeight });
        assert.equal(bgCanvas.width > bgCanvas.height, paperOrientation === 'landscape');
        assert.equal(imagePlacement[1], Math.round((bgCanvas.width - imagePlacement[3]) / 2));
        assert.ok(bgCanvas.height - imagePlacement[4] - imagePlacement[2] >= 420);
    }
});

test('rebuilds pen strokes and text on the answer sheet', () => {
    const drawn = [];
    const saved = {
        canvasWidth: 800, canvasHeight: 1200,
        strokes: [{ points: [[100, 100], [150, 200]], width: 8, color: '#123456', eraser: false }],
        texts: [{ id: 'text', x: 200, y: 300, text: '解答', fontSize: 24, color: '#123456', direction: 'horizontal' }],
    };
    const bgCanvas = { getContext: () => ({ fillRect() {}, drawImage() {} }) };
    const drawCanvas = { getContext: () => ({
        clearRect() {}, beginPath() {}, moveTo() {},
        lineTo: (...args) => drawn.push(args), stroke() {},
    }) };
    const strokesRef = { current: [] }, textAnnotationsRef = { current: [] };
    const run = handler('initCanvas', {
        bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas },
        paperOrientation: 'portrait', initialAnswerState: saved,
        SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
        MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
        MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
        historyRef: { current: [] }, strokesRef, activeStrokeRef: { current: null },
        textAnnotationsRef, editingTextRef: { current: null },
        setTextAnnotations() {}, setEditingText() {}, setCanUndo() {}, onCanUndoChange() {},
        console: { log() {} },
    }, answerAst);
    run({ naturalWidth: 300, naturalHeight: 400 });
    assert.equal(drawn.length, 1);
    assert.equal(strokesRef.current.length, 1);
    assert.equal(textAnnotationsRef.current[0].text, '解答');
    assert.equal(drawn[0][0], 150 * bgCanvas.width / saved.canvasWidth);
    assert.equal(drawn[0][1], 200 * bgCanvas.height / saved.canvasHeight);
});

test('finishing a pen or eraser stroke publishes its coordinates', () => {
    const context = { beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
    const canvas = {
        width: 800, height: 1200,
        getBoundingClientRect: () => ({ width: 800 }),
        getContext: () => context,
    };
    const drawCanvasRef = { current: canvas };
    const isDrawingRef = { current: false }, lastPosRef = { current: null };
    const activeStrokeRef = { current: null }, strokesRef = { current: [] };
    const saved = [];
    const getPos = (x, y) => ({ x, y });
    const publishAnswerState = () => saved.push(strokesRef.current.map(stroke => ({ ...stroke })));
    for (const isEraserMode of [false, true]) {
        const adapters = {
            saveSnapshot() {}, isDrawingRef, lastPosRef, activeStrokeRef, strokesRef,
            drawCanvasRef, getPos, isEraserMode, eraserSize: 20, penSize: 5,
            penColor: '#123456', publishAnswerState,
        };
        handler('startDraw', { ...adapters }, answerAst)(10, 20);
        handler('drawTo', { ...adapters }, answerAst)(30, 40);
        handler('stopDraw', { ...adapters }, answerAst)();
    }
    assert.equal(saved.length, 2);
    assert.deepEqual(Array.from(saved[0][0].points, point => Array.from(point)), [[10, 20], [30, 40]]);
    assert.equal(saved[1][1].eraser, true);
    assert.equal(saved[1][1].width, 20);
});

test('saves the latest answer for a PDF range without a second image', async () => {
    const pending = new Map();
    const markers = new Map(['first', 'second'].map(id => [id, {
        id, pdfId: 'book', regions: [], sourcePageNumbers: [1],
    }]));
    const run = handler('saveStudyAnswer', {
        pendingAnswerWritesRef: { current: pending },
        getPDFStudyMarker: async id => markers.get(id),
        savePDFStudyMarker: async value => {
            await new Promise(resolve => setTimeout(resolve, 1));
            markers.set(value.id, value);
        },
        addStatusMessage() {}, console,
    });
    const first = { canvasWidth: 800, canvasHeight: 1200, strokes: [], texts: [] };
    const second = { ...first, strokes: [{ points: [[1, 1], [2, 2]], width: 5, color: '#000', eraser: false }] };
    run('first', first);
    run('first', second);
    run('second', { ...first, texts: [{ id: 'other', text: '別の解答' }] });
    await Promise.all([pending.get('first'), pending.get('second')]);
    assert.equal(markers.get('first').answer.strokes.length, 1);
    assert.equal(markers.get('first').answer.texts.length, 0);
    assert.equal(markers.get('second').answer.strokes.length, 0);
    assert.equal(markers.get('second').answer.texts[0].text, '別の解答');
    assert.equal(JSON.stringify(markers.get('first')).includes('data:image'), false);
});

test('confirming a PDF range stores coordinates without storing the cropped image', async () => {
    const saved = [], panels = [];
    const run = handler('handleSelectionEnd', {
        isSelectingRef: { current: true }, selectionRect: { x: 0, y: 0, width: 100, height: 100 },
        captureSelectionArea: async () => ({
            image: 'data:image/png;base64,temporary', sourcePageNumbers: [2],
            regions: [{ pageNumber: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
        }),
        crypto: { randomUUID: () => 'range' }, pdfId: 'book',
        savePDFStudyMarker: async value => saved.push(value),
        setStudyTraces() {}, pushPanel: value => panels.push(value),
        setIsSelectionMode() {}, setSelectionRect() {}, addStatusMessage() {}, console,
    });
    await run();
    assert.equal(saved.length, 1);
    assert.deepEqual(Array.from(saved[0].regions, region => region.pageNumber), [2]);
    assert.equal(JSON.stringify(saved[0]).includes('temporary'), false);
    assert.equal(panels[0].questionImage, 'data:image/png;base64,temporary');
});

test('history and grading panels retain captured pages despite later PDF navigation', async () => {
    const records = [], panels = [], traces = [];
    const noop = () => {};
    const run = handler('confirmAndGrade', {
        setIsGrading: noop, setGradingError: noop, addStatusMessage: noop,
        panelStack: [{ type: 'answer', traceId: 'trace' }], activePanelIndex: 0,
        pendingAnswerWritesRef: { current: new Map() },
        getPDFStudyMarker: async () => ({ id: 'trace', pdfId: 'book', regions: [], sourcePageNumbers: [5] }),
        savePDFStudyMarker: async value => traces.push(value), setStudyTraces: noop,
        compressImageDataUrl: async value => value,
        Image: class {
            width = 100; height = 100;
            set src(_) { queueMicrotask(() => this.onload()); }
        },
        selectedModel: 'default', i18n: { language: 'ja' },
        gradeWork: async () => ({
            success: true,
            result: { problems: [{ problemNumber: '1', studentAnswer: '5', isCorrect: true }] },
        }),
        pushPanel: value => panels.push(value), updateGradingPanel: noop,
        pdfId: 'book', pdfRecord: { fileName: 'book.pdf' }, pageA: 99, pageB: 100,
        saveGradingImage: async () => 'image', generateGradingHistoryId: () => 'history',
        saveGradingHistory: async value => records.push(value),
        teacherMode: 'balanced', isPanesReversed: false, t: key => key, console,
    });
    await run('image', [5]);
    await run('image', [1, 5]);
    assert.deepEqual(records.map(record => record.pageNumber), [5, 1]);
    assert.deepEqual(records.map(record => record.sourcePageNumbers), [[5], [1, 5]]);
    assert.deepEqual(panels.map(panel => panel.sourcePageNumbers), [[5], [1, 5]]);
    assert.equal(traces.length, 2);
    assert.equal(traces[0].grading.result.problems[0].problemNumber, '1');
});

test('a graded PDF mark restores the answer sheet before its grading result', async () => {
    let panels, activeIndex;
    const answer = { canvasWidth: 800, canvasHeight: 1200, strokes: [{ points: [[1, 2]] }], texts: [] };
    const run = handler('openStudyTrace', {
        pdfId: 'book',
        pendingAnswerWritesRef: { current: new Map() },
        getPDFPageOrientation: async () => 'landscape',
        getPDFStudyMarker: async () => ({
            id: 'trace', pdfId: 'book', sourcePageNumbers: [2],
            regions: [{ pageNumber: 2 }], answer,
            grading: { result: { problems: [] }, modelName: null, responseTime: 1 },
        }),
        recreateQuestionImage: async () => 'data:image/png;base64,recreated',
        setPanelStack: value => { panels = value; },
        setActivePanelIndex: value => { activeIndex = value; },
        setIsSelectionMode() {}, setIsGradingCaptureMode() {}, setSelectionRect() {},
        addStatusMessage() {}, console,
    });
    await run('trace');
    assert.deepEqual(Array.from(panels, panel => panel.type), ['pdf', 'answer', 'grading']);
    assert.equal(panels[1].traceId, 'trace');
    assert.equal(panels[1].paperOrientation, 'landscape');
    assert.equal(panels[1].questionImage, 'data:image/png;base64,recreated');
    assert.equal(panels[1].answerState, answer);
    assert.equal(panels[2].result.problems.length, 0);
    assert.equal(activeIndex, 1);
});

test('an ungraded PDF mark opens its saved answer', async () => {
    let panels;
    const answer = { canvasWidth: 800, canvasHeight: 1200, strokes: [], texts: [{ id: 'a', text: '解答' }] };
    const run = handler('openStudyTrace', {
        pdfId: 'book', pendingAnswerWritesRef: { current: new Map() },
        getPDFStudyMarker: async () => ({
            id: 'trace', pdfId: 'book', sourcePageNumbers: [2], regions: [{ pageNumber: 2 }], answer,
        }),
        getPDFPageOrientation: async () => 'portrait',
        recreateQuestionImage: async () => 'data:image/png;base64,recreated',
        setPanelStack: value => { panels = value; }, setActivePanelIndex() {},
        setIsSelectionMode() {}, setIsGradingCaptureMode() {}, setSelectionRect() {},
        addStatusMessage() {}, console,
    });
    await run('trace');
    assert.equal(panels[1].type, 'answer');
    assert.equal(panels[1].answerState, answer);
});

test('answer export preserves the selected answer source across async panel navigation', async () => {
    let resolve;
    const image = new Promise(yes => { resolve = yes; });
    const stack = [{ type: 'answer', sourcePageNumbers: [5] }];
    let pages;
    const run = handler('handleGradeFromToolbar', {
        panelStack: stack, activePanelIndex: 0, teacherMode: 'balanced',
        answerPanelRef: { current: { getCompositeImage: () => image, getAnswerState: () => null } },
        confirmAndGrade: async (_, value) => { pages = value; },
    });
    const pending = run();
    stack[0] = { type: 'answer', sourcePageNumbers: [9] };
    resolve('image');
    await pending;
    assert.deepEqual(pages, [5]);
});
