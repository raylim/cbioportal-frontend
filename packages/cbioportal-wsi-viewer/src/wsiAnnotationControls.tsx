import * as React from 'react';
import { observer } from 'mobx-react';
import {
    annotationVisibility,
    DEFAULT_COLOR,
    DEFAULT_LAYER,
    WsiAnnotationAiFilter,
    WsiAnnotationController,
    WsiAnnotationTool,
} from './wsiAnnotationController';
import { WsiAnnotation } from './wsiViewerTypes';
import { formatMeasurement } from './wsiAnnotationGeometryUtils';
import {
    isAssistantProvenance,
    isUnreviewedAssistant,
} from './wsiAnnotationBody';

const colors = {
    ai: '#7c3aed',
    blue: '#2986e2',
    border: '#ddd',
    muted: '#737373',
    text: '#333',
} as const;

const tools: Array<{
    name: Exclude<WsiAnnotationTool, null>;
    label: string;
    icon: string;
    hint: string;
}> = [
    {
        name: 'rectangle',
        label: 'Rect',
        icon: '◻',
        hint: 'Draw a rectangle — click and drag on the slide',
    },
    {
        name: 'ellipse',
        label: 'Ellipse',
        icon: '⬭',
        hint: 'Draw an ellipse — click and drag on the slide',
    },
    {
        name: 'circle',
        label: 'Circle',
        icon: '○',
        hint: 'Draw a circle — click and drag a box to fit it in',
    },
    {
        name: 'line',
        label: 'Line',
        icon: '╱',
        hint: 'Draw a line — click and drag on the slide',
    },
    {
        name: 'polygon',
        label: 'Poly',
        icon: '⬡',
        hint: 'Draw a polygon — click to add points, double-click to close',
    },
    {
        name: 'point',
        label: 'Point',
        icon: '•',
        hint:
            'Drop points — click on the slide for each one (drag to pan); Esc to stop',
    },
];

const toolbarStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    padding: '4px 10px 4px 44px',
    background: 'rgba(250,250,250,0.92)',
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 11,
    backdropFilter: 'blur(2px)',
    zIndex: 20,
};

