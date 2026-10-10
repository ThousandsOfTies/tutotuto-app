const { studySelectionAdapters } = require('../../home-teacher-common/tests/helpers/studySelectionHarness.cjs');
const { answerWheelHarness, CanvasUndoHistory, drawStationaryStroke, resizeCanvasForDisplay, getCanvasLogicalSize } = require('../../home-teacher-common/tests/helpers/answerCanvasHarness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const toolModeExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../../home-teacher-common/src/hooks/useStudyToolMode.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: toolModeExports, require });
const { studyToolForPanel } = toolModeExports;

// Run the real component handlers with deterministic canvas/API/storage adapters.
const filename = path.join(__dirname, '../src/components/study/StudyPanel.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const answerFilename = path.join(__dirname, '../src/components/study/AnswerPanel.tsx');
const answerAst = ts.createSourceFile(answerFilename, fs.readFileSync(answerFilename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const drawingFilename = path.join(__dirname, '../../drawing-common/src/hooks/useDrawing.ts');
const drawingAst = ts.createSourceFile(drawingFilename, fs.readFileSync(drawingFilename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
    return vm.runInNewContext(code + '\nrun', {
        appMessages: require('../src/i18n/locales/ja.json'),
        setTool() {}, studyToolForPanel,
        traceUndo: { busy: false }, deletedStudyNodeIdsRef: { current: new Set() }, handledTracePointerRef: { current: false },
        drawStationaryStroke, resizeCanvasForDisplay, getCanvasLogicalSize,
        ...studySelectionAdapters(adapters), ...adapters,
    });
}
const toDrawingPath = handler('toDrawingPath', {}, answerAst);
const redrawAnswerStrokes = handler('redrawAnswerStrokes', { toDrawingPath }, answerAst);
const doSegmentsIntersect = handler('doSegmentsIntersect', {}, drawingAst);
const doPathsIntersect = handler('doPathsIntersect', { doSegmentsIntersect }, drawingAst);
const isScratchPattern = handler('isScratchPattern', {}, drawingAst);
const getGradingCaptureGeometry = handler('getGradingCaptureGeometry', {});
const panelWheelExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../../home-teacher-common/src/utils/panelWheelNavigation.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: panelWheelExports });
const { getPanelWheelDestination } = panelWheelExports;



test('writing-area wheel leaves text editors and consumed or drawing events alone', () => {
    const h = answerWheelHarness();
    for (const options of [{ target: h.control() }, { target: h.control(), ctrlKey: true },
        { defaultPrevented: true }, { buttons: 1 }, { deltaY: 0 }, { deltaY: NaN }]) {
        assert.deepEqual(h.send(options), { prevented: false, stopped: false });
        assert.equal(h.updates.length, 0);
    }
    assert.deepEqual(h.send({ deltaY: 3, deltaMode: 1 }), { prevented: true, stopped: true });
    assert.equal(h.viewportRef.current.panOffset.y, -48);
    h.send({ deltaY: 1, deltaMode: 2 });
    assert.equal(h.viewportRef.current.panOffset.y, -548);
});

test('rapid writing-area wheel events accumulate and keep the zoom focus stable', () => {
    const h = answerWheelHarness();
    h.send({ deltaY: 10 });
    h.send({ deltaY: 20 });
    assert.equal(h.viewportRef.current.panOffset.y, -30);
    const focus = () => {
        const { zoom, panOffset } = h.viewportRef.current;
        return [(200 - panOffset.x) / zoom, (200 - panOffset.y) / zoom];
    };
    const before = focus();
    h.send({ deltaY: -100, ctrlKey: true });
    h.send({ deltaY: -100, metaKey: true });
    assert.ok(Math.abs(h.viewportRef.current.zoom - 1.21) < 1e-10);
    focus().forEach((value, index) => assert.ok(Math.abs(value - before[index]) < 1e-10));
    for (let i = 0; i < 30; i++) h.send({ deltaY: -100, ctrlKey: true });
    assert.equal(h.viewportRef.current.zoom, 5);
    for (let i = 0; i < 50; i++) h.send({ deltaY: 100, ctrlKey: true });
    assert.equal(h.viewportRef.current.zoom, 0.2);
});

test('deleting an active answer flushes the latest strokes before cutting its route and keeps another PDF mark', async () => {
    const answer = { strokes: [{ points: [[10, 20], [30, 40]] }], texts: [{ text: '最後の解答' }] };
    let traces = [{ id: 'root' }, { id: 'other' }];
    let panels = [{ type: 'pdf' }, { type: 'answer', traceId: 'root' }, { type: 'grading', traceId: 'root' }];
    const writes = new Map(), deleted = new Set(), actions = [];
    await handler('deleteStudyTrace', {
        isGrading: false, activePanel: panels[1], activePanelIndex: 1, panelStack: panels,
        answerPanelRef: { current: { getAnswerState: () => answer } }, pendingAnswerWritesRef: { current: writes },
        deletedStudyNodeIdsRef: { current: deleted },
        saveStudyAnswer: (id, _nodeId, value) => {
            assert.equal(value, answer);
            writes.set(id, Promise.resolve().then(() => actions.push('saved')));
        },
        traceUndo: { busy: false, deleteTrace: async (target, beforeDelete) => {
            assert.equal(target.traceId, 'root');
            await beforeDelete();
            assert.deepEqual(actions, ['saved']);
            actions.push('deleted');
            return { marker: { id: 'root' }, removedNodeIds: ['root', 'child'] };
        } },
        setStudyTraces: update => { traces = update(traces); }, setPanelStack: update => { panels = update(panels); },
        navigateToPanel: index => { assert.equal(index, 0); actions.push('PDF'); }, addStatusMessage() {}, console,
    })('root');
    assert.deepEqual(traces, [{ id: 'other' }]);
    assert.equal(panels.length, 1);
    assert.deepEqual(actions, ['saved', 'deleted', 'PDF']);
    assert.equal(deleted.has('child'), true);
});

test('deleting a follow-up cuts only that branch from the breadcrumbs and undo restores the current stored marker', async () => {
    const marker = { id: 'root', followUps: [{ id: 'first' }, { id: 'next' }, { id: 'second' }] };
    let traces = [marker], panels = [
        { type: 'pdf' }, { type: 'answer', traceId: 'root' }, { type: 'grading', traceId: 'root' },
        { type: 'answer', traceId: 'root', nodeId: 'first' }, { type: 'grading', traceId: 'root', nodeId: 'first' },
    ];
    const snapshot = { marker, nodeId: 'first', removedNodeIds: ['first', 'next'] }, deleted = new Set();
    const common = {
        deletedStudyNodeIdsRef: { current: deleted },
        setStudyTraces: update => { traces = update(traces); }, addStatusMessage() {}, console,
    };
    await handler('deleteStudyTrace', { ...common,
        isGrading: false, activePanel: panels[2], activePanelIndex: 2, panelStack: panels,
        pendingAnswerWritesRef: { current: new Map() },
        traceUndo: { busy: false, deleteTrace: async (target, flush) => { assert.equal(target.nodeId, 'first'); await flush(); return snapshot; } },
        setPanelStack: update => { panels = update(panels); }, navigateToPanel() { assert.fail('parent must remain active'); },
    })('root', 'first');
    assert.equal(panels.length, 3);
    assert.deepEqual(traces[0].followUps.map(node => node.id), ['second']);
    assert.equal(deleted.has('root'), false);
    const latest = { ...marker, grading: { result: { overallComment: '保存済みの採点結果' } } };
    await handler('undoStudyTraceDeletion', { ...common,
        traceUndo: { undoDelete: async () => snapshot }, getPDFStudyMarker: async () => latest,
    })();
    assert.equal(traces[0], latest);
    assert.equal(deleted.size, 0);
});

test('a late answer callback cannot recreate a deleted root or follow-up', () => {
    for (const id of ['root', 'child']) {
        handler('saveStudyAnswer', {
            deletedStudyNodeIdsRef: { current: new Set([id]) },
            pendingAnswerWritesRef: { get current() { assert.fail('deleted answers must not queue a write'); } },
        })('root', 'child', { strokes: [], texts: [] });
    }
});

test('grading question markers stay anchored to scrolled result content', () => {
    const panel = { left: 10, top: 20 };
    const before = getGradingCaptureGeometry(
        { x: 50, y: 200, width: 100, height: 80 }, panel,
        { left: 30, top: 20, width: 600, height: 1200 },
    );
    const after = getGradingCaptureGeometry(
        { x: 50, y: 100, width: 100, height: 80 }, panel,
        { left: 30, top: -80, width: 600, height: 1200 },
    );
    assert.equal(before.region.x, after.region.x);
    assert.equal(before.region.y, after.region.y);
    assert.equal(after.region.width, 1 / 6);
    assert.equal(getGradingCaptureGeometry(
        { x: 0, y: 0, width: 5, height: 5 }, panel,
        { left: 30, top: 20, width: 600, height: 1200 },
    ), null);
});

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
test('Undo removes only the last stroke on the selected PDF page and saves that page', () => {
    for (const activeTab of ['A', 'B']) {
        const pageA = 4, pageB = 9;
        const original = new Map([[pageA, [{ id: 'a1' }, { id: 'a2' }]], [pageB, [{ id: 'b1' }, { id: 'b2' }]]]);
        let drawings = original;
        const writes = new Map();
        const undo = handler('handleUndo', {
            activeTab, pageA, pageB,
            setDrawingPaths: update => { drawings = update(drawings); },
            pendingDrawingWritesRef: { current: writes },
        });
        const selected = activeTab === 'A' ? pageA : pageB;
        const other = activeTab === 'A' ? pageB : pageA;
        undo();
        assert.deepEqual(drawings.get(selected), original.get(selected).slice(0, 1));
        assert.equal(drawings.get(other), original.get(other));
        assert.equal(original.get(selected).length, 2);
        assert.deepEqual(Array.from(writes), [[selected, JSON.stringify(original.get(selected).slice(0, 1))]]);
        undo();
        assert.deepEqual(Array.from(drawings.get(selected)), []);
        assert.deepEqual(Array.from(writes), [[selected, '[]']]);
        undo();
        assert.equal(drawings.get(other), original.get(other));
        assert.deepEqual(Array.from(writes), [[selected, '[]']]);
    }
});

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
    assert.deepEqual(JSON.parse(JSON.stringify(zoomed.captureLayout)), {
        width: 200, height: 100,
        regions: [
            { x: 0, y: 0, width: 100, height: 100 },
            { x: 100, y: 0, width: 100, height: 100 },
        ],
    });
    assert.equal((await capture()(rect(0, 40))).paperOrientation, 'landscape');
    assert.equal((await capture({ activeTab: 'B' })(rect(100, 40))).paperOrientation, 'portrait');
    assert.equal(await capture({ isSplitView: true })(rect(300, 100)), null);
});

test('recreates a cutout at its original size and pane positions', async () => {
    const canvases = [];
    const page = {
        getViewport: () => ({ width: 300, height: 200 }),
        render: () => ({ promise: Promise.resolve() }),
    };
    const run = handler('recreateQuestionImage', {
        pdfDoc: { getPage: async () => page },
        document: { createElement: () => {
            const canvas = { calls: [], toDataURL: () => 'recreated' };
            canvas.getContext = () => ({
                drawImage: (...args) => canvas.calls.push(args), fillRect() {},
            });
            canvases.push(canvas);
            return canvas;
        } },
    });
    const regions = [{ pageNumber: 1, x: 0.2, y: 0.1, width: 0.4, height: 0.5 }];
    const layout = { width: 400, height: 200, regions: [{ x: 100, y: 20, width: 250, height: 150 }] };
    assert.equal(await run(regions, layout), 'recreated');
    const result = canvases.at(-1);
    assert.deepEqual([result.width, result.height], [400, 200]);
    assert.deepEqual(result.calls[0].slice(1), [100, 20, 250, 150]);
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
        const bgCanvas = { style: {}, getContext: () => ({ setTransform() {},
            fillRect() {}, drawImage: (...args) => { imagePlacement = args; },
        }) };
        const drawCanvas = { style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) };
        const run = handler('initCanvas', {
            bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas },
            questionLayoutRef: { current: undefined },
            paperOrientation, initialAnswerState: undefined,
            SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
            MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
            MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
            historyRef: { current: new CanvasUndoHistory() }, textAnnotationsRef: { current: [] },
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
    const bgCanvas = { style: {}, getContext: () => ({ setTransform() {}, fillRect() {}, drawImage() {} }) };
    const drawCanvas = { style: {}, getContext: () => ({ setTransform() {},
        clearRect() {}, beginPath() {}, moveTo() {},
        lineTo: (...args) => drawn.push(args), stroke() {},
    }) };
    const strokesRef = { current: [] }, textAnnotationsRef = { current: [] };
    const questionLayoutRef = { current: undefined };
    const run = handler('initCanvas', {
        bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas },
        questionLayoutRef,
        paperOrientation: 'portrait', initialAnswerState: saved,
        SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
        MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
        MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
        historyRef: { current: new CanvasUndoHistory() }, strokesRef, activeStrokeRef: { current: null },
        textAnnotationsRef, editingTextRef: { current: null },
        setTextAnnotations() {}, setEditingText() {}, setCanUndo() {}, onCanUndoChange() {},
        console: { log() {} },
    }, answerAst);
    run({ naturalWidth: 300, naturalHeight: 400 });
    assert.equal(drawn.length, 1);
    assert.equal(strokesRef.current.length, 1);
    assert.equal(textAnnotationsRef.current[0].text, '解答');
    assert.deepEqual([bgCanvas.width, bgCanvas.height], [800, 1200]);
    assert.deepEqual(drawn[0], [150, 200]);
    assert.equal(questionLayoutRef.current.x, Math.round((800 - questionLayoutRef.current.width) / 2));
});

