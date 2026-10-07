import { StudyToolbarNavigation, type BreadcrumbItem } from '@home-teacher/common/components/study/StudyToolbarNavigation'
import { StudyEraserTool, StudyTextTool, type TextDirection } from '@home-teacher/common/components/study/StudyToolSettings'
import { useStudyToolPopups } from '@home-teacher/common/hooks/useStudyToolPopups'
export type { BreadcrumbItem } from '@home-teacher/common/components/study/StudyToolbarNavigation'
export type { TextDirection } from '@home-teacher/common/components/study/StudyToolSettings'
import { useAppTranslation } from '../../i18n'
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FiCheckCircle, FiMessageCircle, FiLoader, FiEdit2 } from 'react-icons/fi';
import { BiSelection } from 'react-icons/bi';

interface StudyToolbarProps {
    onBack?: () => void;
    breadcrumbs?: BreadcrumbItem[];
    pageViewControlsEnabled: boolean;
    isSplitView: boolean;
    toggleSplitView: () => void;
    activeTab: 'A' | 'B';
    toggleActiveTab: () => void;

    // Grading
    isSelectionMode: boolean;
    isGrading: boolean;
    startGrading: () => void;
    cancelSelection: () => void;

    // Text Tool
    isTextMode: boolean;
    toggleTextMode: () => void;
    textFontSize: number;
    setTextFontSize: (size: number) => void;
    textDirection: TextDirection;
    setTextDirection: (dir: TextDirection) => void;

    // Pen Tool
    isDrawingMode: boolean;
    toggleDrawingMode: () => void;
    penColor: string;
    setPenColor: (color: string) => void;
    penSize: number;
    setPenSize: (size: number) => void;

    // Eraser Tool
    isEraserMode: boolean;
    toggleEraserMode: () => void;
    eraserSize: number;
    setEraserSize: (size: number) => void;

    // Answer panel actions (shown when on answer panel)
    onGrade?: () => void;
    submissionKind?: 'grade' | 'ask';
    selectedModel?: string;
    setSelectedModel?: (model: string) => void;
    availableModels?: Array<{ id: string; name: string; description?: string }>;
    defaultModelName?: string;
}

