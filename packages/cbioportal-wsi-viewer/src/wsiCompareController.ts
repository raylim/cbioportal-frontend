import { action, computed, makeObservable, observable } from 'mobx';
import { WsiAnnotation } from './wsiViewerTypes';
import { WsiViewerState } from './wsiViewerState';
import { WsiAnnotationController } from './wsiAnnotationController';
import { WsiPoint } from './wsiAnnotationGeometryUtils';
import {
    fitAlignment,
    mapShape,
    shapeSelectorSvg,
    WsiAlignmentFit,
    WsiAlignmentPair,
    WsiTransformModel,
} from './wsiCompareTransform';
import {
    applyViewPose,
    followerPose,
    invertMapping,
    leftToRightMapping,
    readViewPose,
    WsiSyncMapping,
    WsiSyncMode,
} from './wsiCompareSync';
import {
    loadAlignment,
    saveAlignment,
    WsiStoredAlignment,
} from './wsiCompareStore';

export type WsiPaneSide = 'left' | 'right';

export function otherSide(side: WsiPaneSide): WsiPaneSide {
    return side === 'left' ? 'right' : 'left';
}

/** What the compare controller reads of each pane. */
export interface WsiComparePane {
    state: WsiViewerState;
    annotations: WsiAnnotationController;
}

/** What can be copied to the other slide. */
export type WsiTransferScope =
    | { kind: 'selected' }
    | { kind: 'layer'; layer: string };

interface BoundViewer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewer: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openSeadragon: any;
    cleanup: () => void;
}

/** OpenSeadragon events of a view change asked for (with its target). */
const VIEW_REQUEST_EVENTS = ['pan', 'zoom', 'rotate', 'flip'];

/** Divider limits: each pane keeps at least this share of the width. */
export const MIN_PANE_SHARE = 0.2;

/** An annotation that can be copied: saved, and of a shape the map moves. */
function transferable(annotation: WsiAnnotation): boolean {
    return !annotation.unsaved && !annotation.id.startsWith('client-');
}

/**
 * Side-by-side viewing of two of the patient's slides: which pane is active
 * (takes keys and tools), view sync (locked by default) through an
 * alignment of point pairs, an anchor or the relative position, the
 * alignment's points and fit (kept per slide pair in this browser), and
 * copying annotations to the other slide through the alignment.
 */
export class WsiCompareController {
    @observable open = false;
    /** Pan, zoom and rotation follow the other pane. */
    @observable locked = true;
    @observable activeSide: WsiPaneSide = 'left';
    /** The left pane's share of the width. */
    @observable split = 0.5;
    /** The Align and copy panel shows. */
    @observable panelOpen = false;
    /** Clicks on the slides place alignment points. */
    @observable placing = false;
    @observable.ref pairs: WsiAlignmentPair[] = [];
    @observable model: WsiTransformModel = 'similarity';
    @observable.ref anchor: { left: WsiPoint; right: WsiPoint } | null = null;
    @observable selectedPairId: string | null = null;
    /** What the last alignment or copy action did (a status line). */
    @observable message: string | null = null;
    @observable transferBusy = false;
    /** Bumped as each pane's view moves, for the point markers. */
    @observable leftRevision = 0;
    @observable rightRevision = 0;
    /** The slide pair the points belong to. */
    @observable.ref pairKeys: { left: string; right: string } | null = null;

    /** The pane whose view the other follows: the last one used. */
    leader: WsiPaneSide = 'left';
    private applying = false;
    /**
     * A pane opening a slide: its first view (home, or a link's) must not
     * lead, or picking a slide would move the other pane.
     */
    private readonly opening: Record<WsiPaneSide, boolean> = {
        left: false,
        right: false,
    };
    private baseline: WsiStoredAlignment | null = null;
    private nextPairNumber = 1;
    private readonly viewers: Record<WsiPaneSide, BoundViewer | null> = {
        left: null,
        right: null,
    };
    private revisionFrame: Record<WsiPaneSide, number | null> = {
        left: null,
        right: null,
    };

    constructor(
        private readonly pane: (side: WsiPaneSide) => WsiComparePane | null
    ) {
        makeObservable(this);
    }

