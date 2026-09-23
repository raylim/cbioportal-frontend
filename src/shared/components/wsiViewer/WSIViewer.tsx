import { WsiTimepointSelection } from 'shared/components/wsiViewer/wsiViewerTypes';
import * as React from 'react';
import { observer } from 'mobx-react';
import { observable, action, computed, makeObservable } from 'mobx';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import {
    DefaultTooltip,
    DownloadControlOption,
} from 'cbioportal-frontend-commons';
import { getServerConfig } from 'config/config';
import {
    PathologySlideFilter,
    PathologySlideMatchFilter,
    Slide,
    Sample,
    PatientHierarchy,
    TileMetadata,
    WsiStainFilter,
} from './wsiViewerTypes';
import {
    getServableSlideAssociationsByImageIdReadOnly,
    getOrderedServableSlidesForSampleReadOnly,
    getServableSlideIdsForPathologyFilterReadOnly,
    matchesWsiTimepointFilter,
    matchesWsiStainFilter,
    sampleHasServableSlide,
} from './wsiSlideUtils';
import {
    chooseInitialMatchingServableSlide,
    chooseInitialServableSlide,
} from './wsiInitialSlideUtils';
import { MetaRow, WsiMetaSidebar } from './wsiMetaSidebar';
import { buildPathRowsReadOnly, buildWsiRowsReadOnly } from './wsiMetaUtils';
import { readWsiHashState } from './wsiViewStateUtils';
import { BLOCK_LABEL_TIP, compareSamplesByTimepoint } from './wsiNavUtils';
import { WsiNavPanel } from './wsiNavPanel';
import {
    WsiInitialSlideLoadPerformance,
    WsiViewerController,
    WsiViewerControllerHost,
} from './wsiViewerController';
import { loadOpenSeadragon } from './wsiOpenSeadragonLoader';
import { clearPatientHierarchyCache } from './wsiHierarchyFetchCache';
import {
    clearAnnotationAccessToken,
    clearWsiSlideAccess,
    getAgentAccessToken,
    getAnnotationAccessToken,
    isWsiAuthEnabled,
} from './wsiAuth';
import { clearWsiThumbnailFetchCache } from './wsiThumbnailFetchCache';
import { clearSlideMetadataCache } from './wsiMetadataFetchCache';
import { WsiAnnotationController } from './wsiAnnotationController';
import {
    WsiAnnotationDrawPreview,
    WsiAnnotationLayersPanel,
    WsiAnnotationPanel,
    WsiAnnotationTooltip,
    WsiAnnotationToolbar,
} from './wsiAnnotationControls';
import {
    buildWsiAgentEmbeddingContext,
    buildWsiAgentSvgSelectorFromSlidePoints,
    WsiAgentContext,
    WsiAgentProposal,
} from './wsiAgent';
import { WsiAgentPanel } from './WsiAgentPanel';
import { WsiAgentProposalOverlay } from './WsiAgentProposalOverlay';

// ---- design tokens (matches iframe viewer) ----
const C = {
    blue: '#2986e2',
    blueDark: '#1a6cc4',
    blueLight: '#e8f1fb',
    orange: '#f5a623',
    text: '#333',
    muted: '#737373',
    border: '#ddd',
    navBg: '#fafafa',
    sidebarBg: '#f5f5f5',
} as const;

const NAV_W = 328;
const SIDEBAR_W = 320;
const SIDEBAR_MIN_W = 220;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_HANDLE_W = 8;
const SLIDE_SELECTION_DEBOUNCE_MS = 120;

function freezeMetaRows(rows: MetaRow[]): MetaRow[] {
    rows.forEach(row => Object.freeze(row));
    return Object.freeze(rows) as MetaRow[];
}

const sectionTitleStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: C.muted,
    textTransform: 'uppercase',
    letterSpacing: '.8px',
};

// ---- shared utility functions ----

interface Props {
    /** Tile-server base URL (never a patient-scoped or resource URL). */
    tileServerUrl: string;
    /** Backend-owned hierarchy endpoint for this patient. */
    hierarchyUrl: string;
    patientId: string;
    height: number;
    /** cBioPortal study ID — used to build sample links in the sidebar */
    studyId?: string;
    /** Long-form cBioPortal study name shown in the metadata sidebar */
    studyName?: string;
    initialStainFilter?: WsiStainFilter;
    initialMatchFilter?: PathologySlideMatchFilter;
    initialTimepointDays?: WsiTimepointSelection;
    onStainFilterChange?: (filter: WsiStainFilter) => void;
    onMatchFilterChange?: (filter: PathologySlideMatchFilter) => void;
    onTimepointChange?: (days?: WsiTimepointSelection) => void;
    onClearFilters?: () => void;
    preferredSampleId?: string;
    pathologyFilter?: PathologySlideFilter;
    /** Authenticated subject scope used to isolate protected in-memory caches. */
    authScope?: string;
    annotationApiUrl?: string | null;
    agentEnabled?: boolean;
}

interface CoordBarViewerState {
    coordBarInputX: string;
    coordBarInputY: string;
    coordBarCursorPos: { x: number; y: number } | null;
    coordBarMpp?: { x: number; y: number };
}

function getInitialMatchFilter(
    pathologyFilter?: PathologySlideFilter
): PathologySlideMatchFilter {
    const normalizedMatchLevel = pathologyFilter?.matchLevel?.toUpperCase();
    if (normalizedMatchLevel === 'PART') {
        return 'part';
    }
    if (normalizedMatchLevel === 'BLOCK') {
        return 'block';
    }
    if (normalizedMatchLevel === 'UNMATCHED') {
        return 'unmatched';
    }
    return 'all';
}

function getPathologyPreferredImageIds(
    hierarchy: PatientHierarchy | null | undefined,
    pathologyFilter?: PathologySlideFilter
): Set<string> | undefined {
    if (!hierarchy || !pathologyFilter) {
        return undefined;
    }

    return getServableSlideIdsForPathologyFilterReadOnly(
        hierarchy,
        pathologyFilter
    );
}

@observer
export default class WSIViewer extends React.Component<Props, {}> {
    @observable private hierarchy: PatientHierarchy | null = null;
    @observable private selectedSlide: Slide | null = null;
    @observable private selectedSample: Sample | null = null;
    @observable private selectedMeta: TileMetadata | null = null;
    @observable private loading = true;
    @observable private error: string | null = null;
    @observable private viewerReady = false;
    /** True once OSD has loaded the first tile; used to release deferred
     *  sidebar content after the initial viewer work settles. */
    @observable private tilesReady = false;
    /** Separate flag that controls spinner visibility; set true on slide select,
     *  set false after viewerReady AND at least MIN_SPINNER_MS have elapsed.
     *  Decoupled from viewerReady so viewport setup isn't delayed. */
    @observable private spinnerVisible = false;
    @observable private thumbnailPreviewUrl: string | null = null;
    @observable private stainFilter: WsiStainFilter = 'all';
    @observable private matchFilter: PathologySlideMatchFilter = 'all';
    @observable private timepointDays: WsiTimepointSelection | undefined;
    @observable private linkoutScopeActive = false;
    @observable private sidebarWidth = SIDEBAR_W;
    /** Coordinate bar — input field values */
    @observable coordInputX = '';
    @observable coordInputY = '';
    /** Current cursor position in image pixels (null when viewer not ready or cursor outside) */
    @observable cursorPos: { x: number; y: number } | null = null;