test('reopened answers retain their recorded paper and image placement', () => {
    const saved = {
        canvasWidth: 1392, canvasHeight: 984,
        questionLayout: { x: 369, y: 36, width: 654, height: 480 },
        strokes: [{ points: [[390, 100], [400, 110]], width: 6, color: '#f00', eraser: false }],
        texts: [],
    };
    let imagePlacement, strokeEndpoint;
    const bgCanvas = { style: {}, getContext: () => ({ setTransform() {}, fillRect() {}, drawImage: (...args) => { imagePlacement = args; } }) };
    const drawCanvas = { style: {}, getContext: () => ({ setTransform() {},
        clearRect() {}, beginPath() {}, moveTo() {},
        lineTo: (...args) => { strokeEndpoint = args; }, stroke() {},
    }) };
    const questionLayoutRef = { current: undefined };
    handler('initCanvas', {
        bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas }, questionLayoutRef,
        paperOrientation: 'landscape', initialAnswerState: saved,
        SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
        MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
        MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
        historyRef: { current: new CanvasUndoHistory() }, strokesRef: { current: [] }, activeStrokeRef: { current: null },
        textAnnotationsRef: { current: [] }, editingTextRef: { current: null },
        setTextAnnotations() {}, setEditingText() {}, setCanUndo() {}, onCanUndoChange() {},
        console: { log() {} },
    }, answerAst)({ naturalWidth: 600, naturalHeight: 430 });
    assert.deepEqual([bgCanvas.width, bgCanvas.height], [1392, 984]);
    assert.deepEqual(imagePlacement.slice(1), [369, 36, 654, 480]);
    assert.deepEqual(strokeEndpoint, [400, 110]);
    assert.deepEqual(JSON.parse(JSON.stringify(questionLayoutRef.current)), saved.questionLayout);
});