    // ---- panes and activity ----

    @action.bound
    setOpen(open: boolean) {
        if (this.open === open) return;
        this.open = open;
        if (!open) {
            this.setPlacing(false);
            this.panelOpen = false;
            this.message = null;
            this.setActiveSide('left');
            this.detachViewer('right');
        } else {
            this.setActiveSide('left');
        }
    }

    /**
     * Makes `side` the active pane: its toolbar shows and it takes the
     * annotation keys and tools; the other pane's drawing stops.
     */
    @action.bound
    setActiveSide(side: WsiPaneSide) {
        this.activeSide = side;
        this.leader = side;
        this.pane('left')?.annotations.setPaneActive(side === 'left');
        this.pane('right')?.annotations.setPaneActive(
            side === 'right' || !this.open
        );
    }

    /** A press, wheel or key in `side`'s pane: its view leads. */
    noteInteraction(side: WsiPaneSide) {
        this.leader = side;
    }

    @action.bound
    setLocked(locked: boolean) {
        this.locked = locked;
        if (locked) this.syncFrom(this.activeSide, false);
    }

    @action.bound
    setSplit(split: number) {
        this.split = Math.min(
            1 - MIN_PANE_SHARE,
            Math.max(MIN_PANE_SHARE, split)
        );
    }

    // ---- view sync ----

    @computed get leftSlideKey(): string | null {
        return this.pane('left')?.state.selectedSlide?.slide_key || null;
    }

    @computed get rightSlideKey(): string | null {
        return this.open
            ? this.pane('right')?.state.selectedSlide?.slide_key || null
            : null;
    }

    /** The alignment of the complete point pairs, from 3 of them. */
    @computed get fit(): WsiAlignmentFit | null {
        return fitAlignment(
            this.pairs,
            this.model,
            this.pane('right')?.state.selectedMpp
        );
    }

    @computed get syncMode(): WsiSyncMode {
        return this.fit ? 'aligned' : this.anchor ? 'anchor' : 'relative';
    }

    /** The map the right view follows the left one by. */
    @computed get mapping(): WsiSyncMapping | null {
        const left = this.pane('left')?.state.selectedMeta;
        const right = this.pane('right')?.state.selectedMeta;
        if (!left || !right) return null;
        return leftToRightMapping(this.syncMode, {
            fit: this.fit,
            anchor: this.anchor,
            left: {
                ...left.dimensions,
                mpp: this.pane('left')?.state.selectedMpp,
            },
            right: {
                ...right.dimensions,
                mpp: this.pane('right')?.state.selectedMpp,
            },
        });
    }

    /** Moves the other pane's view to follow `side`'s. */
    syncFrom(side: WsiPaneSide, immediately: boolean): boolean {
        if (!this.open || !this.locked || this.applying) return false;
        const from = this.viewers[side];
        const to = this.viewers[otherSide(side)];
        const leftToRight = this.mapping;
        if (!from || !to || !leftToRight) return false;
        const mapping =
            side === 'left' ? leftToRight : invertMapping(leftToRight);
        const pose = readViewPose(from.viewer);
        if (!mapping || !pose) return false;
        this.applying = true;
        try {
            return applyViewPose(
                to.viewer,
                to.openSeadragon,
                followerPose(pose, mapping),
                immediately
            );
        } finally {
            this.applying = false;
        }
    }