export const WsiAnnotationToolbar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [showAddColor, setShowAddColor] = React.useState(false);
        const [newColorName, setNewColorName] = React.useState('');
        const [newColorHex, setNewColorHex] = React.useState('#ff0000');

        if (!controller || !controller.visible) return null;

        const saveColor = () => {
            controller.addNamedColor(
                newColorName.trim() || newColorHex,
                newColorHex
            );
            setNewColorName('');
            setShowAddColor(false);
        };

        if (!controller.canEdit) {
            // Signed out or read-only: no drawing tools, only the notice.
            return controller.accessMessage ? (
                <div data-testid="wsi-annotation-toolbar" style={toolbarStyle}>
                    <span
                        role="status"
                        data-testid="wsi-annotation-access-notice"
                        style={{ color: colors.muted }}
                    >
                        {controller.accessMessage}
                    </span>
                </div>
            ) : null;
        }

        return (
            <div data-testid="wsi-annotation-toolbar" style={toolbarStyle}>
                {tools.map(tool => {
                    const active = controller.activeTool === tool.name;
                    return (
                        <button
                            key={tool.name}
                            data-testid={`annotation-tool-${tool.name}`}
                            title={active ? 'Cancel drawing (Esc)' : tool.hint}
                            aria-pressed={active}
                            onClick={() =>
                                controller.setTool(active ? null : tool.name)
                            }
                            style={{
                                padding: '2px 9px',
                                fontSize: 11,
                                cursor: 'pointer',
                                borderRadius: 3,
                                lineHeight: '18px',
                                border: `1px solid ${
                                    active ? '#c0392b' : colors.border
                                }`,
                                background: active ? '#fde8e8' : '#fff',
                                color: active ? '#c0392b' : colors.muted,
                                fontWeight: active ? 600 : 400,
                            }}
                        >
                            {active
                                ? '✕ Cancel draw'
                                : `${tool.icon} ${tool.label}`}
                        </button>
                    );
                })}
                {controller.activeTool === 'point' && (
                    <span
                        role="status"
                        data-testid="annotation-point-count"
                        aria-live="polite"
                        style={{
                            fontSize: 11,
                            color: colors.text,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {controller.activePointLabel}:{' '}
                        {controller.activePointCount}
                    </span>
                )}
                <ToolbarDivider />
                <span
                    style={{
                        fontSize: 10,
                        color: colors.muted,
                        whiteSpace: 'nowrap',
                    }}
                >
                    Color:
                </span>
                {controller.namedColors.map(color => {
                    const active =
                        controller.activeColor === color.hex &&
                        controller.activeColorName === color.name;
                    return (
                        <span
                            key={`${color.name}|${color.hex}`}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 1,
                            }}
                        >
                            <button
                                data-testid={`annotation-color-${color.name ||
                                    color.hex}`}
                                title={`Color: ${color.name || color.hex}`}
                                aria-pressed={active}
                                onClick={() =>
                                    controller.setActiveNamedColor(
                                        color.name,
                                        color.hex
                                    )
                                }
                                style={{
                                    fontSize: 10,
                                    padding: '1px 7px',
                                    borderRadius: 10,
                                    cursor: 'pointer',
                                    background: active ? color.hex : '#fff',
                                    color: active ? '#fff' : color.hex,
                                    border: `1.5px solid ${color.hex}`,
                                    fontWeight: active ? 700 : 400,
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {color.name || color.hex}
                            </button>
                            {controller.canRemoveNamedColor(
                                color.name,
                                color.hex
                            ) && (
                                <button
                                    title={`Remove "${color.name ||
                                        color.hex}" from palette`}
                                    onClick={() =>
                                        controller.removeNamedColor(
                                            color.name,
                                            color.hex
                                        )
                                    }
                                    style={{
                                        fontSize: 8,
                                        padding: '0 2px',
                                        border: 'none',
                                        background: 'transparent',
                                        cursor: 'pointer',
                                        color: '#bbb',
                                        lineHeight: 1,
                                    }}
                                >
                                    ×
                                </button>
                            )}
                        </span>
                    );
                })}
                {!showAddColor ? (
                    <button
                        data-testid="add-annotation-color"
                        title="Add new named color to palette"
                        onClick={() => setShowAddColor(true)}
                        style={{
                            fontSize: 12,
                            padding: '0 5px',
                            border: `1px dashed ${colors.border}`,
                            background: '#fff',
                            color: colors.muted,
                            borderRadius: 10,
                            cursor: 'pointer',
                        }}
                    >
                        +
                    </button>
                ) : (
                    <span
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            padding: '1px 5px',
                            border: `1px solid ${colors.border}`,
                            borderRadius: 10,
                            background: '#fff',
                        }}
                    >
                        <input
                            aria-label="Custom annotation color"
                            type="color"
                            value={newColorHex}
                            onChange={event =>
                                setNewColorHex(event.target.value)
                            }
                            style={{
                                width: 20,
                                height: 16,
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                            }}
                        />
                        <input
                            aria-label="Custom annotation color name"
                            value={newColorName}
                            placeholder="Name (optional)"
                            maxLength={20}
                            autoFocus
                            onChange={event =>
                                setNewColorName(event.target.value)
                            }
                            onKeyDown={event => {
                                if (event.key === 'Enter') saveColor();
                                if (event.key === 'Escape')
                                    setShowAddColor(false);
                            }}
                            style={{
                                width: 90,
                                border: 'none',
                                outline: 'none',
                                fontSize: 10,
                            }}
                        />
                        <button
                            data-testid="save-annotation-color"
                            title="Add color to palette"
                            onClick={saveColor}
                            style={{
                                border: `1px solid ${colors.blue}`,
                                borderRadius: 8,
                                background: colors.blue,
                                color: '#fff',
                                fontSize: 10,
                            }}
                        >
                            Add
                        </button>
                        <button
                            title="Cancel"
                            onClick={() => setShowAddColor(false)}
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: colors.muted,
                            }}
                        >
                            ✕
                        </button>
                    </span>
                )}
                <ToolbarDivider />
                <button
                    data-testid="annotation-default-sharing"
                    aria-pressed={controller.defaultShared}
                    aria-label={
                        controller.defaultShared
                            ? 'New annotations are shared with the study; click to make new annotations private'
                            : 'New annotations are private; click to share new annotations with the study'
                    }
                    title={
                        controller.defaultShared
                            ? 'New annotations: shared with everyone who can see this study'
                            : 'New annotations: private (only you)'
                    }
                    onClick={() =>
                        controller.setDefaultShared(!controller.defaultShared)
                    }
                    style={{
                        padding: '2px 8px',
                        fontSize: 11,
                        cursor: 'pointer',
                        borderRadius: 3,
                        lineHeight: '18px',
                        border: `1px solid ${colors.border}`,
                        background: '#fff',
                        color: colors.muted,
                        whiteSpace: 'nowrap',
                    }}
                >
                    <i
                        aria-hidden="true"
                        className={`fa ${
                            controller.defaultShared ? 'fa-users' : 'fa-lock'
                        }`}
                    />{' '}
                    {controller.defaultShared ? 'Shared' : 'Private'}
                </button>
            </div>
        );
    }
);