    private viewerContainerRef = React.createRef<HTMLDivElement>();
    /** Stable per-instance ID prefix for OSD custom nav button elements */
    private resizeStartX = 0;
    private resizeStartWidth = 0;
    private isResizingSidebar = false;
    private controller: WsiViewerController;
    private annotationController: WsiAnnotationController;
    @observable private agentProposals: WsiAgentProposal[] = [];
    // Keep the hierarchy object identity stable while viewer state changes.
    // The observable version invalidates derived row caches.
    @observable private hierarchyDataVersion = 0;
    private slideSelectionTimer: ReturnType<typeof setTimeout> | null = null;
    private cachedWsiRows:
        | {
              slide: Slide | null;
              meta: TileMetadata | null;
              version: number;
              rows: ReturnType<typeof buildWsiRowsReadOnly>;
          }
        | undefined;
    private cachedPathRows:
        | {
              slide: Slide | null;
              sample: Sample | null;
              patientId?: string;
              studyId?: string;
              studyName?: string;
              version: number;
              rows: ReturnType<typeof buildPathRowsReadOnly>;
          }
        | undefined;

    private get navId() {
        return this.controller.navId;
    }

    // ---- stable callbacks (prevent prop-equality churn on child components) ----
    private cancelPendingSlideSelection() {
        if (this.slideSelectionTimer !== null) {
            clearTimeout(this.slideSelectionTimer);
            this.slideSelectionTimer = null;
        }
    }

    private readonly releaseLinkoutScope = action(() => {
        if (!this.linkoutScopeActive) {
            return false;
        }
        this.linkoutScopeActive = false;
        return true;
    });

    private readonly handleFilterChange = action((f: WsiStainFilter) => {
        const releasedScope = this.releaseLinkoutScope();
        if (this.stainFilter === f && !releasedScope) {
            return;
        }
        this.cancelPendingSlideSelection();
        this.stainFilter = f;
        this.props.onStainFilterChange?.(f);
        void this.reselectSlideForCurrentFilters();
    });
    private readonly handleMatchFilterChange = action(
        (f: PathologySlideMatchFilter) => {
            const releasedScope = this.releaseLinkoutScope();
            if (this.matchFilter === f && !releasedScope) {
                return;
            }
            this.cancelPendingSlideSelection();
            this.matchFilter = f;
            this.props.onMatchFilterChange?.(f);
            void this.reselectSlideForCurrentFilters();
        }
    );
    private readonly handleTimepointChange = action(
        (days?: WsiTimepointSelection) => {
            const releasedScope = this.releaseLinkoutScope();
            if (this.timepointDays === days && !releasedScope) {
                return;
            }
            this.cancelPendingSlideSelection();
            this.timepointDays = days;
            this.props.onTimepointChange?.(days);
            void this.reselectSlideForCurrentFilters();
        }
    );
    private readonly handleClearFilters = action(() => {
        this.cancelPendingSlideSelection();
        this.linkoutScopeActive = false;
        this.stainFilter = 'all';
        this.matchFilter = 'all';
        this.timepointDays = undefined;
        this.props.onClearFilters?.();
        void this.reselectSlideForCurrentFilters();
    });
    private readonly handleSelectSlide = (slide: Slide, sample: Sample) => {
        this.controller.cancelSlideSelection();
        if (this.slideSelectionTimer !== null) {
            clearTimeout(this.slideSelectionTimer);
        }
        this.slideSelectionTimer = setTimeout(() => {
            this.slideSelectionTimer = null;
            void this.controller.selectSlide(slide, sample);
        }, SLIDE_SELECTION_DEBOUNCE_MS);
    };
    private readonly handleHashChange = () => {
        void this.selectSlideFromHash();
    };
    private readonly handleRetryViewer = () => {
        void this.controller.retrySelectedSlide();
    };
    private readonly handleChangeX = action((v: string) => {
        this.coordInputX = v;
    });
    private readonly handleChangeY = action((v: string) => {
        this.coordInputY = v;
    });
    private readonly handleCopyLink = () => this.copyViewLink();
    private readonly handleDownload = () => this.downloadView();
    private readonly handleGoToCoordinates = () => {
        this.goToCoordinates();
    };
    private readonly handleSidebarResizeMove = (event: MouseEvent) => {
        if (!this.isResizingSidebar) return;
        const nextWidth =
            this.resizeStartWidth + (this.resizeStartX - event.clientX);
        this.setSidebarWidth(nextWidth);
    };
    private readonly handleSidebarResizeEnd = () => {
        if (!this.isResizingSidebar) return;
        this.isResizingSidebar = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', this.handleSidebarResizeMove);
        window.removeEventListener('mouseup', this.handleSidebarResizeEnd);
    };

    constructor(props: Props) {
        super(props);
        makeObservable(this);
        if (props.initialStainFilter) {
            this.stainFilter = props.initialStainFilter;
        }
        this.timepointDays = props.initialTimepointDays;
        this.matchFilter =
            props.initialMatchFilter ||
            getInitialMatchFilter(props.pathologyFilter);
        this.linkoutScopeActive = !!props.pathologyFilter;
        this.annotationController = new WsiAnnotationController(
            props.annotationApiUrl,
            props.studyId,
            () =>
                isWsiAuthEnabled()
                    ? getAnnotationAccessToken(
                          this.props.studyId || '',
                          this.props.authScope ||
                              getServerConfig().user_display_name ||
                              'anonymousUser'
                      )
                    : Promise.resolve('')
        );
        this.controller = new WsiViewerController(
            this.createControllerHost(),
            loadOpenSeadragon
        );
    }