test('older answers use their paper size to recover the cutout scale', () => {
    const saved = { canvasWidth: 1392, canvasHeight: 984, strokes: [], texts: [] };
    let imagePlacement;
    const bgCanvas = { style: {}, getContext: () => ({ setTransform() {}, fillRect() {}, drawImage: (...args) => { imagePlacement = args; } }) };
    const drawCanvas = { style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) };
    handler('initCanvas', {
        bgCanvasRef: { current: bgCanvas }, drawCanvasRef: { current: drawCanvas },
        questionLayoutRef: { current: undefined }, paperOrientation: 'landscape', initialAnswerState: saved,
        SIDE_MARGIN: 48, TOP_MARGIN: 36, BOTTOM_MARGIN: 48,
        MIN_IMAGE_WIDTH: 600, MAX_IMAGE_WIDTH: 1400, MAX_IMAGE_HEIGHT: 900,
        MIN_WRITING_HEIGHT: 420, PAPER_ASPECT_RATIO: 297 / 210,
        historyRef: { current: new CanvasUndoHistory() }, strokesRef: { current: [] }, activeStrokeRef: { current: null },
        textAnnotationsRef: { current: [] }, editingTextRef: { current: null },
        setTextAnnotations() {}, setEditingText() {}, setCanUndo() {}, onCanUndoChange() {},
        console: { log() {} },
    }, answerAst)({ naturalWidth: 600, naturalHeight: 439 });
    assert.deepEqual([bgCanvas.width, bgCanvas.height], [1392, 984]);
    assert.equal(imagePlacement[4], 480);
    assert.equal(imagePlacement[1], Math.round((1392 - imagePlacement[3]) / 2));
});