function ToolbarDivider() {
    return (
        <span
            style={{
                width: 1,
                height: 16,
                background: colors.border,
                margin: '0 2px',
            }}
        />
    );
}

export const WsiAnnotationLayersPanel = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [showAddLayer, setShowAddLayer] = React.useState(false);
        const [newLayer, setNewLayer] = React.useState('');
        if (!controller || !controller.visible) return null;

        const reset = () => {
            setNewLayer('');
            setShowAddLayer(false);
        };
        const addLayer = () => {
            controller.addLayer(newLayer);
            reset();
        };

        return (
            <div data-testid="wsi-annotation-layers" style={{ marginTop: 6 }}>
                {controller.layerNames.map(layer => {
                    const hidden = controller.hiddenLayerNames.has(layer);
                    const active = controller.activeLayer === layer;
                    const count =
                        controller.annotationsByLayer.get(layer)?.length || 0;
                    return (
                        <div
                            key={layer}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '3px 0',
                            }}
                        >
                            <button
                                data-testid={`layer-toggle-${layer}`}
                                aria-label={`${
                                    hidden ? 'Show' : 'Hide'
                                } ${layer} layer`}
                                title={
                                    hidden
                                        ? `Show layer "${layer}"`
                                        : `Hide layer "${layer}"`
                                }
                                onClick={() =>
                                    controller.toggleLayerVisibility(layer)
                                }
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: hidden ? colors.muted : colors.blue,
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                    width: 18,
                                }}
                            >
                                <i
                                    className={`fa ${
                                        hidden ? 'fa-eye-slash' : 'fa-eye'
                                    }`}
                                />
                            </button>
                            <button
                                data-testid={`layer-select-${layer}`}
                                title={`Draw on layer "${layer}"`}
                                aria-pressed={active}
                                onClick={() => controller.setActiveLayer(layer)}
                                style={{
                                    flex: 1,
                                    textAlign: 'left',
                                    fontSize: 11,
                                    padding: '1px 6px',
                                    borderRadius: 3,
                                    cursor: 'pointer',
                                    border: `1.5px solid ${
                                        active ? colors.blue : colors.border
                                    }`,
                                    background: active
                                        ? colors.blue
                                        : 'transparent',
                                    color: active
                                        ? '#fff'
                                        : hidden
                                        ? colors.muted
                                        : colors.text,
                                    fontWeight: active ? 700 : 400,
                                    textDecoration: hidden
                                        ? 'line-through'
                                        : 'none',
                                    opacity: hidden ? 0.55 : 1,
                                }}
                            >
                                {layer}
                            </button>
                            <span
                                style={{
                                    minWidth: 14,
                                    textAlign: 'right',
                                    color: colors.muted,
                                    fontSize: 10,
                                }}
                            >
                                {count}
                            </span>
                            {layer !== DEFAULT_LAYER && controller.canEdit && (
                                <button
                                    data-testid={`delete-layer-${layer}`}
                                    title={`Delete layer "${layer}"`}
                                    onClick={() => {
                                        if (
                                            count > 0 &&
                                            !window.confirm(
                                                `Delete layer "${layer}" and ${count} associated annotation${
                                                    count === 1 ? '' : 's'
                                                }?`
                                            )
                                        ) {
                                            return;
                                        }
                                        void controller.deleteLayer(layer);
                                    }}
                                    style={{
                                        border: 'none',
                                        background: 'transparent',
                                        color: '#c0392b',
                                        cursor: 'pointer',
                                        padding: '0 2px',
                                    }}
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    );
                })}
                {!showAddLayer ? (
                    <button
                        data-testid="add-layer-btn"
                        title="Add new annotation layer"
                        onClick={() => setShowAddLayer(true)}
                        style={{
                            width: '100%',
                            marginTop: 4,
                            padding: '1px 8px',
                            border: `1px dashed ${colors.border}`,
                            borderRadius: 3,
                            background: 'transparent',
                            color: colors.muted,
                            fontSize: 11,
                        }}
                    >
                        + Add layer
                    </button>
                ) : (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 3,
                            marginTop: 4,
                        }}
                    >
                        <input
                            data-testid="add-layer-input"
                            value={newLayer}
                            placeholder="Layer name"
                            maxLength={30}
                            autoFocus
                            onChange={event => setNewLayer(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter') addLayer();
                                if (event.key === 'Escape') reset();
                            }}
                            style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 11,
                                padding: '1px 5px',
                            }}
                        />
                        <button
                            data-testid="add-layer-confirm"
                            onClick={addLayer}
                            style={{
                                border: `1px solid ${colors.blue}`,
                                borderRadius: 3,
                                background: colors.blue,
                                color: '#fff',
                                fontSize: 11,
                            }}
                        >
                            Add
                        </button>
                        <button
                            title="Cancel"
                            onClick={reset}
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: colors.muted,
                            }}
                        >
                            ✕
                        </button>
                    </div>
                )}
            </div>
        );
    }
);