    @action.bound
    private setSidebarWidth(width: number) {
        const clamped = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, width));
        this.sidebarWidth = clamped;
        this.controller.forceResize();
    }

    private beginSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        this.isResizingSidebar = true;
        this.resizeStartX = event.clientX;
        this.resizeStartWidth = this.sidebarWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', this.handleSidebarResizeMove);
        window.addEventListener('mouseup', this.handleSidebarResizeEnd);
    };

    private createControllerHost(): WsiViewerControllerHost {
        return {
            getProps: () => this.controllerProps,
            resetHierarchyLoadState: () => this.resetHierarchyLoadState(),
            setHierarchy: hierarchy => {
                this.hierarchy = hierarchy;
            },
            setLoading: loading => {
                this.loading = loading;
            },
            setError: error => {
                this.error = error;
            },
            getHierarchy: () => this.hierarchy,
            getServableSlides: () => this.servableSlides,
            getStainFilter: () => this.stainFilter,
            getTileServerBase: () => this.tileServerBase,
            getTileServerOrigin: () => this.tileServerOrigin,
            getViewerContainerElement: () => this.viewerContainerRef.current,
            chooseInitialServableSlide: allSlides =>
                this.chooseInitialServableSlide(allSlides),
            beginSlideSelection: (slide, sample) =>
                this.beginSlideSelection(slide, sample),
            setSelectedMeta: meta => {
                this.selectedMeta = meta;
            },
            setViewerReady: viewerReady => {
                this.viewerReady = viewerReady;
            },
            setSpinnerVisible: spinnerVisible => {
                this.spinnerVisible = spinnerVisible;
            },
            setTilesReady: tilesReady => {
                this.tilesReady = tilesReady;
            },
            setThumbnailPreview: action(objectUrl => {
                this.thumbnailPreviewUrl = objectUrl;
            }),
            getSelectedSlide: () => this.selectedSlide,
            getSelectedSample: () => this.selectedSample,
            getSelectedMeta: () => this.selectedMeta,
            clearSelectedSlide: () => {
                this.selectedSlide = null;
                this.selectedSample = null;
                this.selectedMeta = null;
                this.viewerReady = false;
                this.spinnerVisible = false;
                this.tilesReady = false;
                this.thumbnailPreviewUrl = null;
            },
            getPatientId: () => this.hierarchy?.patient_id,
            setCoordInputs: (x, y) => this.setCoordInputs(x, y),
            getCoordInputs: () => ({
                x: this.coordInputX,
                y: this.coordInputY,
            }),
            updateCursorPos: (x, y) => this.handleCursorMove(x, y),
            clearCursorPos: () => this.clearCursorPos(),
            onSlideSelectionStarted: slide => {
                this.annotationController.beginSlide(slide.image_id);
            },
            onViewerOpened: (viewer, openSeadragon, slide) =>
                this.annotationController.attachViewer(
                    viewer,
                    openSeadragon,
                    slide.image_id
                ),
            onViewerDestroyed: () => this.annotationController.detachViewer(),
            reportInitialSlideLoadPerformance: metric =>
                this.reportInitialSlideLoadPerformance(metric),
        };
    }

    private reportInitialSlideLoadPerformance(
        metric: WsiInitialSlideLoadPerformance
    ) {
        const {
            slideId: _slideId,
            patientId: _patientId,
            studyId: _studyId,
            ...browserEventDetail
        } = metric;
        if (
            typeof window !== 'undefined' &&
            typeof window.dispatchEvent === 'function'
        ) {
            try {
                window.dispatchEvent(
                    new CustomEvent('wsi-initial-slide-performance', {
                        detail: browserEventDetail,
                    })
                );
            } catch (_) {
                // Ignore environments without CustomEvent support.
            }
        }
    }

    selectSlide(slide: Slide, sample: Sample): Promise<void> {
        return this.controller.selectSlide(slide, sample);
    }

    goToCoordinates() {
        this.controller.goToCoordinates();
    }

    downloadView() {
        this.controller.downloadView();
    }

    async copyViewLink() {
        return this.controller.copyViewLink();
    }

    componentDidMount() {
        window.addEventListener('hashchange', this.handleHashChange);
        void this.controller.loadHierarchy();
    }

    private async selectSlideFromHash(): Promise<void> {
        const hashState = readWsiHashState();
        if (!hashState || !this.hierarchy) return;

        const preferredImageIds = getPathologyPreferredImageIds(
            this.hierarchy,
            this.activePathologyFilter
        );
        const matching = this.servableSlides.find(
            entry =>
                entry.slide.image_id === hashState.slideId &&
                (!preferredImageIds ||
                    preferredImageIds.has(entry.slide.image_id)) &&
                this.matchesCurrentTimepoint(entry.slide)
        );
        if (!matching) return;

        if (this.selectedSlide?.image_id === matching.slide.image_id) {
            this.controller.restoreCurrentViewportFromHash();
            return;
        }

        await this.controller.selectSlide(
            matching.slide,
            matching.sample,
            true
        );
    }

    componentDidUpdate(prev: Props) {
        const authScopeChanged = prev.authScope !== this.props.authScope;
        const preferredSampleChanged =
            prev.preferredSampleId !== this.props.preferredSampleId;
        const pathologyFilterChanged =
            !!prev.pathologyFilter !== !!this.props.pathologyFilter ||
            prev.pathologyFilter?.sampleId !==
                this.props.pathologyFilter?.sampleId ||
            prev.pathologyFilter?.matchLevel !==
                this.props.pathologyFilter?.matchLevel ||
            prev.pathologyFilter?.specimenKey !==
                this.props.pathologyFilter?.specimenKey;
        const initialMatchFilterChanged =
            prev.initialMatchFilter !== this.props.initialMatchFilter;
        const requiresHierarchyReload =
            authScopeChanged ||
            prev.hierarchyUrl !== this.props.hierarchyUrl ||
            prev.tileServerUrl !== this.props.tileServerUrl ||
            prev.patientId !== this.props.patientId ||
            (pathologyFilterChanged && !this.canReusePathologyFilterLocally());
        const stainFilterChanged =
            prev.initialStainFilter !== this.props.initialStainFilter;
        const timepointFilterChanged =
            prev.initialTimepointDays !== this.props.initialTimepointDays;

        if (timepointFilterChanged) {
            this.timepointDays = this.props.initialTimepointDays;
        }

        if (authScopeChanged) {
            clearPatientHierarchyCache();
            clearWsiSlideAccess();
            clearAnnotationAccessToken(this.props.studyId);
            clearSlideMetadataCache();
            clearWsiThumbnailFetchCache();
        }

        if (pathologyFilterChanged) {
            this.linkoutScopeActive = !!this.props.pathologyFilter;
            this.matchFilter =
                this.props.initialMatchFilter ||
                getInitialMatchFilter(this.props.pathologyFilter);
            if (stainFilterChanged) {
                this.stainFilter = this.props.initialStainFilter || 'all';
            }
        } else if (initialMatchFilterChanged) {
            this.matchFilter =
                this.props.initialMatchFilter || this.matchFilter;
        } else if (stainFilterChanged) {
            this.stainFilter = this.props.initialStainFilter || 'all';
        }

        if (requiresHierarchyReload) {
            this.controller.dispose();
            void this.controller.loadHierarchy(false);
        } else if (pathologyFilterChanged) {
            this.applyPathologyFilterFromSourceHierarchy();
        } else if (
            initialMatchFilterChanged ||
            stainFilterChanged ||
            timepointFilterChanged
        ) {
            void this.reselectSlideForCurrentFilters();
        } else if (preferredSampleChanged) {
            void this.reselectPreferredSampleSlide();
        }
    }

    componentWillUnmount() {
        window.removeEventListener('hashchange', this.handleHashChange);
        this.cancelPendingSlideSelection();
        action(() => {
            this.hierarchy = null; // stops the prefetchSlideMetadata loop
        })();
        this.controller.dispose();
        this.annotationController.detachViewer();
        this.handleSidebarResizeEnd();
    }

    // ---- data loading ----

    @action.bound
    private resetHierarchyLoadState() {
        this.loading = true;
        this.error = null;
        this.hierarchy = null;
        this.selectedSlide = null;
        this.selectedSample = null;
        this.selectedMeta = null;
        this.viewerReady = false;
        this.tilesReady = false;
        this.spinnerVisible = false;
        this.thumbnailPreviewUrl = null;
        this.cursorPos = null;
        this.coordInputX = '';
        this.coordInputY = '';
    }

    private get controllerProps() {
        return {
            hierarchyUrl: this.props.hierarchyUrl,
            studyId: this.props.studyId,
            pathologyFilter: this.activePathologyFilter,
            authScope:
                this.props.authScope ||
                getServerConfig().user_display_name ||
                'anonymousUser',
        };
    }

    private get activePathologyFilter(): PathologySlideFilter | undefined {
        return this.linkoutScopeActive ? this.props.pathologyFilter : undefined;
    }

    private readonly getAgentToken = () =>
        isWsiAuthEnabled()
            ? getAgentAccessToken(
                  this.props.studyId || '',
                  this.controllerProps.authScope
              )
            : Promise.resolve('');

    private readonly getAgentContext = async (): Promise<WsiAgentContext | null> => {
        if (!this.selectedSlide || !this.selectedSample || !this.selectedMeta) {
            return null;
        }
        const width = this.selectedMeta.dimensions.width;
        const height = this.selectedMeta.dimensions.height;
        const slideId = this.selectedSlide.image_id;
        const studyId = this.props.studyId || '';
        const viewport = await this.controller.captureAgentViewportAfterDraw();
        if (!viewport) return null;
        return {
            study_id: studyId,
            patient_id: this.props.patientId,
            sample_id: this.selectedSample.sample_id,
            slide_id: slideId,
            stain_name: this.selectedSlide.stain_name,
            match_level: this.activePathologyFilter?.matchLevel,
            filters: {
                stain: this.stainFilter,
                match: this.matchFilter,
                timepoint_days: this.timepointDays,
            },
            slide_metadata: { ...this.selectedMeta },
            patient_context: {},
            existing_annotations: this.annotationController.annotations.map(
                annotation => ({
                    id: annotation.id,
                    label: annotation.body?.[0]?.value || '',
                    layer_name: annotation.layerName || 'Default',
                    color: annotation.color || '#3b82f6',
                    version: annotation.version || 1,
                })
            ),
            viewport: {
                ...viewport,
                slide_width: width,
                slide_height: height,
            },
            embedding_context: buildWsiAgentEmbeddingContext(
                studyId,
                this.servableSlides.map(entry => entry.slide.image_id)
            ),
        };
    };

    private agentProposalContextMatches(
        proposal: WsiAgentProposal,
        context: WsiAgentContext
    ): boolean {
        const proposalContext = proposal.payload.context as
            | Record<string, unknown>
            | undefined;
        const viewport = proposalContext?.viewport as
            | Record<string, unknown>
            | undefined;
        return (
            proposal.study_id === context.study_id &&
            proposal.slide_id === context.slide_id &&
            (!proposalContext ||
                (proposalContext.study_id === context.study_id &&
                    proposalContext.patient_id === context.patient_id &&
                    proposalContext.slide_id === context.slide_id &&
                    viewport?.source_fingerprint ===
                        context.viewport.source_fingerprint &&
                    viewport?.viewer_generation ===
                        context.viewport.viewer_generation))
        );
    }

    private slideMatchesAgentFilters(entry: { slide: Slide; sample: Sample }) {
        if (!this.hierarchy) return false;
        const preferredImageIds = getPathologyPreferredImageIds(
            this.hierarchy,
            this.activePathologyFilter
        );
        if (preferredImageIds && !preferredImageIds.has(entry.slide.image_id)) {
            return false;
        }
        if (!matchesWsiStainFilter(entry.slide, this.stainFilter)) {
            return false;
        }
        const associations = getServableSlideAssociationsByImageIdReadOnly(
            this.hierarchy.slide_associations
        );
        if (
            !matchesWsiTimepointFilter(
                entry.slide,
                associations.get(entry.slide.image_id),
                this.timepointDays
            )
        ) {
            return false;
        }
        return (
            this.matchFilter === 'all' ||
            associations.get(entry.slide.image_id)?.match_level ===
                this.matchFilter.toUpperCase()
        );
    }

    private async applyAgentViewerAction(
        proposal: WsiAgentProposal,
        context: WsiAgentContext
    ): Promise<{ success: boolean; detail: string }> {
        if (!this.agentProposalContextMatches(proposal, context)) {
            return {
                success: false,
                detail:
                    'The viewer changed; ask the assistant to regenerate the proposal.',
            };
        }
        const actionType = proposal.payload.action;
        const parameters = proposal.payload.parameters as
            | Record<string, unknown>
            | undefined;
        if (!parameters || typeof actionType !== 'string') {
            return { success: false, detail: 'The viewer action is invalid.' };
        }

        if (actionType === 'select_slide') {
            const slideId = parameters.slide_id;
            const entry = this.servableSlides.find(
                candidate => candidate.slide.image_id === slideId
            );
            if (!entry || !this.slideMatchesAgentFilters(entry)) {
                return {
                    success: false,
                    detail:
                        'That slide is not available under the current filters.',
                };
            }
            await this.controller.selectSlide(entry.slide, entry.sample);
            return this.selectedSlide?.image_id === slideId
                ? { success: true, detail: 'Slide selected.' }
                : {
                      success: false,
                      detail: 'The slide could not be selected.',
                  };
        }

        if (actionType === 'set_filters') {
            const allowedKeys = new Set([
                'stain_filter',
                'match_filter',
                'timepoint_days',
            ]);
            if (Object.keys(parameters).some(key => !allowedKeys.has(key))) {
                return {
                    success: false,
                    detail: 'The filter action is invalid.',
                };
            }
            const nextStain = parameters.stain_filter;
            const nextMatch = parameters.match_filter;
            const nextTimepoint = parameters.timepoint_days;
            if (
                nextStain !== undefined &&
                !['all', 'hne', 'ihc', 'other', 'unknown'].includes(
                    String(nextStain)
                )
            ) {
                return {
                    success: false,
                    detail: 'The stain filter is invalid.',
                };
            }
            if (
                nextMatch !== undefined &&
                !['all', 'part', 'block', 'unmatched'].includes(
                    String(nextMatch)
                )
            ) {
                return {
                    success: false,
                    detail: 'The match filter is invalid.',
                };
            }
            if (
                nextTimepoint !== undefined &&
                nextTimepoint !== null &&
                nextTimepoint !== 'undated' &&
                (typeof nextTimepoint !== 'number' ||
                    !Number.isFinite(nextTimepoint))
            ) {
                return {
                    success: false,
                    detail: 'The timepoint filter is invalid.',
                };
            }
            this.releaseLinkoutScope();
            action(() => {
                if (nextStain !== undefined) {
                    this.stainFilter = nextStain as WsiStainFilter;
                }
                if (nextMatch !== undefined) {
                    this.matchFilter = nextMatch as PathologySlideMatchFilter;
                }
                if (nextTimepoint !== undefined) {
                    this.timepointDays =
                        nextTimepoint === null
                            ? undefined
                            : (nextTimepoint as WsiTimepointSelection);
                }
            })();
            if (nextStain !== undefined) {
                this.props.onStainFilterChange?.(this.stainFilter);
            }
            if (nextMatch !== undefined) {
                this.props.onMatchFilterChange?.(this.matchFilter);
            }
            if (nextTimepoint !== undefined) {
                this.props.onTimepointChange?.(this.timepointDays);
            }
            await this.reselectSlideForCurrentFilters();
            return this.selectedSlide
                ? { success: true, detail: 'Filters applied.' }
                : {
                      success: false,
                      detail: 'No slide matches the requested filters.',
                  };
        }

        if (actionType === 'go_to_coordinates') {
            const x = parameters.x;
            const y = parameters.y;
            if (
                typeof x !== 'number' ||
                typeof y !== 'number' ||
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return {
                    success: false,
                    detail: 'The coordinates are invalid.',
                };
            }
            if (!this.controller.goToCoordinates(x, y)) {
                return { success: false, detail: 'The viewer is not ready.' };
            }
            await this.controller.captureAgentViewportAfterDraw();
            return { success: true, detail: 'Coordinates updated.' };
        }

        if (actionType === 'zoom') {
            const zoom = parameters.zoom;
            if (
                typeof zoom !== 'number' ||
                !Number.isFinite(zoom) ||
                zoom <= 0
            ) {
                return { success: false, detail: 'The zoom value is invalid.' };
            }
            if (!this.controller.setZoom(zoom)) {
                return { success: false, detail: 'The viewer is not ready.' };
            }
            await this.controller.captureAgentViewportAfterDraw();
            return { success: true, detail: 'Zoom updated.' };
        }

        return { success: false, detail: 'The viewer action is unsupported.' };
    }

    @action.bound
    private handleAgentProposal(proposal: WsiAgentProposal) {
        const existing = this.agentProposals.findIndex(
            item => item.id === proposal.id
        );
        this.agentProposals =
            existing < 0
                ? [...this.agentProposals, proposal]
                : this.agentProposals.map(item =>
                      item.id === proposal.id ? proposal : item
                  );
    }

    private readonly applyAgentProposal = async (
        proposal: WsiAgentProposal
    ): Promise<{ success: boolean; detail: string }> => {
        if (proposal.action_type === 'viewer_action') {
            const context = await this.getAgentContext();
            return context
                ? this.applyAgentViewerAction(proposal, context)
                : {
                      success: false,
                      detail: 'The viewer is not ready.',
                  };
        }
        if (
            proposal.action_type !== 'create_annotation' &&
            proposal.action_type !== 'annotation_batch'
        ) {
            return {
                success: false,
                detail:
                    'This proposal type is not supported by the native viewer yet.',
            };
        }
        const context = await this.getAgentContext();
        const drafts =
            proposal.action_type === 'annotation_batch' &&
            Array.isArray(proposal.payload.annotations)
                ? proposal.payload.annotations
                : [proposal.payload];
        if (
            !context ||
            context.slide_id !== proposal.slide_id ||
            !drafts.length
        ) {
            return {
                success: false,
                detail:
                    'The slide changed or the proposal geometry is invalid.',
            };
        }
        for (const draft of drafts) {
            const payload = draft as Record<string, unknown>;
            const points = Array.isArray(payload.points)
                ? (payload.points as Array<{ x: number; y: number }>)
                : [];
            if (points.length < 2) {
                return {
                    success: false,
                    detail: 'The proposal geometry is invalid.',
                };
            }
            const geometryType =
                payload.geometry_type === 'polygon' ? 'polygon' : 'rectangle';
            if (geometryType === 'polygon' && points.length < 3) {
                return {
                    success: false,
                    detail: 'A polygon needs at least three points.',
                };
            }
            if (
                points.some(
                    point =>
                        !point ||
                        !Number.isFinite(point.x) ||
                        !Number.isFinite(point.y)
                ) ||
                payload.geometry_version !== 2 ||
                payload.coordinate_space !== 'slide_pixels' ||
                points.some(
                    point =>
                        point.x < 0 ||
                        point.y < 0 ||
                        point.x > context.viewport.slide_width ||
                        point.y > context.viewport.slide_height
                ) ||
                payload.source_fingerprint !==
                    context.viewport.source_fingerprint ||
                payload.viewer_generation !== context.viewport.viewer_generation
            ) {
                return {
                    success: false,
                    detail:
                        'The annotation proposal is stale; ask the assistant to regenerate it.',
                };
            }
            const selector = buildWsiAgentSvgSelectorFromSlidePoints(
                geometryType,
                points
            );
            const success = await this.annotationController.createAgentAnnotation(
                {
                    label:
                        typeof payload.label === 'string'
                            ? payload.label
                            : 'AI review',
                    layerName:
                        typeof payload.layer_name === 'string'
                            ? payload.layer_name
                            : 'AI review',
                    color:
                        typeof payload.color === 'string'
                            ? payload.color
                            : '#f5a623',
                    selector,
                }
            );
            if (!success) {
                return { success: false, detail: 'Unable to save annotation.' };
            }
        }
        return { success: true, detail: 'Annotation saved.' };
    };

    private readonly adoptCommittedAgentAnnotations = (
        annotations: Array<Record<string, unknown>>
    ) => {
        this.annotationController.adoptAgentAnnotations(annotations);
    };

    private canReusePathologyFilterLocally(): boolean {
        return !!this.hierarchy?.slide_associations?.length;
    }

    private matchesCurrentTimepoint(slide: Slide): boolean {
        if (!this.hierarchy) {
            return this.timepointDays == null;
        }
        const association = getServableSlideAssociationsByImageIdReadOnly(
            this.hierarchy.slide_associations
        ).get(slide.image_id);
        return matchesWsiTimepointFilter(
            slide,
            association,
            this.timepointDays
        );
    }

    @action.bound
    private applyPathologyFilterFromSourceHierarchy() {
        if (!this.hierarchy) {
            return;
        }

        const nextHierarchy = this.hierarchy;

        this.hierarchy = nextHierarchy;
        this.hierarchyDataVersion++;

        const preferredImageIds = getPathologyPreferredImageIds(
            nextHierarchy,
            this.activePathologyFilter
        );
        if (preferredImageIds) {
            const currentImageId = this.selectedSlide?.image_id;
            const currentSampleId = this.selectedSample?.sample_id;
            const currentSample = nextHierarchy.samples.find(
                sample => sample.sample_id === currentSampleId
            );
            const firstMatchingSlide = currentSample
                ? getOrderedServableSlidesForSampleReadOnly(currentSample).find(
                      ({ slide }) =>
                          preferredImageIds.has(slide.image_id) &&
                          matchesWsiStainFilter(slide, this.stainFilter) &&
                          this.matchesCurrentTimepoint(slide)
                  )?.slide
                : undefined;
            if (
                currentImageId &&
                firstMatchingSlide?.image_id === currentImageId
            ) {
                this.selectedSlide = firstMatchingSlide;
                this.selectedSample = currentSample!;
                return;
            }
            void this.reselectSlideForPathologyFilter(preferredImageIds);
            return;
        }

        const currentImageId = this.selectedSlide?.image_id;
        const currentSampleId = this.selectedSample?.sample_id;
        if (!currentImageId || !currentSampleId) {
            void this.reselectSlideForCurrentFilters();
            return;
        }

        const matchingSample = nextHierarchy.samples.find(
            sample =>
                sample.sample_id === currentSampleId &&
                sampleHasServableSlide(sample, currentImageId)
        );
        const matchingSlide = matchingSample
            ? getOrderedServableSlidesForSampleReadOnly(matchingSample).find(
                  ({ slide }) =>
                      slide.image_id === currentImageId &&
                      this.matchesCurrentTimepoint(slide)
              )?.slide
            : undefined;

        if (matchingSample && matchingSlide) {
            this.selectedSlide = matchingSlide;
            this.selectedSample = matchingSample;
            return;
        }

        void this.reselectSlideForCurrentFilters();
    }

    private async reselectSlideForPathologyFilter(
        preferredImageIds: Set<string>
    ): Promise<void> {
        const servableSlides = this.servableSlides;
        if (!this.hierarchy || !servableSlides.length) {
            return;
        }

        const next = chooseInitialMatchingServableSlide(servableSlides, {
            preferredSampleId: this.props.preferredSampleId,
            stainFilter: this.stainFilter,
            matchesEntry: entry =>
                preferredImageIds.has(entry.slide.image_id) &&
                this.matchesCurrentTimepoint(entry.slide),
        });

        if (!next) {
            this.controller.clearSelectedSlide();
            return;
        }

        if (
            this.selectedSlide?.image_id === next.slide.image_id &&
            this.selectedSample?.sample_id === next.sample.sample_id
        ) {
            return;
        }

        await this.controller.selectSlide(next.slide, next.sample);
    }

    private chooseInitialServableSlide(
        allSlides: Array<{ slide: Slide; sample: Sample }>
    ) {
        const hashState = readWsiHashState();
        const preferredImageIds = getPathologyPreferredImageIds(
            this.hierarchy,
            this.activePathologyFilter
        );

        const timepointFilteredSlides = allSlides.filter(entry =>
            this.matchesCurrentTimepoint(entry.slide)
        );
        const preferredSlide = chooseInitialMatchingServableSlide(
            timepointFilteredSlides,
            {
                preferredSampleId: this.props.preferredSampleId,
                preferredSlideId: hashState?.slideId,
                stainFilter: this.stainFilter,
                matchesEntry: entry =>
                    !preferredImageIds ||
                    preferredImageIds.has(entry.slide.image_id),
            }
        );
        return preferredSlide;
    }

    @action.bound
    private handleCursorMove(x: number, y: number) {
        this.cursorPos = { x, y };
    }

    @action.bound
    private beginSlideSelection(slide: Slide, sample: Sample) {
        this.selectedSlide = slide;
        this.selectedSample = sample;
        this.selectedMeta = null;
        this.viewerReady = false;
        this.tilesReady = false;
        this.spinnerVisible = true;
        this.error = null;
    }

    @action.bound
    private clearCursorPos() {
        this.cursorPos = null;
    }

    private async reselectPreferredSampleSlide(): Promise<void> {
        if (!this.hierarchy || !this.servableSlides.length) {
            return;
        }

        const next = this.chooseInitialServableSlide(this.servableSlides);
        if (!next) {
            return;
        }

        if (
            this.selectedSlide?.image_id === next.slide.image_id &&
            this.selectedSample?.sample_id === next.sample.sample_id
        ) {
            return;
        }

        await this.controller.selectSlide(next.slide, next.sample);
    }

    private async reselectSlideForCurrentFilters(): Promise<void> {
        const servableSlides = this.servableSlides;
        if (!this.hierarchy || !servableSlides.length) {
            return;
        }

        const preferredImageIds = getPathologyPreferredImageIds(
            this.hierarchy,
            this.activePathologyFilter
        );
        const associationsByImageId = getServableSlideAssociationsByImageIdReadOnly(
            this.hierarchy.slide_associations
        );
        const matchingSlides = servableSlides.filter(({ slide }) => {
            if (preferredImageIds && !preferredImageIds.has(slide.image_id)) {
                return false;
            }
            if (!matchesWsiStainFilter(slide, this.stainFilter)) {
                return false;
            }
            if (
                !matchesWsiTimepointFilter(
                    slide,
                    associationsByImageId.get(slide.image_id),
                    this.timepointDays
                )
            ) {
                return false;
            }
            return (
                this.matchFilter === 'all' ||
                associationsByImageId.get(slide.image_id)?.match_level ===
                    this.matchFilter.toUpperCase()
            );
        });
        if (!matchingSlides.length) {
            this.controller.clearSelectedSlide();
            return;
        }

        const next = matchingSlides[0];
        await this.controller.selectSlide(next.slide, next.sample);
    }

    @action.bound
    private setCoordInputs(x: string, y: string) {
        this.coordInputX = x;
        this.coordInputY = y;
    }

    @computed get servableSlides(): Array<{ slide: Slide; sample: Sample }> {
        if (!this.hierarchy) return [];
        return [...this.hierarchy.samples]
            .sort(compareSamplesByTimepoint)
            .flatMap(sample =>
                getOrderedServableSlidesForSampleReadOnly(
                    sample
                ).map(({ slide }) => ({ slide, sample }))
            );
    }

    @computed get tileServerBase(): string {
        return this.props.tileServerUrl.replace(/\/$/, '');
    }

    @computed
    get coordBarInputX(): string {
        return this.coordInputX;
    }

    @computed
    get coordBarInputY(): string {
        return this.coordInputY;
    }

    @computed
    get coordBarCursorPos(): { x: number; y: number } | null {
        return this.cursorPos;
    }

    @computed
    get coordBarMpp(): { x: number; y: number } | undefined {
        return this.selectedMeta?.mpp;
    }

    @computed
    private get viewerPatientId(): string {
        return this.props.patientId;
    }

    private get selectedWsiRows() {
        if (
            this.cachedWsiRows &&
            this.cachedWsiRows.slide === this.selectedSlide &&
            this.cachedWsiRows.meta === this.selectedMeta &&
            this.cachedWsiRows.version === this.hierarchyDataVersion
        ) {
            return this.cachedWsiRows.rows;
        }

        const rows = this.selectedMeta
            ? buildWsiRowsReadOnly(this.selectedSlide, this.selectedMeta)
            : [];
        this.cachedWsiRows = {
            slide: this.selectedSlide,
            meta: this.selectedMeta,
            version: this.hierarchyDataVersion,
            rows: rows as MetaRow[],
        };
        return this.cachedWsiRows.rows;
    }

    private get selectedPathRows() {
        if (
            this.cachedPathRows &&
            this.cachedPathRows.slide === this.selectedSlide &&
            this.cachedPathRows.sample === this.selectedSample &&
            this.cachedPathRows.patientId === this.viewerPatientId &&
            this.cachedPathRows.studyId === this.props.studyId &&
            this.cachedPathRows.studyName === this.props.studyName &&
            this.cachedPathRows.version === this.hierarchyDataVersion
        ) {
            return this.cachedPathRows.rows;
        }

        const rows =
            this.selectedSlide && this.selectedSample
                ? buildPathRowsReadOnly(
                      this.selectedSlide,
                      this.selectedSample,
                      this.viewerPatientId,
                      this.props.studyId,
                      this.hierarchy
                          ? getServableSlideAssociationsByImageIdReadOnly(
                                this.hierarchy.slide_associations
                            ).get(this.selectedSlide.image_id)
                          : undefined,
                      this.props.studyName
                  )
                : [];
        this.cachedPathRows = {
            slide: this.selectedSlide,
            sample: this.selectedSample,
            patientId: this.viewerPatientId,
            studyId: this.props.studyId,
            studyName: this.props.studyName,
            version: this.hierarchyDataVersion,
            rows: rows as MetaRow[],
        };
        return this.cachedPathRows.rows;
    }

    @computed
    private get tileServerOrigin(): string {
        try {
            return new URL(this.tileServerBase, window.location.href).origin;
        } catch {
            return this.tileServerBase;
        }
    }

    // ---- render ----

    render() {
        const { height } = this.props;
        const {
            loading,
            error,
            hierarchy,
            selectedSlide,
            selectedSample,
            thumbnailPreviewUrl,
            stainFilter,
            matchFilter,
            timepointDays,
        } = this;
        const showClearFilters =
            !!this.activePathologyFilter ||
            !!this.props.preferredSampleId ||
            this.props.initialStainFilter === 'hne' ||
            this.props.initialStainFilter === 'ihc' ||
            this.props.initialTimepointDays != null ||
            stainFilter !== 'all' ||
            matchFilter !== 'all' ||
            timepointDays != null;

        if (loading) {
            return (
                <div
                    style={{
                        height,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <LoadingIndicator
                        isLoading={true}
                        center={true}
                        size="big"
                    />
                </div>
            );
        }

        if (!hierarchy) {
            return (
                <div
                    style={{
                        height,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#c00',
                    }}
                >
                    {error || 'No data'}
                </div>
            );
        }

        return (
            <div
                style={{
                    display: 'flex',
                    height,
                    overflow: 'hidden',
                    fontFamily: '"Helvetica Neue",Helvetica,Arial,sans-serif',
                    fontSize: 13,
                    color: C.text,
                }}
            >
                {/* Left nav panel */}
                <WsiNavPanel
                    hierarchy={hierarchy}
                    dataVersion={this.hierarchyDataVersion}
                    selectedSlide={selectedSlide}
                    slideIdFilter={getPathologyPreferredImageIds(
                        hierarchy,
                        this.activePathologyFilter
                    )}
                    linkoutScopeActive={this.linkoutScopeActive}
                    stainFilter={stainFilter}
                    matchFilter={matchFilter}
                    timepointDays={timepointDays}
                    showClearFilters={showClearFilters}
                    deferOffscreenSamples={!this.tilesReady}
                    onFilterChange={this.handleFilterChange}
                    onMatchFilterChange={this.handleMatchFilterChange}
                    onTimepointChange={this.handleTimepointChange}
                    onClearFilters={this.handleClearFilters}
                    onSelectSlide={this.handleSelectSlide}
                    tileServerBase={this.tileServerBase}
                    studyId={this.props.studyId}
                    authScope={this.controllerProps.authScope}
                    theme={C}
                    navWidth={NAV_W}
                    sectionTitleStyle={sectionTitleStyle}
                />

                {/* OSD viewer */}
                <div
                    style={{
                        flex: 1,
                        position: 'relative',
                        background: '#e8e8e8',
                    }}
                >
                    {this.props.annotationApiUrl && (
                        <WsiAnnotationToolbar
                            controller={this.annotationController}
                        />
                    )}
                    {selectedSlide && thumbnailPreviewUrl && (
                        <img
                            data-testid="wsi-thumbnail-preview"
                            src={thumbnailPreviewUrl}
                            alt=""
                            aria-hidden="true"
                            style={{
                                position: 'absolute',
                                inset: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                pointerEvents: 'none',
                                zIndex: 0,
                            }}
                        />
                    )}
                    <div
                        ref={this.viewerContainerRef}
                        style={{
                            width: '100%',
                            height: '100%',
                            position: 'relative',
                            zIndex: 1,
                            background: 'transparent',
                        }}
                    />
                    {/* Custom Bootstrap-styled OSD nav buttons — always in DOM so OSD can adopt them.
                        OSD wires zoom-in/zoom-out/home handlers onto these elements via the
                        zoomInButton/zoomOutButton/homeButton options in mountOSD. */}
                    <div
                        style={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            zIndex: 100,
                        }}
                    >
                        <button
                            id={`${this.navId}-zoom-in`}
                            className="btn btn-default btn-sm"
                            title="Zoom in"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-plus" />
                        </button>
                        <button
                            id={`${this.navId}-zoom-out`}
                            className="btn btn-default btn-sm"
                            title="Zoom out"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-minus" />
                        </button>
                        <button
                            id={`${this.navId}-home`}
                            className="btn btn-default btn-sm"
                            title="Fit to view"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-home" />
                        </button>
                    </div>
                    {this.spinnerVisible && selectedSlide && (
                        <div
                            data-testid="wsi-loading-spinner"
                            style={{
                                ...overlayStyle,
                                background: thumbnailPreviewUrl
                                    ? 'rgba(232,232,232,0.18)'
                                    : 'rgba(232,232,232,0.75)',
                            }}
                        >
                            {thumbnailPreviewUrl ? (
                                <div
                                    role="status"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        padding: '7px 10px',
                                        borderRadius: 3,
                                        color: C.text,
                                        background: 'rgba(255,255,255,0.9)',
                                        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                                        fontSize: 12,
                                    }}
                                >
                                    <i
                                        className="fa fa-spinner fa-spin"
                                        style={{ color: '#666' }}
                                    />
                                    <span>Loading full-resolution image…</span>
                                </div>
                            ) : (
                                <i
                                    className="fa fa-spinner fa-spin fa-3x"
                                    style={{ color: '#888' }}
                                />
                            )}
                        </div>
                    )}
                    {error && selectedSlide && (
                        <div
                            data-testid="wsi-viewer-error"
                            style={{
                                ...overlayStyle,
                                background: 'rgba(232,232,232,0.92)',
                                zIndex: 110,
                                pointerEvents: 'auto',
                                flexDirection: 'column',
                                gap: 12,
                                padding: 24,
                                textAlign: 'center',
                            }}
                        >
                            <span style={{ color: C.text }}>{error}</span>
                            <button
                                className="btn btn-primary btn-sm"
                                onClick={this.handleRetryViewer}
                            >
                                Retry
                            </button>
                        </div>
                    )}
                    {!selectedSlide && (
                        <div style={overlayStyle}>
                            <span style={{ color: C.muted, fontSize: 13 }}>
                                No viewable slides for this patient
                            </span>
                        </div>
                    )}
                    {this.tilesReady && (
                        <ObservedCoordBar
                            viewer={this}
                            onChangeX={this.handleChangeX}
                            onChangeY={this.handleChangeY}
                            onGo={this.handleGoToCoordinates}
                            onCopyLink={this.handleCopyLink}
                            onDownload={this.handleDownload}
                            showDownload={
                                getServerConfig()
                                    .skin_hide_download_controls ===
                                DownloadControlOption.SHOW_ALL
                            }
                        />
                    )}
                    {this.props.annotationApiUrl && (
                        <WsiAnnotationTooltip
                            controller={this.annotationController}
                        />
                    )}
                    {this.props.annotationApiUrl && (
                        <WsiAnnotationDrawPreview
                            controller={this.annotationController}
                        />
                    )}
                    {this.props.agentEnabled && (
                        <WsiAgentProposalOverlay
                            controller={this.annotationController}
                            proposals={this.agentProposals}
                        />
                    )}
                </div>

                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize metadata sidebar"
                    data-testid="wsi-metadata-resize-handle"
                    onMouseDown={this.beginSidebarResize}
                    style={{
                        width: SIDEBAR_HANDLE_W,
                        cursor: 'col-resize',
                        flexShrink: 0,
                        background: '#f0f0f0',
                        borderRight: `1px solid ${C.border}`,
                        position: 'relative',
                    }}
                >
                    <div
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: 2,
                            height: 36,
                            borderRadius: 2,
                            background: '#c3c3c3',
                            boxShadow: '4px 0 0 #c3c3c3, -4px 0 0 #c3c3c3',
                        }}
                    />
                </div>

                {/* Right metadata sidebar */}
                <WsiMetaSidebar
                    width={this.sidebarWidth}
                    showImageProperties={!!this.selectedMeta}
                    wsiRows={this.selectedWsiRows}
                    showPathology={!!(selectedSlide && selectedSample)}
                    pathRows={this.selectedPathRows}
                    annotationLayersPanel={
                        this.props.annotationApiUrl &&
                        this.annotationController.visible ? (
                            <WsiAnnotationLayersPanel
                                controller={this.annotationController}
                            />
                        ) : null
                    }
                    annotationPanel={
                        this.props.annotationApiUrl &&
                        this.annotationController.visible ? (
                            <WsiAnnotationPanel
                                controller={this.annotationController}
                            />
                        ) : null
                    }
                    annotationPanelTitle={
                        'Annotations (' +
                        this.annotationController.visibleAnnotationCount +
                        ')'
                    }
                    agentPanel={
                        this.props.agentEnabled ? (
                            <WsiAgentPanel
                                apiUrl={this.props.annotationApiUrl || ''}
                                getContext={this.getAgentContext}
                                getToken={this.getAgentToken}
                                applyProposal={this.applyAgentProposal}
                                onCommittedAnnotations={
                                    this.adoptCommittedAgentAnnotations
                                }
                                onProposal={this.handleAgentProposal}
                            />
                        ) : null
                    }
                />
            </div>
        );
    }
}