    /**
     * Binds a pane's (re)opened viewer: its view requests lead the other
     * pane while it leads, and its moves redraw the point markers. A newly
     * opened slide follows the other pane.
     */
    attachViewer(
        side: WsiPaneSide,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        viewer: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        openSeadragon: any
    ) {
        const bound = this.viewers[side];
        if (!bound || bound.viewer !== viewer) {
            bound?.cleanup();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const onRequest = (event: any) => {
                if (
                    this.leader !== side ||
                    this.applying ||
                    this.opening[side]
                ) {
                    return;
                }
                this.syncFrom(side, !!event?.immediately);
            };
            const onUpdate = () => this.scheduleRevision(side);
            // A click (not a drag) places an alignment point while placing.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const onClick = (event: any) => {
                if (!this.open || !this.placing || !event?.quick) return;
                const position = event.position;
                const point =
                    position && this.imagePointAt(side, position.x, position.y);
                if (!point) return;
                event.preventDefaultAction = true;
                this.placePoint(side, point);
            };
            VIEW_REQUEST_EVENTS.forEach(name =>
                viewer.addHandler?.(name, onRequest)
            );
            viewer.addHandler?.('update-viewport', onUpdate);
            viewer.addHandler?.('canvas-click', onClick);
            this.viewers[side] = {
                viewer,
                openSeadragon,
                cleanup: () => {
                    VIEW_REQUEST_EVENTS.forEach(name =>
                        viewer.removeHandler?.(name, onRequest)
                    );
                    viewer.removeHandler?.('update-viewport', onUpdate);
                    viewer.removeHandler?.('canvas-click', onClick);
                },
            };
        } else {
            bound.openSeadragon = openSeadragon;
        }
        this.opening[side] = false;
        this.bumpRevision(side);
        this.syncFrom(otherSide(side), true);
    }

    /**
     * `side`'s pane starts opening another slide: until it is open, its
     * view follows and does not lead.
     */
    beginSlide(side: WsiPaneSide) {
        this.opening[side] = true;
    }

    detachViewer(side: WsiPaneSide) {
        this.opening[side] = false;
        this.viewers[side]?.cleanup();
        this.viewers[side] = null;
        const frame = this.revisionFrame[side];
        if (frame !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(frame);
        }
        this.revisionFrame[side] = null;
    }

    dispose() {
        this.detachViewer('left');
        this.detachViewer('right');
    }

    private scheduleRevision(side: WsiPaneSide) {
        // Markers show only with the panel; nothing to redraw otherwise.
        if (!this.panelOpen || this.revisionFrame[side] !== null) return;
        if (typeof requestAnimationFrame !== 'function') {
            this.bumpRevision(side);
            return;
        }
        this.revisionFrame[side] = requestAnimationFrame(() => {
            this.revisionFrame[side] = null;
            this.bumpRevision(side);
        });
    }

    @action
    private bumpRevision(side: WsiPaneSide) {
        if (side === 'left') this.leftRevision += 1;
        else this.rightRevision += 1;
    }

    /** Where image point `point` of `side`'s slide shows, in its pane. */
    screenPoint(side: WsiPaneSide, point: WsiPoint): WsiPoint | null {
        // Read for reactivity: markers move with the view.
        void (side === 'left' ? this.leftRevision : this.rightRevision);
        const bound = this.viewers[side];
        const viewport = bound?.viewer?.viewport;
        if (!viewport || !bound?.openSeadragon) return null;
        try {
            const pixel = viewport.pixelFromPoint(
                viewport.imageToViewportCoordinates(
                    new bound.openSeadragon.Point(point.x, point.y)
                ),
                true
            );
            return { x: pixel.x, y: pixel.y };
        } catch (_) {
            return null;
        }
    }

    /** The image point of `side`'s slide under pane pixel (`x`, `y`). */
    imagePointAt(side: WsiPaneSide, x: number, y: number): WsiPoint | null {
        const bound = this.viewers[side];
        const viewport = bound?.viewer?.viewport;
        if (!viewport || !bound?.openSeadragon) return null;
        try {
            const point = viewport.viewportToImageCoordinates(
                viewport.pointFromPixel(
                    new bound.openSeadragon.Point(x, y),
                    true
                )
            );
            return { x: point.x, y: point.y };
        } catch (_) {
            return null;
        }
    }

    /** The image point at the centre of `side`'s view. */
    viewCenter(side: WsiPaneSide): WsiPoint | null {
        return readViewPose(this.viewers[side]?.viewer, true)?.center || null;
    }

    // ---- the slide pair's alignment ----

    /**
     * Loads the stored alignment when the slide pair changes, and drops the
     * points of the previous pair.
     */
    @action.bound
    refreshPair() {
        const left = this.leftSlideKey;
        const right = this.rightSlideKey;
        if (
            this.pairKeys &&
            this.pairKeys.left === left &&
            this.pairKeys.right === right
        ) {
            return;
        }
        this.pairKeys = left && right ? { left, right } : null;
        const stored = left && right ? loadAlignment(left, right) : null;
        this.pairs = stored?.pairs || [];
        this.model = stored?.model || 'similarity';
        this.anchor = stored?.anchor || null;
        this.selectedPairId = null;
        this.message = null;
        this.baseline = this.snapshot();
        this.nextPairNumber =
            this.pairs.reduce(
                (max, pair) =>
                    Math.max(max, Number(pair.id.replace(/\D/g, '')) || 0),
                0
            ) + 1;
    }

    private snapshot(): WsiStoredAlignment {
        return { pairs: this.pairs, model: this.model, anchor: this.anchor };
    }

    private persist() {
        if (!this.pairKeys) return;
        saveAlignment(this.pairKeys.left, this.pairKeys.right, this.snapshot());
    }

    /** Re-syncs after the map changed, from the active pane. */
    private afterMapChange() {
        this.persist();
        this.syncFrom(this.activeSide, false);
    }

    /** The pair still waiting for its point on one side, if any. */
    @computed get openPair(): WsiAlignmentPair | null {
        return this.pairs.find(pair => !pair.left !== !pair.right) || null;
    }

    /** The side whose point is placed next. */
    @computed get pendingSide(): WsiPaneSide | null {
        const open = this.openPair;
        return open ? (open.left ? 'right' : 'left') : null;
    }

    /** The pair's number, as its markers show it. */
    pairNumber(id: string): number {
        return this.pairs.findIndex(pair => pair.id === id) + 1;
    }

    @action.bound
    setPanelOpen(open: boolean) {
        this.panelOpen = open;
        if (open) {
            this.baseline = this.snapshot();
            // With no alignment yet, clicks place points straight away.
            this.setPlacing(!this.fit);
            this.bumpRevision('left');
            this.bumpRevision('right');
        } else {
            this.setPlacing(false);
            this.selectedPairId = null;
        }
    }

    /**
     * Turns point placing on or off: on, clicks on either slide place
     * points (a drag still pans) and shapes ignore the pointer.
     */
    @action.bound
    setPlacing(placing: boolean) {
        this.placing = placing;
        (['left', 'right'] as WsiPaneSide[]).forEach(side =>
            this.pane(side)?.annotations.setPointerSuspended(
                placing && this.open
            )
        );
    }

    /**
     * A click at image point `point` of `side`: completes the pair waiting
     * for this side, or moves the waiting pair's point on this side, or
     * starts a new pair.
     */
    @action.bound
    placePoint(side: WsiPaneSide, point: WsiPoint) {
        const open = this.openPair;
        if (open) {
            this.pairs = this.pairs.map(pair =>
                pair.id === open.id ? { ...pair, [side]: point } : pair
            );
            this.selectedPairId = open.id;
        } else {
            const pair: WsiAlignmentPair = {
                id: `p${this.nextPairNumber++}`,
                left: side === 'left' ? point : null,
                right: side === 'right' ? point : null,
            };
            this.pairs = [...this.pairs, pair];
            this.selectedPairId = pair.id;
        }
        this.message = null;
        this.afterMapChange();
    }

    @action.bound
    movePoint(id: string, side: WsiPaneSide, point: WsiPoint) {
        this.pairs = this.pairs.map(pair =>
            pair.id === id ? { ...pair, [side]: point } : pair
        );
        this.selectedPairId = id;
        this.afterMapChange();
    }

    @action.bound
    deletePair(id: string) {
        this.pairs = this.pairs.filter(pair => pair.id !== id);
        if (this.selectedPairId === id) this.selectedPairId = null;
        this.afterMapChange();
    }

    @action.bound
    selectPair(id: string | null) {
        this.selectedPairId = id;
    }

    @action.bound
    setModel(model: WsiTransformModel) {
        this.model = model;
        this.afterMapChange();
    }

    /** Removes every point pair (Reset brings them back). */
    @action.bound
    clearPoints() {
        this.pairs = [];
        this.selectedPairId = null;
        this.message = 'Points cleared. Reset brings them back.';
        this.afterMapChange();
    }

    /** Puts the points, model and anchor back as they were when the panel opened. */
    @action.bound
    resetPoints() {
        const baseline = this.baseline;
        this.pairs = baseline?.pairs || [];
        this.model = baseline?.model || 'similarity';
        this.anchor = baseline?.anchor || null;
        this.selectedPairId = null;
        this.message = null;
        this.afterMapChange();
    }

    /**
     * Makes the two views' centres the same place, for sync without an
     * alignment: views then follow by distance from these points.
     */
    @action.bound
    setAnchorHere() {
        const left = this.viewCenter('left');
        const right = this.viewCenter('right');
        if (!left || !right) return;
        this.anchor = { left, right };
        this.message = this.fit
            ? 'Anchor set; the alignment is used while it has 3 or more points.'
            : 'Anchor set: the views now follow each other from these two centres.';
        this.persist();
    }

    @action.bound
    clearAnchor() {
        this.anchor = null;
        this.afterMapChange();
    }

    // ---- copying annotations ----

    /** The annotations `scope` names on the active pane's slide. */
    private transferSources(scope: WsiTransferScope): WsiAnnotation[] {
        const source = this.pane(this.activeSide)?.annotations;
        if (!source) return [];
        const annotations =
            scope.kind === 'selected'
                ? source.selectedAnnotations
                : source.annotationsByLayer.get(scope.layer) || [];
        return annotations.filter(
            annotation =>
                transferable(annotation) && !!source.shapeOf(annotation)
        );
    }

    /** What the active pane can copy: its selection and each layer. */
    @computed get transferChoices(): {
        selected: number;
        layers: Array<{ layer: string; count: number }>;
    } {
        const source = this.pane(this.activeSide)?.annotations;
        if (!source) return { selected: 0, layers: [] };
        return {
            selected: this.transferSources({ kind: 'selected' }).length,
            layers: Array.from(source.annotationsByLayer.keys())
                .map(layer => ({
                    layer,
                    count: this.transferSources({ kind: 'layer', layer })
                        .length,
                }))
                .filter(entry => entry.count > 0),
        };
    }

    /** Why copying is not possible now, or null. */
    @computed get transferUnavailable(): string | null {
        if (!this.fit) {
            return 'Place at least 3 point pairs to align the slides first.';
        }
        const target = this.pane(otherSide(this.activeSide))?.annotations;
        if (!target?.canEdit) {
            return (
                target?.accessMessage ||
                'The other slide cannot take annotations now.'
            );
        }
        return null;
    }

    /**
     * Copies the active pane's `scope` onto the other slide through the
     * alignment, as new annotations of the user's marked transferred and
     * unverified; one undo step there. The other pane becomes active, so
     * its Undo is at hand.
     */
    async transfer(scope: WsiTransferScope): Promise<number> {
        const fit = this.fit;
        const from = this.activeSide;
        const to = otherSide(from);
        const source = this.pane(from)?.annotations;
        const target = this.pane(to)?.annotations;
        const fromKey = source?.currentSlideKey;
        if (!fit || !source || !target || !fromKey || this.transferBusy) {
            return 0;
        }
        const transform = from === 'left' ? fit.transform : fit.inverse;
        const items = this.transferSources(scope).map(annotation => ({
            source: annotation,
            svg: shapeSelectorSvg(
                mapShape(source.shapeOf(annotation)!, transform)
            ),
        }));
        if (!items.length) {
            action(() => {
                this.message = 'Nothing to copy.';
            })();
            return 0;
        }
        action(() => {
            this.transferBusy = true;
            this.message = null;
        })();
        try {
            const { created, failed } = await target.addTransferred(items, {
                slideKey: fromKey,
                model: fit.model,
                residual: fit.rms,
                unit: fit.unit,
            });
            action(() => {
                const n = created.length;
                this.message = n
                    ? `Copied ${n} annotation${
                          n === 1 ? '' : 's'
                      } to the ${to} slide, marked "Transferred · unverified".${
                          failed ? ` ${failed} could not be saved.` : ''
                      }`
                    : `Nothing was copied: ${failed} could not be saved.`;
                if (n) this.setActiveSide(to);
            })();
            return created.length;
        } finally {
            action(() => {
                this.transferBusy = false;
            })();
        }
    }
}