export const WsiAnnotationPanel = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        if (!controller || !controller.visible) return null;
        if (controller.loading) {
            return (
                <span style={{ color: '#999', fontSize: 11 }}>Loading…</span>
            );
        }
        if (controller.error && !controller.annotations.length) {
            return (
                <span style={{ color: '#a00', fontSize: 11 }}>
                    {controller.error}
                </span>
            );
        }
        if (!controller.annotations.length) {
            return (
                <span style={{ color: '#999', fontSize: 11 }}>
                    {controller.canEdit
                        ? 'No annotations yet. Draw on the slide to create one.'
                        : 'No annotations.'}
                </span>
            );
        }
        const listed = controller.listedAnnotations;
        return (
            <div data-testid="wsi-annotation-panel" style={{ marginTop: 6 }}>
                {controller.error && (
                    <div
                        role="alert"
                        style={{ color: '#a00', fontSize: 11, marginBottom: 4 }}
                    >
                        {controller.error}
                    </div>
                )}
                {(controller.unreviewedAiCount > 0 ||
                    controller.hideUnreviewedAi) && (
                    <label
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            color: colors.muted,
                            marginBottom: 4,
                        }}
                    >
                        <input
                            type="checkbox"
                            data-testid="annotation-hide-unreviewed-ai"
                            checked={controller.hideUnreviewedAi}
                            onChange={controller.toggleHideUnreviewedAi}
                        />
                        Hide unreviewed AI annotations (
                        {controller.unreviewedAiCount})
                    </label>
                )}
                {!controller.mpp && (
                    <div
                        data-testid="annotation-measurement-scale-note"
                        style={{
                            color: colors.muted,
                            fontSize: 10,
                            marginBottom: 4,
                        }}
                    >
                        Sizes are in pixels: this slide has no microns-per-pixel
                        scale.
                    </div>
                )}
                <PointTally controller={controller} />
                <AnnotationListFilters controller={controller} />
                <AnnotationCounts controller={controller} />
                <div
                    role="list"
                    aria-label="Annotations"
                    data-testid="annotation-list"
                    style={{ maxHeight: 260, overflowY: 'auto' }}
                >
                    {listed.map(annotation => (
                        <AnnotationRow
                            key={annotation.id}
                            controller={controller}
                            annotation={annotation}
                        />
                    ))}
                    {!listed.length && (
                        <div
                            role="status"
                            style={{ color: '#999', fontSize: 11, padding: 4 }}
                        >
                            No annotations match the filters.
                        </div>
                    )}
                </div>
            </div>
        );
    }
);