// ---- helpers ----

const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
};

// ---- CoordBar ----

interface CoordBarProps {
    inputX: string;
    inputY: string;
    cursorPos: { x: number; y: number } | null;
    mpp?: { x: number; y: number };
    onChangeX: (v: string) => void;
    onChangeY: (v: string) => void;
    onGo: () => void;
    onCopyLink: () => void;
    onDownload: () => void;
    showDownload: boolean;
}

const ObservedCoordBar = observer(function ObservedCoordBar({
    viewer,
    onChangeX,
    onChangeY,
    onGo,
    onCopyLink,
    onDownload,
    showDownload,
}: {
    viewer: CoordBarViewerState;
    onChangeX: (v: string) => void;
    onChangeY: (v: string) => void;
    onGo: () => void;
    onCopyLink: () => void;
    onDownload: () => void;
    showDownload: boolean;
}) {
    return (
        <CoordBar
            inputX={viewer.coordBarInputX}
            inputY={viewer.coordBarInputY}
            cursorPos={viewer.coordBarCursorPos}
            mpp={viewer.coordBarMpp}
            onChangeX={onChangeX}
            onChangeY={onChangeY}
            onGo={onGo}
            onCopyLink={onCopyLink}
            onDownload={onDownload}
            showDownload={showDownload}
        />
    );
});