test('saved answer state includes the question placement', () => {
    const layout = { x: 369, y: 36, width: 654, height: 480 };
    const state = handler('getAnswerState', {
        drawCanvasRef: { current: { width: 1392, height: 984 } },
        questionLayoutRef: { current: layout },
        strokesRef: { current: [] }, activeStrokeRef: { current: null },
        textAnnotationsRef: { current: [] },
    }, answerAst)();
    assert.equal(state.questionLayout, layout);
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
            toDrawingPath, isScratchPattern, doPathsIntersect, redrawAnswerStrokes,
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

test('a stationary answer tap is painted, saved and repainted when the answer is reopened', () => {
    const dots = [];
    let circle;
    const context = { beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {},
        save() {}, restore() {}, arc(x, y, radius) { circle = { x, y, radius }; },
        fill() { dots.push(circle); },
    };
    const canvas = { width: 800, height: 1200, getBoundingClientRect: () => ({ width: 800 }), getContext: () => context };
    const strokesRef = { current: [] }, activeStrokeRef = { current: null };
    const adapters = { drawCanvasRef: { current: canvas }, strokesRef, activeStrokeRef,
        isDrawingRef: { current: false }, lastPosRef: { current: null },
        saveSnapshot() {}, getPos: (x, y) => ({ x, y }), isEraserMode: false,
        penSize: 6, eraserSize: 20, penColor: '#123456', publishAnswerState() {},
        toDrawingPath, isScratchPattern, doPathsIntersect, redrawAnswerStrokes,
    };
    handler('startDraw', adapters, answerAst)(10, 20);
    handler('drawTo', adapters, answerAst)(10, 20);
    handler('stopDraw', adapters, answerAst)();
    assert.equal(strokesRef.current.length, 1);
    assert.equal(dots.length, 1);
    assert.deepEqual(Array.from(strokesRef.current[0].points, point => Array.from(point)), [[10, 20], [10, 20]]);
    redrawAnswerStrokes(canvas, strokesRef.current);
    assert.deepEqual(dots, [{ x: 10, y: 20, radius: 3 }, { x: 10, y: 20, radius: 3 }]);
});

test('pen scratch removes crossed answer strokes and persists the remaining drawing', () => {
    const touched = { points: [[5, 0], [5, 30]], width: 5, color: '#123456', eraser: false };
    const untouched = { points: [[100, 0], [100, 30]], width: 5, color: '#123456', eraser: false };
    const scratch = {
        points: Array.from({ length: 6 }, (_, row) =>
            (row % 2 ? [10, 8, 6, 4, 2, 0] : [0, 2, 4, 6, 8, 10])
                .map(x => [x, 10 + row])).flat(),
        width: 5, color: '#123456', eraser: false,
    };
    assert.equal(isScratchPattern(toDrawingPath(scratch)), true);
    let clears = 0, painted = 0;
    const context = {
        clearRect() { clears++; }, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() { painted++; },
    };
    const drawCanvasRef = { current: { width: 200, height: 100, getContext: () => context } };
    const strokesRef = { current: [touched, untouched] };
    const activeStrokeRef = { current: scratch };
    let saved;
    handler('stopDraw', {
        activeStrokeRef, strokesRef, drawCanvasRef,
        isDrawingRef: { current: true }, lastPosRef: { current: { x: 0, y: 0 } },
        toDrawingPath, isScratchPattern, doPathsIntersect, redrawAnswerStrokes,
        publishAnswerState: () => { saved = strokesRef.current; },
    }, answerAst)();
    assert.equal(clears, 1);
    assert.equal(painted, 1);
    assert.deepEqual(Array.from(saved), [untouched]);
    assert.equal(activeStrokeRef.current, null);
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
    run('first', 'first', first);
    run('first', 'first', second);
    run('second', 'second', { ...first, texts: [{ id: 'other', text: '別の解答' }] });
    await Promise.all([pending.get('first'), pending.get('second')]);
    assert.equal(markers.get('first').answer.strokes.length, 1);
    assert.equal(markers.get('first').answer.texts.length, 0);
    assert.equal(markers.get('second').answer.strokes.length, 0);
    assert.equal(markers.get('second').answer.texts[0].text, '別の解答');
    assert.equal(JSON.stringify(markers.get('first')).includes('data:image'), false);
});

test('saves a follow-up answer without replacing its parent answer', async () => {
    const parentAnswer = { canvasWidth: 800, canvasHeight: 1200, strokes: [], texts: [] };
    let marker = {
        id: 'root', pdfId: 'book', regions: [], sourcePageNumbers: [1], answer: parentAnswer,
        followUps: [{ id: 'child', parentId: 'root', region: { x: 0, y: 0, width: 1, height: 1 } }],
    };
    const pending = new Map();
    const run = handler('saveStudyAnswer', {
        pendingAnswerWritesRef: { current: pending },
        getPDFStudyMarker: async () => marker,
        savePDFStudyMarker: async value => { marker = value; },
        addStatusMessage() {}, console,
    });
    const childAnswer = { ...parentAnswer, strokes: [{ points: [[10, 20], [30, 40]], width: 3 }] };
    run('root', 'child', childAnswer);
    await pending.get('root');
    assert.equal(marker.answer, parentAnswer);
    assert.equal(marker.followUps[0].answer, childAnswer);
});

test('restores a single follow-up path and stops at the first branch', async () => {
    const grading = { result: { problems: [] }, modelName: null, responseTime: 1 };
    const trace = {
        id: 'root', sourcePageNumbers: [2],
        followUps: [
            { id: 'first', parentId: 'root', grading },
            { id: 'second', parentId: 'first', grading },
            { id: 'branch-a', parentId: 'second' },
            { id: 'branch-b', parentId: 'second' },
        ],
    };
    const panels = [
        { type: 'pdf' }, { type: 'answer', traceId: 'root', nodeId: 'root' },
        { type: 'grading', traceId: 'root', nodeId: 'root' },
    ];
    const run = handler('appendFollowUpPath', {
        loadFollowUpQuestionImage: async (_, id) => `image:${id}`,
    });
    await run(trace, panels, 'landscape');
    assert.deepEqual(panels.map(panel => panel.nodeId), [undefined, 'root', 'root', 'first', 'first', 'second', 'second']);
    assert.equal(panels.at(-1).type, 'grading');
    await run(trace, panels, 'landscape', 'branch-b');
    assert.equal(panels.at(-1).type, 'answer');
    assert.equal(panels.at(-1).questionImage, 'image:branch-b');
});

test('confirming a PDF range stores coordinates without storing the cropped image', async () => {
    const saved = [], panels = [];
    const run = handler('handleSelectionEnd', {
        isSelectingRef: { current: true }, selectionRect: { x: 0, y: 0, width: 100, height: 100 },
        captureSelectionArea: async () => ({
            image: 'data:image/png;base64,temporary', sourcePageNumbers: [2],
            regions: [{ pageNumber: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
            captureLayout: { width: 100, height: 100, regions: [{ x: 0, y: 0, width: 100, height: 100 }] },
        }),
        crypto: { randomUUID: () => 'range' }, pdfId: 'book',
        savePDFStudyMarker: async value => saved.push(value),
        setStudyTraces() {}, pushPanel: value => panels.push(value),
        setIsSelectionMode() {}, setSelectionRect() {}, addStatusMessage() {}, console,
    });
    await run();
    assert.equal(saved.length, 1);
    assert.deepEqual(Array.from(saved[0].regions, region => region.pageNumber), [2]);
    assert.equal(saved[0].captureLayout.width, 100);
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

test('a follow-up asks the tutor without grading or adding grading history', async () => {
    const rootGrading = { result: { problems: [{ problemNumber: 'root' }] }, modelName: null, responseTime: 1 };
    let marker = {
        id: 'root', pdfId: 'book', regions: [], sourcePageNumbers: [2], grading: rootGrading,
        followUps: [{ id: 'child', parentId: 'root', region: { x: 0, y: 0, width: 1, height: 1 } }],
    };
    const panels = [];
    const requests = [];
    const noop = () => {};
    const run = handler('confirmAndGrade', {
        setIsGrading: noop, setGradingError: noop, addStatusMessage: noop,
        panelStack: [
            { type: 'grading', result: rootGrading.result },
            { type: 'answer', source: 'grading', traceId: 'root', nodeId: 'child', paperOrientation: 'landscape' },
        ],
        activePanelIndex: 1, pendingAnswerWritesRef: { current: new Map() },
        getPDFStudyMarker: async () => marker,
        savePDFStudyMarker: async value => { marker = value; }, setStudyTraces: noop,
        compressImageDataUrl: async value => value,
        Image: class { width = 100; height = 100; set src(_) { queueMicrotask(() => this.onload()); } },
        selectedModel: 'default', i18n: { language: 'ja' },
        gradeWork: async () => { throw new Error('a question must not be graded'); },
        askQuestion: async (image, context) => {
            requests.push({ image, context });
            return { success: true, result: { pageType: 'follow-up-question', problems: [], overallComment: 'follow-up' } };
        },
        pushPanel: value => panels.push(value), pdfId: 'book',
        saveGradingImage: async () => { throw new Error('a question must not enter grading history'); },
        console,
    });
    await run('image', [2]);
    assert.equal(marker.grading, rootGrading);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].context, rootGrading.result);
    assert.equal(marker.followUps[0].grading.result.overallComment, 'follow-up');
    assert.equal(marker.followUps[0].grading.result.pageType, 'follow-up-question');
    assert.equal(panels[0].nodeId, 'child');
});

test('a graded PDF mark opens the saved answer sheet with its grading result in breadcrumbs', async () => {
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
        appendFollowUpPath: async () => {},
        setStudyTraces() {},
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

test('a PDF mark restores its route up to a fork while displaying the first answer sheet', async () => {
    const grading = { result: { problems: [] }, modelName: null, responseTime: 1 };
    for (const branches of [false, true]) {
        const trace = {
            id: 'root', pdfId: 'book', sourcePageNumbers: [2], regions: [{ pageNumber: 2 }], grading,
            followUps: [
                { id: 'first', parentId: 'root', grading },
                { id: 'second', parentId: 'first', grading },
                ...(branches ? [
                    { id: 'branch-a', parentId: 'second' },
                    { id: 'branch-b', parentId: 'second' },
                ] : [{ id: 'last-question', parentId: 'second' }]),
            ],
        };
        let panels, activeIndex;
        const loaded = [];
        const run = handler('openStudyTrace', {
            pdfId: 'book', pendingAnswerWritesRef: { current: new Map() },
            getPDFStudyMarker: async () => trace,
            getPDFPageOrientation: async () => 'landscape',
            recreateQuestionImage: async () => 'root-image',
            appendFollowUpPath: handler('appendFollowUpPath', {
                loadFollowUpQuestionImage: async (_, id) => { loaded.push(id); return `image:${id}`; },
            }),
            setStudyTraces() {}, setPanelStack: value => { panels = value; },
            setActivePanelIndex: value => { activeIndex = value; },
            setIsSelectionMode() {}, setIsGradingCaptureMode() {}, setSelectionRect() {},
            addStatusMessage: message => assert.fail(message), console,
        });
        await run('root');
        assert.equal(activeIndex, 1);
        assert.equal(panels[activeIndex].questionImage, 'root-image');
        assert.deepEqual(Array.from(panels, panel => panel.nodeId), [
            undefined, 'root', 'root', 'first', 'first', 'second', 'second',
            ...(branches ? [] : ['last-question']),
        ]);
        assert.deepEqual(loaded, branches ? ['first', 'second'] : ['first', 'second', 'last-question']);
    }
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
        setStudyTraces() {},
        setPanelStack: value => { panels = value; }, setActivePanelIndex() {},
        setIsSelectionMode() {}, setIsGradingCaptureMode() {}, setSelectionRect() {},
        addStatusMessage() {}, console,
    });
    await run('trace');
    assert.equal(panels[1].type, 'answer');
    assert.equal(panels[1].answerState, answer);
});

test('returning to PDF activates range selection instead of leaving no tool active', () => {
    const modeChanges = [];
    const activatePanelMode = handler('activatePanelMode', {
        useCallback: callback => callback,
        setTool: value => modeChanges.push(['tool', value]),
        setSelectionRect: value => modeChanges.push(['rect', value]),
        setIsHoveringStudyTrace: value => modeChanges.push(['hover', value]),
        setGradingCaptureRect() {}, isSelectingRef: { current: true }, selectionStartRef: { current: {} },
        gradingCaptureRectRef: { current: {} }, isGradingCapturingRef: { current: true },
    });
    const run = handler('navigateToPanel', {
        panelStack: [{ type: 'pdf' }, { type: 'answer' }, { type: 'grading' }], activatePanelMode,
        setActivePanelIndex: value => modeChanges.push(['panel', value]),
    });
    run(0);
    assert.deepEqual(Object.fromEntries(modeChanges), {
        tool: 'select-pdf', rect: null, hover: false, panel: 0,
    });
    modeChanges.length = 0;
    run(1);
    assert.deepEqual(Object.fromEntries(modeChanges), {
        tool: 'pen', rect: null, hover: false, panel: 1,
    });
    modeChanges.length = 0;
    run(2);
    assert.equal(Object.fromEntries(modeChanges).tool, 'select-result');
});

test('PDF horizontal navigation uses visible-page marks and never chooses between multiple ranges', () => {
    const root = { id: 'root', regions: [{ pageNumber: 1 }] };
    const other = { id: 'other', regions: [{ pageNumber: 2 }] };
    const panelStack = [{ type: 'pdf' }, { type: 'answer', traceId: 'root', nodeId: 'root' }];
    const base = { activePanel: panelStack[0], panelStack, activePanelIndex: 0,
        studyTraces: [root, other], pageA: 1, pageB: 2, isSplitView: false, activeTab: 'A', getPanelWheelDestination };
    const read = overrides => handler('getWheelDestination', { ...base, ...overrides })(1);
    assert.deepEqual(JSON.parse(JSON.stringify(read())), { type: 'panel', index: 1 });
    assert.equal(read({ studyTraces: [root, { id: 'second', regions: [{ pageNumber: 1 }] }] }), null);
    assert.equal(read({ isSplitView: true }), null);
    assert.deepEqual(JSON.parse(JSON.stringify(read({ activeTab: 'B' }))), { type: 'marker', id: 'other' });
    assert.equal(read({ pageA: 3 }), null);
});

test('grading forks block right even with a retained child panel and always allow going left', () => {
    const activePanel = { type: 'grading', traceId: 'root', nodeId: 'root' };
    const panelStack = [{ type: 'pdf' }, { type: 'answer' }, activePanel, { type: 'answer', nodeId: 'a' }];
    const root = { id: 'root', followUps: [
        { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'root' }, { id: 'later', parentId: 'a' },
    ] };
    const base = { activePanel, panelStack, activePanelIndex: 2, studyTraces: [root], getPanelWheelDestination };
    const read = handler('getWheelDestination', base);
    assert.equal(read(1), null);
    assert.deepEqual(JSON.parse(JSON.stringify(read(-1))), { type: 'panel', index: 1 });
    const single = handler('getWheelDestination', { ...base, studyTraces: [{ ...root, followUps: root.followUps.slice(0, 1) }] });
    assert.deepEqual(JSON.parse(JSON.stringify(single(1))), { type: 'panel', index: 3 });
});

test('horizontal movement opens only its chosen adjacent question and does nothing without a destination', async () => {
    const calls = [];
    let destination = null;
    const adapters = {
        getWheelDestination: () => destination, activePanel: { type: 'grading' },
        navigateToPanel: index => calls.push(['panel', index]),
        openStudyTrace: async id => calls.push(['pdf-mark', id]),
        openStudyFollowUp: async (...args) => calls.push(['question-mark', ...args]),
    };
    const run = handler('navigateWithWheel', adapters);
    await run(1); assert.deepEqual(calls, []);
    destination = { type: 'panel', index: 1 }; await run(-1);
    destination = { type: 'marker', id: 'child' }; await run(1);
    await handler('navigateWithWheel', { ...adapters, activePanel: { type: 'pdf' } })(1);
    assert.deepEqual(calls, [['panel', 1], ['question-mark', 'child', true], ['pdf-mark', 'child']]);
});

test('a sole follow-up opened by wheel restores its route but shows the first new question', async () => {
    const grading = { result: { problems: [] }, modelName: null, responseTime: 1 };
    const trace = { id: 'root', pdfId: 'book', sourcePageNumbers: [1], followUps: [
        { id: 'first', parentId: 'root', grading }, { id: 'last', parentId: 'first', grading },
    ] };
    const panelStack = [{ type: 'pdf' }, { type: 'answer' }, { type: 'grading', traceId: 'root', nodeId: 'root' }];
    let panels, activeIndex;
    const run = handler('openStudyFollowUp', {
        pdfId: 'book', panelStack, activePanelIndex: 2, pendingAnswerWritesRef: { current: new Map() },
        getPDFStudyMarker: async () => trace, setStudyTraces() {},
        appendFollowUpPath: handler('appendFollowUpPath', { loadFollowUpQuestionImage: async (_, id) => id }),
        setPanelStack: value => { panels = value; }, setActivePanelIndex: value => { activeIndex = value; },
        cancelGradingCapture() {}, setIsHoveringStudyTrace() {}, addStatusMessage: message => assert.fail(message), console,
    });
    await run('first', true);
    assert.equal(activeIndex, 3);
    assert.equal(panels[activeIndex].questionImage, 'first');
    assert.equal(panels.at(-1).nodeId, 'last');
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

test('answer selection leaves scrollbars and controls native while selecting within the text viewport', () => {
    class Element { constructor(control = false) { this.control = control; } closest() { return this.control ? this : null; } }
    const viewport = { clientLeft: 0, clientTop: 0, clientWidth: 385, clientHeight: 460,
        getBoundingClientRect: () => ({ left: 100, top: 80, width: 400, height: 460 }) };
    const panel = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 400, height: 500 }),
        querySelector: () => viewport };
    const capturing = { current: false }, start = { current: null }, selection = { current: null };
    const adapters = { Element, gradingPanelRef: { current: panel }, isGradingCapturingRef: capturing,
        gradingCaptureStartRef: start, gradingCaptureRectRef: selection, setGradingCaptureRect() {},
        getResultViewportBounds: handler('getResultViewportBounds', {}), getStudyTraceAtPoint: () => null };
    const begin = handler('handleGradingCaptureStart', adapters);
    let prevented = 0;
    const down = (clientX, clientY, target = new Element()) => begin({
        button: 0, clientX, clientY, target, preventDefault() { prevented++; },
    });
    for (const [x, y, target] of [[492, 200], [485, 200], [150, 555], [99, 180], [150, 180, new Element(true)]]) {
        down(x, y, target);
        assert.equal(capturing.current, false);
        assert.equal(selection.current, null);
        assert.equal(prevented, 0);
    }
    // An RTL scrollbar occupies the left edge and must also retain native dragging.
    viewport.clientLeft = 15;
    down(108, 180);
    assert.equal(capturing.current, false);
    assert.equal(prevented, 0);
    viewport.clientLeft = 0;
    down(150, 180);
    assert.equal(capturing.current, true);
    assert.equal(prevented, 1);
    assert.deepEqual({ ...start.current }, { x: 50, y: 100 });
    handler('handleGradingCaptureMove', adapters)({ clientX: 900, clientY: 900 });
    assert.deepEqual({ ...selection.current }, { x: 50, y: 100, width: 335, height: 360 });
});

test('scrolling discards an unfinished answer selection without creating a follow-up', async () => {
    const capturing = { current: true }, start = { current: { x: 20, y: 30 } };
    const selection = { current: { x: 20, y: 30, width: 100, height: 50 } };
    const changes = [];
    const adapters = { isGradingCapturingRef: capturing, gradingCaptureStartRef: start,
        gradingCaptureRectRef: selection, setGradingCaptureRect: value => changes.push(value) };
    const scroll = handler('handleGradingCaptureScroll', adapters);
    scroll();
    assert.equal(capturing.current, false);
    assert.equal(start.current, null);
    assert.equal(selection.current, null);
    assert.deepEqual(changes, [null]);
    await handler('handleGradingCaptureEnd', { ...adapters, panelStack: [{ type: 'grading' }], activePanelIndex: 0,
        gradingPanelRef: { current: {} }, pushPanel: () => assert.fail('Scrolling must not create a question') })();
    scroll();
    assert.deepEqual(changes, [null]);
});