const AnnotationRow = observer(
    ({
        controller,
        annotation,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
    }) => {
        const [editing, setEditing] = React.useState(false);
        const [label, setLabel] = React.useState(
            annotation.body?.[0]?.value || ''
        );
        const rawLabel = annotation.body?.[0]?.value || '';
        const layer = annotation.layerName || DEFAULT_LAYER;
        const dotColor = annotation.color || DEFAULT_COLOR;
        const creator = annotation.creator || '';
        const unreviewedAi = isUnreviewedAssistant(annotation.provenance);
        const measurement = controller.measurementOf(annotation);
        const created = annotation.created
            ? new Date(annotation.created).toLocaleDateString()
            : '';

        const save = () => {
            void controller.renameAnnotation(annotation.id, label);
            setEditing(false);
        };

        return (
            <div
                role="listitem"
                data-testid={`annotation-row-${annotation.id}`}
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 4,
                    padding: '4px 0',
                    borderBottom: `1px solid ${colors.border}`,
                }}
            >
                <span
                    aria-label="Annotation color"
                    data-annotation-color={dotColor}
                    data-annotation-layer={layer}
                    style={{
                        width: 8,
                        height: 8,
                        marginTop: 4,
                        borderRadius: '50%',
                        background: dotColor,
                        flexShrink: 0,
                    }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                    {editing ? (
                        <div style={{ display: 'flex', gap: 3 }}>
                            <input
                                data-testid={`annotation-label-input-${annotation.id}`}
                                autoFocus
                                value={label}
                                maxLength={200}
                                onChange={event => setLabel(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') save();
                                    if (event.key === 'Escape')
                                        setEditing(false);
                                }}
                                style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                            />
                            <button
                                title="Save annotation label"
                                onClick={save}
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: '#2a7a2a',
                                }}
                            >
                                ✓
                            </button>
                        </div>
                    ) : (
                        <>
                            <button
                                data-testid={`annotation-goto-${annotation.id}`}
                                aria-label={`Go to annotation ${rawLabel ||
                                    '(unlabeled)'}`}
                                title={`${rawLabel ||
                                    '(unlabeled)'}: show on the slide`}
                                onClick={() =>
                                    controller.zoomToAnnotation(annotation.id)
                                }
                                style={{
                                    display: 'block',
                                    maxWidth: '100%',
                                    padding: 0,
                                    border: 'none',
                                    background: 'transparent',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    color: colors.text,
                                    fontSize: 12,
                                    fontWeight: 500,
                                }}
                            >
                                {rawLabel || '(unlabeled)'}
                            </button>
                            <div
                                style={{
                                    display: 'flex',
                                    gap: 3,
                                    marginTop: 1,
                                    flexWrap: 'wrap',
                                }}
                            >
                                <AiBadge annotation={annotation} />
                                <VisibilityBadge
                                    controller={controller}
                                    annotation={annotation}
                                />
                                <AnnotationBadge label={layer} />
                                {annotation.colorName && (
                                    <AnnotationBadge
                                        label={annotation.colorName}
                                        background={dotColor}
                                        color="#fff"
                                    />
                                )}
                            </div>
                            {measurement && (
                                <div
                                    data-testid={`annotation-measurement-${annotation.id}`}
                                    style={{
                                        color: colors.text,
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    {formatMeasurement(measurement)}
                                </div>
                            )}
                            <AnnotationNote
                                controller={controller}
                                annotation={annotation}
                            />
                            {unreviewedAi && controller.canEdit && (
                                <div
                                    style={{
                                        display: 'flex',
                                        gap: 4,
                                        marginTop: 2,
                                    }}
                                >
                                    <button
                                        data-testid={`accept-annotation-${annotation.id}`}
                                        aria-label={`Accept AI annotation ${rawLabel}`}
                                        onClick={() =>
                                            void controller.acceptAnnotation(
                                                annotation.id
                                            )
                                        }
                                        style={reviewButtonStyle('#2a7a2a')}
                                    >
                                        ✓ Accept
                                    </button>
                                    <button
                                        data-testid={`reject-annotation-${annotation.id}`}
                                        aria-label={`Reject AI annotation ${rawLabel}`}
                                        title="Reject: deletes the annotation"
                                        onClick={() =>
                                            void controller.rejectAnnotation(
                                                annotation.id
                                            )
                                        }
                                        style={reviewButtonStyle('#c0392b')}
                                    >
                                        ✕ Reject
                                    </button>
                                </div>
                            )}
                            {(creator || created) && (
                                <div
                                    style={{
                                        color: colors.muted,
                                        fontSize: 10,
                                    }}
                                >
                                    {creator}
                                    {creator && created ? ' · ' : ''}
                                    {created}
                                </div>
                            )}
                        </>
                    )}
                </div>
                {!editing && controller.canEdit && (
                    <button
                        data-testid={`edit-label-${annotation.id}`}
                        title="Edit label"
                        onClick={() => {
                            setLabel(rawLabel);
                            setEditing(true);
                        }}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.muted,
                            padding: '0 2px',
                        }}
                    >
                        ✎
                    </button>
                )}
                {controller.canEdit && (
                    <button
                        data-testid={`delete-annotation-${annotation.id}`}
                        title="Delete annotation"
                        onClick={() =>
                            void controller.removeAnnotation(annotation.id)
                        }
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: '#c0392b',
                            padding: '0 2px',
                        }}
                    >
                        ✕
                    </button>
                )}
            </div>
        );
    }
);

const filterControlStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '1px 4px',
    minWidth: 0,
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    background: '#fff',
    color: colors.text,
};