function CoordBar({
    inputX,
    inputY,
    cursorPos,
    mpp,
    onChangeX,
    onChangeY,
    onGo,
    onCopyLink,
    onDownload,
    showDownload,
}: CoordBarProps) {
    const handleKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onGo();
    };
    const [copied, setCopied] = React.useState(false);

    const handleCopy = () => {
        onCopyLink();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    let cursorLabel = '';
    if (cursorPos) {
        cursorLabel = `${cursorPos.x.toLocaleString()} × ${cursorPos.y.toLocaleString()} px`;
        if (mpp) {
            const umX = (cursorPos.x * mpp.x).toFixed(1);
            const umY = (cursorPos.y * mpp.y).toFixed(1);
            cursorLabel += `  (${umX} × ${umY} μm)`;
        }
    }

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: 'rgba(250,250,250,0.92)',
                borderTop: `1px solid ${C.border}`,
                fontSize: 11,
                color: C.muted,
                backdropFilter: 'blur(2px)',
                zIndex: 10,
            }}
        >
            <span style={{ fontWeight: 600, color: C.text, marginRight: 2 }}>
                Go to:
            </span>
            <div
                className="input-group input-group-sm"
                style={{
                    width: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                }}
            >
                <span style={{ color: C.muted }}>X</span>
                <input
                    type="number"
                    value={inputX}
                    placeholder="px"
                    className="form-control input-sm"
                    style={{ width: 88 }}
                    onChange={e => onChangeX(e.target.value)}
                    onKeyDown={handleKey}
                />
                <span style={{ color: C.muted }}>Y</span>
                <input
                    type="number"
                    value={inputY}
                    placeholder="px"
                    className="form-control input-sm"
                    style={{ width: 88 }}
                    onChange={e => onChangeY(e.target.value)}
                    onKeyDown={handleKey}
                />
            </div>
            <button className="btn btn-primary btn-sm" onClick={onGo}>
                Go
            </button>
            <DefaultTooltip
                trigger={['hover']}
                placement="top"
                overlay={
                    <span>
                        Copy a link to this exact view (slide, position, zoom)
                    </span>
                }
            >
                <button
                    className={`btn btn-default btn-sm`}
                    data-testid="wsi-share-button"
                    onClick={handleCopy}
                >
                    {copied ? (
                        <i className="fa fa-check" />
                    ) : (
                        <i className="fa fa-clipboard" />
                    )}
                </button>
            </DefaultTooltip>
            {showDownload && (
                <DefaultTooltip
                    trigger={['hover']}
                    placement="top"
                    overlay={<span>Download current viewport as JPEG</span>}
                >
                    <button
                        className="btn btn-default btn-sm"
                        data-testid="wsi-download-button"
                        onClick={onDownload}
                    >
                        <i className="fa fa-cloud-download" />
                    </button>
                </DefaultTooltip>
            )}
            {cursorPos && (
                <span
                    style={{
                        marginLeft: 'auto',
                        color: C.muted,
                        fontFamily: 'monospace',
                        fontSize: 11,
                    }}
                >
                    <i
                        className="fa fa-crosshairs"
                        style={{ marginRight: 3 }}
                    />
                    {cursorLabel}
                </span>
            )}
        </div>
    );
}