export const StudyToolbar: React.FC<StudyToolbarProps> = ({
    onBack,
    breadcrumbs,
    pageViewControlsEnabled,
    isSplitView,
    toggleSplitView,
    activeTab,
    toggleActiveTab,
    isSelectionMode,
    isGrading,
    startGrading,
    cancelSelection,
    isTextMode,
    toggleTextMode,
    textFontSize,
    setTextFontSize,
    textDirection,
    setTextDirection,
    isDrawingMode,
    toggleDrawingMode,
    penColor,
    setPenColor,
    penSize,
    setPenSize,
    isEraserMode,
    toggleEraserMode,
    eraserSize,
    setEraserSize,
    onGrade,
    submissionKind = 'grade',
    selectedModel,
    setSelectedModel,
    availableModels,
    defaultModelName,
}) => {
    const { t } = useTranslation();
    const { t: appT } = useAppTranslation()

    // Popups visibility state
    const [showPenGuidance, setShowPenGuidance] = useState(false);
    const penGuidanceTimerRef = useRef<number | undefined>();

    useEffect(() => {
        return () => window.clearTimeout(penGuidanceTimerRef.current);
    }, []);

    const {
        showTextPopup, showPenPopup, showEraserPopup,
        handleTextClick, handlePenClick, handleEraserClick,
    } = useStudyToolPopups({
        text: { active: isTextMode, toggle: toggleTextMode },
        pen: {
            active: isDrawingMode,
            toggle: () => {
                toggleDrawingMode();
                if (!onGrade) {
                    setShowPenGuidance(true);
                    window.clearTimeout(penGuidanceTimerRef.current);
                    penGuidanceTimerRef.current = window.setTimeout(() => {
                        setShowPenGuidance(false);
                    }, 6500);
                }
            },
        },
        eraser: { active: isEraserMode, toggle: toggleEraserMode },
    });

    return (
        <div className="toolbar">
            <StudyToolbarNavigation
                onBack={onBack}
                breadcrumbs={breadcrumbs}
                pageViewControlsEnabled={pageViewControlsEnabled}
                isSplitView={isSplitView}
                toggleSplitView={toggleSplitView}
                activeTab={activeTab}
                toggleActiveTab={toggleActiveTab}
                labels={{
                    home: appT('toolbar.home'),
                    switchPane: appT(isSplitView ? 'toolbar.single' : 'toolbar.switchPane'),
                    splitView: appT(isSplitView ? 'toolbar.swap' : 'toolbar.split'),
                    switchPaneAriaLabel: appT(isSplitView ? 'toolbar.single' : 'toolbar.switchPane'),
                    splitViewAriaLabel: appT(isSplitView ? 'toolbar.swap' : 'toolbar.splitLabel'),
                }}
            />

            {/* 右寄せコンテナ */}
            <div className="toolbar-tools">

                <>
                    <div className="divider"></div>

                    {/* 描画ツール */}
                    <div style={{ position: 'relative' }}>
                        <button
                            onClick={handlePenClick}
                            className={isDrawingMode ? 'active' : ''}
                            title={isDrawingMode ? appT('toolbar.penOn') : appT('toolbar.penOff')}
                        >
                            <FiEdit2 size={20} color={isDrawingMode ? penColor : 'currentColor'} />
                        </button>

                        {/* ペン設定ポップアップ */}
                        {isDrawingMode && showPenPopup && (
                            <div className="tool-popup">
                                <div className="popup-row">
                                    <label>{appT('toolbar.colorLabel')}</label>
                                    <input
                                        type="color"
                                        value={penColor}
                                        onChange={(e) => setPenColor(e.target.value)}
                                        className="color-swatch-input"
                                    />
                                </div>
                                <div className="popup-row">
                                    <label>{appT('toolbar.width')}</label>
                                    <input
                                        type="range"
                                        min="1"
                                        max="10"
                                        step="1"
                                        value={penSize}
                                        onChange={(e) => setPenSize(Number(e.target.value))}
                                        style={{ width: '100px' }}
                                    />
                                    <span>{penSize}px</span>
                                </div>
                            </div>
                        )}

                        {showPenGuidance && (
                            <div className="pen-guidance" role="status">
                                {t('pdfGuide.penHint')}
                            </div>
                        )}
                    </div>

                    <StudyEraserTool
                        active={isEraserMode}
                        popupVisible={showEraserPopup}
                        onClick={handleEraserClick}
                        title={appT(isEraserMode ? 'toolbar.eraserOn' : 'toolbar.eraserOff')}
                        size={eraserSize}
                        setSize={setEraserSize}
                        sizeLabel={appT('toolbar.size')}
                    />
                    <StudyTextTool
                        active={isTextMode}
                        popupVisible={showTextPopup}
                        onClick={handleTextClick}
                        title={appT(isTextMode ? 'toolbar.textOn' : 'toolbar.textOff')}
                        fontSize={textFontSize}
                        setFontSize={setTextFontSize}
                        direction={textDirection}
                        setDirection={setTextDirection}
                        color={penColor}
                        setColor={setPenColor}
                        labels={{
                            size: appT('toolbar.size'), direction: appT('toolbar.direction'),
                            horizontal: appT('toolbar.horizontal'),
                            verticalRight: appT('toolbar.verticalRight'), verticalLeft: appT('toolbar.verticalLeft'),
                            color: appT('toolbar.colorLabel'),
                        }}
                        colorInputClassName="color-swatch-input"
                    />

                    {/* Context-specific buttons */}
                    {onGrade ? (
                        /* Answer panel mode */
                        <>
                            <div className="divider"></div>
                            {setSelectedModel && availableModels && (
                                <select
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                >
                                    <option value="default">{defaultModelName}</option>
                                    {availableModels.map(m => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                    ))}
                                </select>
                            )}
                            <button
                                onClick={onGrade}
                                disabled={isGrading}
                                className="btn-submit"
                                title={submissionKind === 'ask' ? appT('toolbar.ask') : appT('toolbar.grade')}
                                aria-label={submissionKind === 'ask' ? appT('toolbar.ask') : appT('toolbar.grade')}
                                style={{
                                    cursor: isGrading ? 'wait' : 'pointer',
                                    opacity: isGrading ? 0.6 : 1,
                                    transition: 'all 0.15s',
                                }}
                            >
                                {isGrading ? <FiLoader size={20} className="animate-spin" /> : submissionKind === 'ask' ? <FiMessageCircle size={20} /> : <FiCheckCircle size={20} />}
                            </button>
                        </>
                    ) : (
                        /* PDF mode: range selection button */
                        <>
                            <div className="divider"></div>
                            <button
                                onClick={isSelectionMode ? cancelSelection : startGrading}
                                className={isSelectionMode ? 'active' : ''}
                                disabled={isGrading}
                                title={isSelectionMode ? t('gradingConfirmation.cancel') : t('pdfGuide.rangeSelection')}
                            >
                                {isGrading ? <FiLoader size={20} className="animate-spin" /> : <BiSelection size={20} className="icon-scale-13" />}
                            </button>
                        </>
                    )}
                </>
            </div>
        </div>
    );
};