/** Filters for the annotation list: label text, layer, author and AI. */
const AnnotationListFilters = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const filter = controller.listFilter;
        const anyAi = controller.annotations.some(annotation =>
            isAssistantProvenance(annotation.provenance)
        );
        const filtered =
            filter.text || filter.layer || filter.author || filter.ai !== 'all';
        return (
            <div
                data-testid="annotation-list-filters"
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    marginBottom: 4,
                }}
            >
                <input
                    type="search"
                    aria-label="Filter annotations by label or note"
                    data-testid="annotation-filter-text"
                    placeholder="Filter by label or note"
                    value={filter.text}
                    onChange={event =>
                        controller.setListFilter({ text: event.target.value })
                    }
                    style={{ ...filterControlStyle, flex: '1 1 100%' }}
                />
                <select
                    aria-label="Filter annotations by layer"
                    data-testid="annotation-filter-layer"
                    value={filter.layer}
                    onChange={event =>
                        controller.setListFilter({ layer: event.target.value })
                    }
                    style={{ ...filterControlStyle, flex: 1 }}
                >
                    <option value="">All layers</option>
                    {controller.layerNames.map(layer => (
                        <option key={layer} value={layer}>
                            {layer}
                        </option>
                    ))}
                </select>
                {controller.authors.length > 1 && (
                    <select
                        aria-label="Filter annotations by author"
                        data-testid="annotation-filter-author"
                        value={filter.author}
                        onChange={event =>
                            controller.setListFilter({
                                author: event.target.value,
                            })
                        }
                        style={{ ...filterControlStyle, flex: 1 }}
                    >
                        <option value="">All authors</option>
                        {controller.authors.map(author => (
                            <option key={author} value={author}>
                                {author}
                            </option>
                        ))}
                    </select>
                )}
                {anyAi && (
                    <select
                        aria-label="Filter annotations by AI origin"
                        data-testid="annotation-filter-ai"
                        value={filter.ai}
                        onChange={event =>
                            controller.setListFilter({
                                ai: event.target.value as WsiAnnotationAiFilter,
                            })
                        }
                        style={{ ...filterControlStyle, flex: 1 }}
                    >
                        <option value="all">AI and manual</option>
                        <option value="ai">AI only</option>
                        <option value="unreviewed">Unreviewed AI</option>
                        <option value="human">Manual only</option>
                    </select>
                )}
                {filtered && (
                    <button
                        data-testid="annotation-filter-clear"
                        onClick={controller.clearListFilter}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.blue,
                            fontSize: 10,
                            cursor: 'pointer',
                            padding: 0,
                        }}
                    >
                        Clear filters
                    </button>
                )}
            </div>
        );
    }
);

/**
 * How many listed annotations each layer and label has. A label chip
 * filters the list to that label.
 */
const AnnotationCounts = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const layers = Array.from(controller.listedLayerCounts.entries());
        const labels = Array.from(controller.listedLabelCounts.entries()).sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
        );
        if (!layers.length) return null;
        const row = (title: string, children: React.ReactNode) => (
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 10,
                    color: colors.muted,
                    marginBottom: 3,
                }}
            >
                <span>{title}</span>
                {children}
            </div>
        );
        return (
            <div data-testid="annotation-counts">
                {row(
                    'By layer:',
                    layers.map(([layer, count]) => (
                        <span
                            key={layer}
                            data-testid={`annotation-count-layer-${layer}`}
                            style={countChipStyle}
                        >
                            {layer} {count}
                        </span>
                    ))
                )}
                {row(
                    'By label:',
                    labels.map(([label, count]) => (
                        <button
                            key={label}
                            data-testid={`annotation-count-label-${label}`}
                            aria-label={`Show the ${count} ${label} annotation${
                                count === 1 ? '' : 's'
                            }`}
                            onClick={() =>
                                controller.setListFilter({ text: label })
                            }
                            style={{ ...countChipStyle, cursor: 'pointer' }}
                        >
                            {label} {count}
                        </button>
                    ))
                )}
            </div>
        );
    }
);

/** Point counts per layer and label, e.g. mitoses. */
const PointTally = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const rows = controller.pointTally;
        if (!rows.length) return null;
        return (
            <table
                data-testid="annotation-point-tally"
                style={{
                    width: '100%',
                    fontSize: 11,
                    borderCollapse: 'collapse',
                    marginBottom: 6,
                }}
            >
                <caption
                    style={{
                        textAlign: 'left',
                        fontSize: 10,
                        color: colors.muted,
                    }}
                >
                    Point counts
                </caption>
                <thead>
                    <tr style={{ color: colors.muted, fontSize: 10 }}>
                        <th style={{ textAlign: 'left', fontWeight: 400 }}>
                            Label
                        </th>
                        <th style={{ textAlign: 'left', fontWeight: 400 }}>
                            Layer
                        </th>
                        <th style={{ textAlign: 'right', fontWeight: 400 }}>
                            Count
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr
                            key={`${row.layer}|${row.label}`}
                            data-testid={`annotation-point-tally-${row.layer}-${row.label}`}
                        >
                            <td>
                                <span
                                    aria-hidden="true"
                                    style={{
                                        display: 'inline-block',
                                        width: 7,
                                        height: 7,
                                        borderRadius: '50%',
                                        background: row.color,
                                        marginRight: 4,
                                    }}
                                />
                                {row.label}
                            </td>
                            <td style={{ color: colors.muted }}>{row.layer}</td>
                            <td
                                style={{
                                    textAlign: 'right',
                                    fontWeight: 600,
                                }}
                            >
                                {row.count}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }
);

const countChipStyle: React.CSSProperties = {
    padding: '0 5px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: '#f7f7f7',
    color: colors.text,
    fontSize: 10,
    lineHeight: '14px',
};

export const MAX_NOTE_LENGTH = 2000;

/** An annotation's note, with an editor for users who can edit. */
const AnnotationNote = observer(
    ({
        controller,
        annotation,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
    }) => {
        const [editing, setEditing] = React.useState(false);
        const [draft, setDraft] = React.useState('');
        const note = annotation.note || '';
        const label = annotation.body?.[0]?.value || 'annotation';
        const save = () => {
            setEditing(false);
            void controller.setAnnotationNote(annotation.id, draft.trim());
        };
        if (editing) {
            return (
                <div style={{ marginTop: 2 }}>
                    <textarea
                        data-testid={`annotation-note-input-${annotation.id}`}
                        aria-label={`Note for ${label}`}
                        autoFocus
                        rows={3}
                        value={draft}
                        maxLength={MAX_NOTE_LENGTH}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => {
                            if (
                                event.key === 'Enter' &&
                                (event.ctrlKey || event.metaKey)
                            ) {
                                event.preventDefault();
                                save();
                            }
                            if (event.key === 'Escape') setEditing(false);
                        }}
                        style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            fontSize: 11,
                            resize: 'vertical',
                        }}
                    />
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button
                            data-testid={`annotation-note-save-${annotation.id}`}
                            onClick={save}
                            style={reviewButtonStyle('#2a7a2a')}
                        >
                            Save note
                        </button>
                        <button
                            onClick={() => setEditing(false)}
                            style={reviewButtonStyle(colors.muted)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <>
                {note && (
                    <div
                        data-testid={`annotation-note-${annotation.id}`}
                        style={{
                            color: colors.text,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            marginTop: 2,
                            fontStyle: 'italic',
                        }}
                    >
                        {note}
                    </div>
                )}
                {controller.canEdit && (
                    <button
                        data-testid={`annotation-note-edit-${annotation.id}`}
                        aria-label={`${
                            note ? 'Edit' : 'Add'
                        } note for ${label}`}
                        onClick={() => {
                            setDraft(note);
                            setEditing(true);
                        }}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.blue,
                            fontSize: 10,
                            padding: 0,
                            cursor: 'pointer',
                        }}
                    >
                        {note ? 'Edit note' : '+ Note'}
                    </button>
                )}
            </>
        );
    }
);

function reviewButtonStyle(color: string): React.CSSProperties {
    return {
        fontSize: 10,
        padding: '0 6px',
        borderRadius: 3,
        border: `1px solid ${color}`,
        background: '#fff',
        color,
        cursor: 'pointer',
        lineHeight: '16px',
    };
}

/** "AI" on an annotation the research assistant created. */
function AiBadge({ annotation }: { annotation: WsiAnnotation }) {
    if (!isAssistantProvenance(annotation.provenance)) return null;
    const unreviewed = isUnreviewedAssistant(annotation.provenance);
    const description = unreviewed
        ? 'Created by the research assistant; not reviewed yet'
        : 'Created by the research assistant; accepted';
    return (
        <span
            data-testid={`annotation-ai-badge-${annotation.id}`}
            aria-label={description}
            title={description}
            style={{
                padding: '0 4px',
                borderRadius: 2,
                border: `1px ${unreviewed ? 'dashed' : 'solid'} ${colors.ai}`,
                background: unreviewed ? '#fff' : colors.ai,
                color: unreviewed ? colors.ai : '#fff',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: '12px',
            }}
        >
            {unreviewed ? 'AI · unreviewed' : 'AI · accepted'}
        </span>
    );
}

/**
 * Whether an annotation is private or shared with the study; a button that
 * switches it for a user who can edit.
 */
const VisibilityBadge = observer(
    ({
        controller,
        annotation,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
    }) => {
        const visibility = annotationVisibility(annotation.visibleTo);
        if (!visibility) return null;
        const label = annotation.body?.[0]?.value || 'annotation';
        const text =
            visibility === 'private'
                ? 'Private'
                : visibility === 'shared'
                ? 'Shared'
                : 'Groups';
        const description =
            visibility === 'private'
                ? 'Private: only you can see it'
                : visibility === 'shared'
                ? 'Shared with everyone who can see this study'
                : 'Shared with groups';
        const style: React.CSSProperties = {
            padding: '0 4px',
            borderRadius: 2,
            border: `1px solid ${colors.border}`,
            background: visibility === 'private' ? '#fff7e6' : '#eef6ff',
            color: colors.muted,
            fontSize: 9,
            lineHeight: '12px',
        };
        const content = (
            <>
                <i
                    aria-hidden="true"
                    className={`fa ${
                        visibility === 'private' ? 'fa-lock' : 'fa-users'
                    }`}
                />{' '}
                {text}
            </>
        );
        if (!controller.canEdit) {
            return (
                <span
                    data-testid={`annotation-visibility-${annotation.id}`}
                    title={description}
                    style={style}
                >
                    {content}
                </span>
            );
        }
        const share = visibility === 'private';
        return (
            <button
                data-testid={`annotation-visibility-${annotation.id}`}
                aria-label={`${description}. ${
                    share ? 'Share' : 'Make private'
                }: ${label}`}
                title={`${description}. Click to ${
                    share ? 'share it with the study' : 'make it private'
                }.`}
                onClick={() =>
                    void controller.setAnnotationShared(annotation.id, share)
                }
                style={{ ...style, cursor: 'pointer' }}
            >
                {content}
            </button>
        );
    }
);

function AnnotationBadge({
    label,
    background = '#e8e8e8',
    color = '#555',
}: {
    label: string;
    background?: string;
    color?: string;
}) {
    return (
        <span
            style={{
                padding: '0 4px',
                borderRadius: 2,
                background,
                color,
                fontSize: 9,
                lineHeight: '14px',
            }}
        >
            {label}
        </span>
    );
}

export const WsiAnnotationTooltip = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const tooltip = controller.annotationTooltip;
        if (!tooltip) return null;
        return (
            <div
                data-testid="annotation-tooltip"
                onClick={controller.dismissAnnotationTooltip}
                style={{
                    position: 'fixed',
                    left: tooltip.x + 12,
                    top: tooltip.y - 8,
                    maxWidth: 260,
                    padding: '4px 10px',
                    borderRadius: 4,
                    background: 'rgba(30,30,30,0.9)',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 12,
                    pointerEvents: 'auto',
                    zIndex: 9999,
                }}
            >
                {tooltip.text}
                {tooltip.measurement && (
                    <div
                        data-testid="annotation-tooltip-measurement"
                        style={{ marginTop: 2, fontSize: 11 }}
                    >
                        {tooltip.measurement}
                    </div>
                )}
                {tooltip.note && (
                    <div
                        data-testid="annotation-tooltip-note"
                        style={{
                            marginTop: 2,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            fontStyle: 'italic',
                        }}
                    >
                        {tooltip.note}
                    </div>
                )}
                {tooltip.ai && (
                    <div style={{ marginTop: 2, fontSize: 10 }}>
                        {tooltip.ai === 'unreviewed'
                            ? 'AI · not reviewed yet'
                            : 'AI · accepted'}
                    </div>
                )}
                {tooltip.layerName && (
                    <div style={{ marginTop: 2, fontSize: 10, opacity: 0.7 }}>
                        Layer: {tooltip.layerName}
                    </div>
                )}
            </div>
        );
    }
);

export const WsiAnnotationDrawPreview = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const preview = controller.customDrawPreview;
        if (!preview) return null;

        const x1 = preview.start.x;
        const y1 = preview.start.y;
        const x2 = preview.current.x;
        const y2 = preview.current.y;
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rawRx = Math.abs(x2 - x1) / 2;
        const rawRy = Math.abs(y2 - y1) / 2;
        const radius = Math.min(rawRx, rawRy);
        const rx = preview.tool === 'circle' ? radius : rawRx;
        const ry = preview.tool === 'circle' ? radius : rawRy;
        const polygonPoints = preview.points
            ?.map(point => `${point.x},${point.y}`)
            .join(' ');
        const polygonPreviewPoints = [
            ...(polygonPoints ? [polygonPoints] : []),
            `${x2},${y2}`,
        ].join(' ');

        const measurement = controller.drawPreviewMeasurement;
        return (
            <svg
                data-testid="annotation-draw-preview"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 19,
                }}
            >
                {preview.tool === 'polygon' ? (
                    <polyline
                        points={polygonPreviewPoints}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.15}
                    />
                ) : preview.tool === 'rectangle' ? (
                    <rect
                        x={Math.min(x1, x2)}
                        y={Math.min(y1, y2)}
                        width={Math.abs(x2 - x1)}
                        height={Math.abs(y2 - y1)}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.2}
                    />
                ) : preview.tool === 'line' ? (
                    <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                    />
                ) : (
                    <ellipse
                        cx={cx}
                        cy={cy}
                        rx={rx}
                        ry={ry}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.2}
                    />
                )}
                {measurement && (
                    <text
                        data-testid="annotation-draw-measurement"
                        x={x2 + 12}
                        y={y2 - 10}
                        fontSize={12}
                        fontWeight={600}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={3}
                        paintOrder="stroke"
                    >
                        {measurement}
                    </text>
                )}
            </svg>
        );
    }
);
