import * as React from 'react';
import { observer } from 'mobx-react';
import { observable, action, computed, makeObservable } from 'mobx';
import { DefaultTooltip } from 'cbioportal-frontend-commons';
import {
    PathologySlideFilter,
    PathologySlideMatchFilter,
    Slide,
    Sample,
    PatientHierarchy,
    TileMetadata,
    MutationDetail,
    WsiMutationDataStatus,
    WsiClinicalRow,
    WsiStainFilter,
    WsiTimepointSelection,
} from './wsiViewerTypes';
import {
    getServableSlideAssociationsBySlideKeyReadOnly,
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
import {
    buildPathRows,
    buildSampleUrl,
    buildSeqRows,
    buildWsiRows,
} from './wsiMetaUtils';
import { getWsiViewerRuntime } from './wsiViewerConfig';
import { SampleIdentifier } from './wsiDataMergeUtils';
import { BLOCK_LABEL_TIP, compareSamplesByTimepoint } from './wsiNavUtils';
import { WsiNavPanel } from './wsiNavPanel';
import { WsiSampleTimelineMap } from './wsiSampleTimeline';
import {
    WsiInitialSlideLoadPerformance,
    WsiSlideSelectionResult,
    WsiViewerController,
    WsiViewerControllerHost,
} from './wsiViewerController';
import { loadOpenSeadragon } from './wsiOpenSeadragonLoader';
import { clearPatientHierarchyCache } from './wsiHierarchyFetchCache';
import {
    clearWsiSlideAccess,
    getAgentAccessToken,
    getAnnotationAccessToken,
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
    buildWsiAgentSlideMetadata,
    buildWsiAgentSvgSelectorFromSlidePoints,
    WsiAgentContext,
    WsiAgentProposal,
} from './wsiAgent';
import { WsiAgentPanel } from './WsiAgentPanel';
import { WsiAgentProposalOverlay } from './WsiAgentProposalOverlay';
import {
    fetchClinicalDataRecordsReadOnly,
    fetchCnaDataReadOnly,
    fetchMutationDataReadOnly,
    fetchMutationFrequencyDataReadOnly,
    fetchStructuralVariantDataReadOnly,
} from './wsiCbioportalDataUtils';
import {
    fetchCivicCnaAnnotationsReadOnly,
    fetchCivicMutationAnnotationsReadOnly,
    fetchOncoKbCnaAnnotationsReadOnly,
    fetchOncoKbMutationAnnotationsReadOnly,
    fetchOncoKbStructuralVariantAnnotationsReadOnly,
} from './wsiAnnotationDataUtils';
import {
    applyClinicalDataRecords,
    applyCivicCnaAnnotations,
    applyCivicMutationAnnotations,
    applyCnaData,
    applyMutationData,
    applyMutationFrequencyData,
    applyOncoKbCnaAnnotations,
    applyOncoKbMutationAnnotations,
    applyOncoKbStructuralVariantAnnotations,
    applyStructuralVariantData,
} from './wsiHierarchyUpdateUtils';
import {
    getOncoKbApiUrl,
    isWsiCivicEnabled,
    isWsiOncoKbEnabled,
} from './wsiMolecularServices';
import {
    WSI_NAV_WIDTH,
    WSI_FONT_FAMILY,
    WSI_SECTION_TITLE_STYLE,
    WSI_SIDEBAR_MAX_WIDTH,
    WSI_SIDEBAR_MIN_WIDTH,
    WSI_SIDEBAR_WIDTH,
    WSI_THEME,
} from './wsiTheme';
import {
    readWsiPanelFlag,
    WsiCollapsedRail,
    writeWsiPanelFlag,
} from './wsiPanelChrome';

const C = WSI_THEME;
const NAV_W = WSI_NAV_WIDTH;
const SIDEBAR_W = WSI_SIDEBAR_WIDTH;
const SIDEBAR_MIN_W = WSI_SIDEBAR_MIN_WIDTH;
const SIDEBAR_MAX_W = WSI_SIDEBAR_MAX_WIDTH;
const SIDEBAR_HANDLE_W = 8;
const SLIDE_SELECTION_DEBOUNCE_MS = 120;
const MUTATION_RETRY_DELAY_MS = 250;
const sectionTitleStyle = WSI_SECTION_TITLE_STYLE;

/** Browser-stored hidden state of the slide list and the details sidebar. */
export const WSI_NAV_COLLAPSED_KEY = 'wsi.viewer.navCollapsed';
export const WSI_METADATA_COLLAPSED_KEY = 'wsi.viewer.metadataCollapsed';

interface Props {
    /** Tile-server base URL (never a patient-scoped or resource URL). */
    tileServerUrl: string;
    /** Backend-owned hierarchy endpoint for this patient. */
    hierarchyUrl: string;
    patientId: string;
    height: number;
    /** cBioPortal study ID — used to build sample links in the sidebar */
    studyId?: string;
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
    /**
     * Slide named by a `slideKey` viewer link. A URL hash selection wins over
     * it; an ID absent from the loaded hierarchy shows a notice and falls
     * back to the default slide without any backend lookup.
     */
    requestedSlideKey?: string;
    /** Sample acquisition/sequencing days from the patient timeline. */
    sampleTimelines?: WsiSampleTimelineMap;
    /**
     * Clinical rows for the sidebar, in display order. Rows with a `sampleId`
     * show only for that sample's slides; unset hides the section.
     */
    clinicalRows?: ReadonlyArray<WsiClinicalRow>;
    /** Shows the "download view" control. */
    showDownload?: boolean;
    /** Indicator shown while the hierarchy loads. */
    renderLoading?: () => React.ReactNode;
    /** Annotation service base URL; annotation authoring is off when unset. */
    annotationApiUrl?: string | null;
    /** Shows the research assistant, served by the annotation service. */
    agentEnabled?: boolean;
    /**
     * Hides the slide list. Unset, the viewer keeps the user's choice in
     * browser storage.
     */
    navCollapsed?: boolean;
    onNavCollapsedChange?: (collapsed: boolean) => void;
    /**
     * Hides the image details sidebar. Unset, the viewer keeps the user's
     * choice in browser storage.
     */
    metadataCollapsed?: boolean;
    onMetadataCollapsedChange?: (collapsed: boolean) => void;
    /**
     * The host hides the viewer without unmounting it (e.g. an inactive
     * tab). Background work such as token refresh pauses meanwhile.
     */
    hidden?: boolean;
}

function DefaultLoadingIndicator() {
    return (
        <i
            role="status"
            aria-label="Loading"
            className="fa fa-spinner fa-spin fa-3x"
            style={{ color: '#888' }}
        />
    );
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

function getPathologyPreferredSlideKeys(
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
    @observable private mutationDataStatus: WsiMutationDataStatus = 'idle';
    @observable private stainFilter: WsiStainFilter = 'all';
    @observable private matchFilter: PathologySlideMatchFilter = 'all';
    @observable private timepointDays: WsiTimepointSelection | undefined;
    @observable private linkoutScopeActive = false;
    @observable private sidebarWidth = SIDEBAR_W;
    @observable private storedNavCollapsed = readWsiPanelFlag(
        WSI_NAV_COLLAPSED_KEY
    );
    @observable private storedMetadataCollapsed = readWsiPanelFlag(
        WSI_METADATA_COLLAPSED_KEY
    );
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
    // Background enrichment mutates the hierarchy's samples in place, keeping
    // the hierarchy identity the controller uses to discard stale results.
    // Each merge bumps this version so memoized children re-render.
    @observable private hierarchyDataVersion = 0;
    private annotationController: WsiAnnotationController;
    @observable private agentProposals: WsiAgentProposal[] = [];
    @observable private requestedSlideNoticeDismissed = false;
    private hierarchyRefreshScheduled = false;
    private hierarchyRefreshRaf: number | null = null;
    private hierarchyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private slideSelectionTimer: ReturnType<typeof setTimeout> | null = null;

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
    private unsubscribeUrlState: (() => void) | null = null;
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
                getAnnotationAccessToken(
                    this.props.studyId || '',
                    this.props.authScope || 'anonymousUser'
                )
        );
        this.controller = new WsiViewerController(
            this.createControllerHost(),
            loadOpenSeadragon
        );
    }

    @computed private get navCollapsed(): boolean {
        return this.props.navCollapsed ?? this.storedNavCollapsed;
    }

    @computed private get metadataCollapsed(): boolean {
        return this.props.metadataCollapsed ?? this.storedMetadataCollapsed;
    }

    @action.bound
    private setNavCollapsed(collapsed: boolean) {
        if (this.props.navCollapsed === undefined) {
            this.storedNavCollapsed = collapsed;
            writeWsiPanelFlag(WSI_NAV_COLLAPSED_KEY, collapsed);
        }
        this.props.onNavCollapsedChange?.(collapsed);
        this.resizeAfterLayout();
    }

    @action.bound
    private setMetadataCollapsed(collapsed: boolean) {
        if (this.props.metadataCollapsed === undefined) {
            this.storedMetadataCollapsed = collapsed;
            writeWsiPanelFlag(WSI_METADATA_COLLAPSED_KEY, collapsed);
        }
        this.props.onMetadataCollapsedChange?.(collapsed);
        this.resizeAfterLayout();
    }

    private readonly hideNav = () => this.setNavCollapsed(true);
    private readonly showNav = () => this.setNavCollapsed(false);
    private readonly hideMetadata = () => this.setMetadataCollapsed(true);
    private readonly showMetadata = () => this.setMetadataCollapsed(false);

    /** Lets OpenSeadragon pick up the viewer's new size after a panel toggles. */
    private resizeAfterLayout() {
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => this.controller.forceResize());
        } else {
            this.controller.forceResize();
        }
    }

    @action.bound
    private setSidebarWidth(width: number) {
        const clamped = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, width));
        this.sidebarWidth = clamped;
        this.controller.forceResize();
    }

    @action.bound
    private setMutationDataStatus(status: WsiMutationDataStatus) {
        this.mutationDataStatus = status;
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
            setMutationDataStatus: status => this.setMutationDataStatus(status),
            setThumbnailPreview: action(objectUrl => {
                this.thumbnailPreviewUrl = objectUrl;
            }),
            getSelectedSlide: () => this.selectedSlide,
            getSelectedSample: () => this.selectedSample,
            getSelectedMeta: () => this.selectedMeta,
            clearSelectedSlide: () => {
                this.annotationController.invalidatePendingRequests();
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
            runSampleEnrichment: (
                base,
                studyId,
                patientId,
                sampleIds,
                shouldContinue
            ) =>
                this.runSampleEnrichment(
                    base,
                    studyId,
                    patientId,
                    sampleIds,
                    shouldContinue
                ),
            onSlideSelectionStarted: slide => {
                this.annotationController.beginSlide(slide.slide_key);
            },
            onViewerOpened: (viewer, openSeadragon, slide) =>
                this.annotationController.attachViewer(
                    viewer,
                    openSeadragon,
                    slide.slide_key
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

    selectSlide(
        slide: Slide,
        sample: Sample
    ): Promise<WsiSlideSelectionResult> {
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
        this.unsubscribeUrlState = getWsiViewerRuntime().urlState.subscribe(
            this.handleHashChange
        );
        if (typeof document !== 'undefined') {
            document.addEventListener(
                'visibilitychange',
                this.updateControllerVisibility
            );
        }
        this.updateControllerVisibility();
        void this.controller.loadHierarchy();
    }

    private readonly updateControllerVisibility = () => {
        const pageHidden =
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden';
        this.controller.setVisible(!this.props.hidden && !pageHidden);
    };

    private async selectSlideFromHash(): Promise<void> {
        const hashState = getWsiViewerRuntime().urlState.read();
        if (!hashState || !this.hierarchy) return;

        const preferredSlideKeys = getPathologyPreferredSlideKeys(
            this.hierarchy,
            this.activePathologyFilter
        );
        const matching = this.servableSlides.find(
            entry =>
                entry.slide.slide_key === hashState.slideId &&
                (!preferredSlideKeys ||
                    preferredSlideKeys.has(entry.slide.slide_key)) &&
                this.matchesCurrentTimepoint(entry.slide)
        );
        if (!matching) return;

        if (this.selectedSlide?.slide_key === matching.slide.slide_key) {
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
        const requestedSlideKeyChanged =
            prev.requestedSlideKey !== this.props.requestedSlideKey;
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

        if (prev.hidden !== this.props.hidden) {
            this.updateControllerVisibility();
        }

        if (timepointFilterChanged) {
            this.timepointDays = this.props.initialTimepointDays;
        }

        if (requestedSlideKeyChanged) {
            this.requestedSlideNoticeDismissed = false;
        }

        if (authScopeChanged) {
            clearPatientHierarchyCache();
            clearWsiSlideAccess();
            clearSlideMetadataCache();
            clearWsiThumbnailFetchCache();
        }

        if (
            authScopeChanged ||
            prev.studyId !== this.props.studyId ||
            prev.annotationApiUrl !== this.props.annotationApiUrl
        ) {
            // A hierarchy reload begins the slide again, so only drop the
            // previous context's annotations here.
            if (requiresHierarchyReload) {
                this.annotationController.invalidatePendingRequests();
            }
            this.annotationController.setContext(
                this.props.annotationApiUrl,
                this.props.studyId
            );
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
        } else if (preferredSampleChanged || requestedSlideKeyChanged) {
            void this.reselectPreferredSampleSlide();
        }
    }

    componentWillUnmount() {
        this.unsubscribeUrlState?.();
        this.unsubscribeUrlState = null;
        if (typeof document !== 'undefined') {
            document.removeEventListener(
                'visibilitychange',
                this.updateControllerVisibility
            );
        }
        this.cancelPendingSlideSelection();
        action(() => {
            this.hierarchy = null; // stops the prefetchSlideMetadata loop
        })();
        this.cancelScheduledHierarchyRefresh();
        this.controller.dispose();
        this.annotationController.invalidatePendingRequests();
        this.handleSidebarResizeEnd();
    }

    // ---- data loading ----

    @action.bound
    private resetHierarchyLoadState() {
        this.cancelScheduledHierarchyRefresh();
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
        this.mutationDataStatus = 'idle';
        this.cursorPos = null;
        this.coordInputX = '';
        this.coordInputY = '';
    }

    private get controllerProps() {
        return {
            hierarchyUrl: this.props.hierarchyUrl,
            studyId: this.props.studyId,
            patientId: this.props.patientId,
            pathologyFilter: this.activePathologyFilter,
            authScope: this.props.authScope || 'anonymousUser',
        };
    }

    private get activePathologyFilter(): PathologySlideFilter | undefined {
        return this.linkoutScopeActive ? this.props.pathologyFilter : undefined;
    }

    private readonly getAgentToken = () =>
        getAgentAccessToken(
            this.props.studyId || '',
            this.props.authScope || 'anonymousUser'
        );

    private readonly getAgentContext = async (): Promise<WsiAgentContext | null> => {
        if (!this.selectedSlide || !this.selectedSample || !this.selectedMeta) {
            return null;
        }
        const slideKey = this.selectedSlide.slide_key;
        const sampleId = this.selectedSample.sample_id;
        const studyId = this.props.studyId || '';
        const patientId = this.props.patientId;
        const width = this.selectedMeta.dimensions.width;
        const height = this.selectedMeta.dimensions.height;
        const viewport = await this.controller.captureAgentViewportAfterDraw();
        if (
            !viewport ||
            this.props.studyId !== studyId ||
            this.props.patientId !== patientId ||
            this.selectedSlide?.slide_key !== slideKey ||
            this.selectedSample?.sample_id !== sampleId ||
            this.selectedMeta?.dimensions.width !== width ||
            this.selectedMeta?.dimensions.height !== height
        ) {
            return null;
        }
        return {
            study_id: studyId,
            patient_id: patientId,
            sample_id: sampleId,
            slide_key: slideKey,
            stain_name: this.selectedSlide.stain_name,
            match_level: this.activePathologyFilter?.matchLevel,
            filters: {
                stain: this.stainFilter,
                match: this.matchFilter,
                timepoint_days: this.timepointDays,
            },
            slide_metadata: buildWsiAgentSlideMetadata(this.selectedMeta),
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
                this.servableSlides.map(entry => entry.slide.slide_key)
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
            proposal.slide_key === context.slide_key &&
            !!proposalContext &&
            proposalContext.study_id === context.study_id &&
            proposalContext.patient_id === context.patient_id &&
            proposalContext.slide_key === context.slide_key &&
            viewport?.source_fingerprint ===
                context.viewport.source_fingerprint &&
            viewport?.viewer_generation === context.viewport.viewer_generation
        );
    }

    private slideMatchesAgentFilters(entry: { slide: Slide; sample: Sample }) {
        if (!this.hierarchy) return false;
        const preferredSlideKeys = getPathologyPreferredSlideKeys(
            this.hierarchy,
            this.activePathologyFilter
        );
        if (
            preferredSlideKeys &&
            !preferredSlideKeys.has(entry.slide.slide_key)
        ) {
            return false;
        }
        if (!matchesWsiStainFilter(entry.slide, this.stainFilter)) {
            return false;
        }
        const associations = getServableSlideAssociationsBySlideKeyReadOnly(
            this.hierarchy.slide_associations
        );
        if (
            !matchesWsiTimepointFilter(
                entry.slide,
                associations.get(entry.slide.slide_key),
                this.timepointDays
            )
        ) {
            return false;
        }
        return (
            this.matchFilter === 'all' ||
            associations.get(entry.slide.slide_key)?.match_level ===
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
            const slideKey = parameters.slide_key;
            const entry = this.servableSlides.find(
                candidate => candidate.slide.slide_key === slideKey
            );
            if (!entry || !this.slideMatchesAgentFilters(entry)) {
                return {
                    success: false,
                    detail:
                        'That slide is not available under the current filters.',
                };
            }
            const selection = await this.controller.selectSlide(
                entry.slide,
                entry.sample
            );
            return selection.status === 'ready' &&
                this.selectedSlide?.slide_key === slideKey
                ? { success: true, detail: 'Slide selected.' }
                : {
                      success: false,
                      detail:
                          selection.detail ||
                          'The slide could not be selected.',
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
            const selection = await this.reselectSlideForCurrentFilters();
            return selection?.status === 'ready'
                ? { success: true, detail: 'Filters applied.' }
                : {
                      success: false,
                      detail:
                          selection?.detail ||
                          'No slide matches the requested filters.',
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
            const viewport = await this.controller.captureAgentViewportAfterDraw();
            return viewport
                ? { success: true, detail: 'Coordinates updated.' }
                : {
                      success: false,
                      detail: 'The viewer changed while moving.',
                  };
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
            const viewport = await this.controller.captureAgentViewportAfterDraw();
            return viewport
                ? { success: true, detail: 'Zoom updated.' }
                : {
                      success: false,
                      detail: 'The viewer changed while zooming.',
                  };
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
            context.slide_key !== proposal.slide_key ||
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
        const association = getServableSlideAssociationsBySlideKeyReadOnly(
            this.hierarchy.slide_associations
        ).get(slide.slide_key);
        return matchesWsiTimepointFilter(
            slide,
            association,
            this.timepointDays
        );
    }

    @action.bound
    private applyPathologyFilterFromSourceHierarchy() {
        const hierarchy = this.hierarchy;
        if (!hierarchy) {
            return;
        }

        const preferredSlideKeys = getPathologyPreferredSlideKeys(
            hierarchy,
            this.activePathologyFilter
        );
        if (preferredSlideKeys) {
            const currentSlideKey = this.selectedSlide?.slide_key;
            const currentSampleId = this.selectedSample?.sample_id;
            const currentSample = hierarchy.samples.find(
                sample => sample.sample_id === currentSampleId
            );
            const firstMatchingSlide = currentSample
                ? getOrderedServableSlidesForSampleReadOnly(currentSample).find(
                      ({ slide }) =>
                          preferredSlideKeys.has(slide.slide_key) &&
                          matchesWsiStainFilter(slide, this.stainFilter) &&
                          this.matchesCurrentTimepoint(slide)
                  )?.slide
                : undefined;
            if (
                currentSlideKey &&
                firstMatchingSlide?.slide_key === currentSlideKey
            ) {
                this.selectedSlide = firstMatchingSlide;
                this.selectedSample = currentSample!;
                return;
            }
            void this.reselectSlideForPathologyFilter(preferredSlideKeys);
            return;
        }

        const currentSlideKey = this.selectedSlide?.slide_key;
        const currentSampleId = this.selectedSample?.sample_id;
        if (!currentSlideKey || !currentSampleId) {
            void this.reselectSlideForCurrentFilters();
            return;
        }

        const matchingSample = hierarchy.samples.find(
            sample =>
                sample.sample_id === currentSampleId &&
                sampleHasServableSlide(sample, currentSlideKey)
        );
        const matchingSlide = matchingSample
            ? getOrderedServableSlidesForSampleReadOnly(matchingSample).find(
                  ({ slide }) =>
                      slide.slide_key === currentSlideKey &&
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
        preferredSlideKeys: Set<string>
    ): Promise<void> {
        const servableSlides = this.servableSlides;
        if (!this.hierarchy || !servableSlides.length) {
            return;
        }

        const next = chooseInitialMatchingServableSlide(servableSlides, {
            preferredSampleId: this.props.preferredSampleId,
            stainFilter: this.stainFilter,
            matchesEntry: entry =>
                preferredSlideKeys.has(entry.slide.slide_key) &&
                this.matchesCurrentTimepoint(entry.slide),
        });

        if (!next) {
            this.controller.clearSelectedSlide();
            return;
        }

        if (
            this.selectedSlide?.slide_key === next.slide.slide_key &&
            this.selectedSample?.sample_id === next.sample.sample_id
        ) {
            return;
        }

        await this.controller.selectSlide(next.slide, next.sample);
    }

    private chooseInitialServableSlide(
        allSlides: Array<{ slide: Slide; sample: Sample }>
    ) {
        const hashState = getWsiViewerRuntime().urlState.read();
        const preferredSlideKeys = getPathologyPreferredSlideKeys(
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
                requestedSlideKey: this.props.requestedSlideKey,
                stainFilter: this.stainFilter,
                matchesEntry: entry =>
                    !preferredSlideKeys ||
                    preferredSlideKeys.has(entry.slide.slide_key),
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
            this.selectedSlide?.slide_key === next.slide.slide_key &&
            this.selectedSample?.sample_id === next.sample.sample_id
        ) {
            return;
        }

        await this.controller.selectSlide(next.slide, next.sample);
    }

    private async reselectSlideForCurrentFilters(): Promise<WsiSlideSelectionResult | null> {
        const servableSlides = this.servableSlides;
        if (!this.hierarchy || !servableSlides.length) {
            return {
                status: 'failed',
                slideKey: '',
                detail: 'No slide matches the requested filters.',
            };
        }

        const preferredSlideKeys = getPathologyPreferredSlideKeys(
            this.hierarchy,
            this.activePathologyFilter
        );
        const associationsBySlideKey = getServableSlideAssociationsBySlideKeyReadOnly(
            this.hierarchy.slide_associations
        );
        const matchingSlides = servableSlides.filter(({ slide }) => {
            if (
                preferredSlideKeys &&
                !preferredSlideKeys.has(slide.slide_key)
            ) {
                return false;
            }
            if (!matchesWsiStainFilter(slide, this.stainFilter)) {
                return false;
            }
            if (
                !matchesWsiTimepointFilter(
                    slide,
                    associationsBySlideKey.get(slide.slide_key),
                    this.timepointDays
                )
            ) {
                return false;
            }
            return (
                this.matchFilter === 'all' ||
                associationsBySlideKey.get(slide.slide_key)?.match_level ===
                    this.matchFilter.toUpperCase()
            );
        });
        if (!matchingSlides.length) {
            this.controller.clearSelectedSlide();
            return {
                status: 'failed',
                slideKey: '',
                detail: 'No slide matches the requested filters.',
            };
        }

        const next = matchingSlides[0];
        if (
            this.selectedSlide?.slide_key === next.slide.slide_key &&
            this.selectedSample?.sample_id === next.sample.sample_id &&
            this.viewerReady &&
            this.tilesReady &&
            this.error === null
        ) {
            return { status: 'ready', slideKey: next.slide.slide_key };
        }
        return this.controller.selectSlide(next.slide, next.sample);
    }

    @action.bound
    private setCoordInputs(x: string, y: string) {
        this.coordInputX = x;
        this.coordInputY = y;
    }

    private buildSampleIdentifiers(
        studyId: string,
        sampleIds: string[]
    ): SampleIdentifier[] {
        const identifiers: SampleIdentifier[] = [];
        const seenSampleIds = new Set<string>();
        for (let index = 0; index < sampleIds.length; index += 1) {
            const sampleId = sampleIds[index];
            if (seenSampleIds.has(sampleId)) {
                continue;
            }
            seenSampleIds.add(sampleId);
            identifiers.push({ studyId, sampleId });
        }
        return identifiers;
    }

    private collectSampleEntries<T>(
        getEntries: (sample: Sample) => T[] | undefined,
        includeEntry?: (entry: T) => boolean
    ): T[] {
        const hierarchy = this.hierarchy;
        if (!hierarchy) {
            return [];
        }

        const result: T[] = [];
        for (
            let sampleIndex = 0;
            sampleIndex < hierarchy.samples.length;
            sampleIndex += 1
        ) {
            const entries = getEntries(hierarchy.samples[sampleIndex]);
            if (!entries?.length) {
                continue;
            }
            for (
                let entryIndex = 0;
                entryIndex < entries.length;
                entryIndex += 1
            ) {
                const entry = entries[entryIndex];
                if (!includeEntry || includeEntry(entry)) {
                    result.push(entry);
                }
            }
        }
        return result;
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

    /** True when a `slideKey` link names a slide this patient cannot serve. */
    @computed get requestedSlideUnavailable(): boolean {
        const requestedSlideKey = this.props.requestedSlideKey;
        return (
            !!requestedSlideKey &&
            !!this.hierarchy &&
            !this.servableSlides.some(
                entry => entry.slide.slide_key === requestedSlideKey
            )
        );
    }

    @action.bound
    private dismissRequestedSlideNotice() {
        this.requestedSlideNoticeDismissed = true;
    }

    /** Patient rows plus the selected sample's rows. */
    @computed get selectedClinicalRows(): WsiClinicalRow[] | undefined {
        const rows = this.props.clinicalRows;
        if (!rows) return undefined;
        const sampleId = this.selectedSample?.sample_id;
        return rows.filter(row => !row.sampleId || row.sampleId === sampleId);
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

    @computed
    private get sidebarMolecularSample(): Sample | null {
        if (!this.selectedSample || !this.hierarchy) {
            return this.selectedSample;
        }
        if (this.selectedSample.sample_id !== 'UNMATCHED') {
            return this.selectedSample;
        }

        const referenceSampleId = this.hierarchy.reference_sample_id;
        return (
            this.hierarchy.samples.find(
                sample => sample.sample_id === referenceSampleId
            ) || this.selectedSample
        );
    }

    @computed
    private get selectedSampleUrl(): string | undefined {
        const studyId = this.props.studyId;
        const sampleId = this.sidebarMolecularSample?.sample_id;
        return studyId && sampleId && sampleId !== 'UNMATCHED'
            ? buildSampleUrl(studyId, sampleId, this.viewerPatientId)
            : undefined;
    }

    private get sidebarImpactSample(): Sample | null {
        return this.tilesReady ? this.sidebarMolecularSample : null;
    }

    private get sidebarSeqRowsForRender(): MetaRow[] {
        return this.tilesReady ? this.selectedSeqRows : [];
    }

    @computed
    private get selectedSeqRows(): MetaRow[] {
        // Read the version: enrichment updates the sample in place.
        void this.hierarchyDataVersion;
        const molecularSample = this.sidebarMolecularSample;
        return this.selectedSlide && molecularSample
            ? buildSeqRows(molecularSample, this.selectedSampleUrl)
            : [];
    }

    @computed
    private get selectedWsiRows(): MetaRow[] {
        return this.selectedMeta
            ? buildWsiRows(this.selectedSlide, this.selectedMeta)
            : [];
    }

    @computed
    private get selectedPathRows(): MetaRow[] {
        // Clinical enrichment can update the sample's cancer type in place.
        void this.hierarchyDataVersion;
        if (!this.selectedSlide || !this.selectedSample) {
            return [];
        }
        return buildPathRows(
            this.selectedSlide,
            this.selectedSample,
            this.viewerPatientId,
            this.props.studyId,
            this.hierarchy
                ? getServableSlideAssociationsBySlideKeyReadOnly(
                      this.hierarchy.slide_associations
                  ).get(this.selectedSlide.slide_key)
                : undefined,
            this.props.sampleTimelines?.get(this.selectedSample.sample_id)
        );
    }

    @computed
    private get tileServerOrigin(): string {
        try {
            return new URL(this.tileServerBase, window.location.href).origin;
        } catch {
            return this.tileServerBase;
        }
    }

    @action.bound
    private updateHierarchy(expectedHierarchy?: PatientHierarchy | null) {
        this.hierarchyRefreshScheduled = false;
        this.hierarchyRefreshRaf = null;
        this.hierarchyRefreshTimer = null;
        if (
            !this.hierarchy ||
            (expectedHierarchy !== undefined &&
                this.hierarchy !== expectedHierarchy)
        ) {
            return;
        }
        this.hierarchyDataVersion++;
    }

    private cancelScheduledHierarchyRefresh() {
        if (this.hierarchyRefreshRaf !== null) {
            cancelAnimationFrame(this.hierarchyRefreshRaf);
            this.hierarchyRefreshRaf = null;
        }
        if (this.hierarchyRefreshTimer !== null) {
            clearTimeout(this.hierarchyRefreshTimer);
            this.hierarchyRefreshTimer = null;
        }
        this.hierarchyRefreshScheduled = false;
    }

    private scheduleHierarchyRefresh(expectedHierarchy = this.hierarchy) {
        if (this.hierarchyRefreshScheduled) {
            return;
        }

        this.hierarchyRefreshScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            this.hierarchyRefreshRaf = requestAnimationFrame(() =>
                this.updateHierarchy(expectedHierarchy)
            );
            return;
        }

        this.hierarchyRefreshTimer = setTimeout(
            () => this.updateHierarchy(expectedHierarchy),
            0
        );
    }

    private applyHierarchyMutation(mutator: (samples: Sample[]) => void) {
        if (!this.hierarchy) return;
        action(() => {
            mutator(this.hierarchy!.samples);
        })();
        this.hierarchyDataVersion++;
    }

    private applyHierarchyMutationAndRefresh(
        mutator: (samples: Sample[]) => void,
        shouldContinue: () => boolean = () => true
    ) {
        if (!this.hierarchy || !shouldContinue()) return;
        const expectedHierarchy = this.hierarchy;
        this.applyHierarchyMutation(mutator);
        if (shouldContinue() && this.hierarchy === expectedHierarchy) {
            this.scheduleHierarchyRefresh(expectedHierarchy);
        }
    }

    /**
     * Enrich sample metadata (TMB, MSI, tumor purity, oncogenic mutations, …) from
     * cBioPortal's REST API so the sidebar reflects the same data shown elsewhere in
     * cBioPortal rather than a potentially-stale Databricks snapshot.
     *
     * Runs as a fire-and-forget background task as soon as the tile-server
     * hierarchy is loaded. If cBioPortal is unavailable, the tile-server data
     * remains as-is.
     */
    private async runSampleEnrichment(
        base: string,
        studyId: string,
        _patientId: string,
        sampleIds: string[],
        shouldContinue: () => boolean
    ): Promise<void> {
        const expectedHierarchy = this.hierarchy;
        const shouldContinueForHierarchy = () =>
            shouldContinue() && this.hierarchy === expectedHierarchy;
        const sampleIdentifiers = this.buildSampleIdentifiers(
            studyId,
            sampleIds
        );
        if (!sampleIdentifiers.length || !shouldContinueForHierarchy()) {
            if (shouldContinueForHierarchy()) {
                this.setMutationDataStatus('ready');
            }
            return;
        }

        this.setMutationDataStatus('loading');

        await Promise.allSettled([
            this.fetchAndMergeClinicalData(
                base,
                studyId,
                sampleIdentifiers,
                shouldContinueForHierarchy
            ),
            this.fetchAndMergeMutations(
                base,
                studyId,
                sampleIdentifiers,
                shouldContinueForHierarchy
            ),
        ]);
        if (
            shouldContinueForHierarchy() &&
            this.mutationDataStatus === 'loading'
        ) {
            // Keep mocked/custom enrichment hosts from leaving the sidebar in a
            // permanent loading state when they do not own mutation status.
            this.setMutationDataStatus('ready');
        }
        if (!shouldContinueForHierarchy()) return;

        await Promise.allSettled([
            this.fetchAndMergeCNA(
                base,
                studyId,
                sampleIdentifiers,
                shouldContinueForHierarchy
            ),
            this.fetchAndMergeStructuralVariants(
                base,
                studyId,
                sampleIdentifiers,
                shouldContinueForHierarchy
            ),
        ]);
        if (!shouldContinueForHierarchy()) return;

        if (isWsiOncoKbEnabled()) {
            void this.fetchAndMergeOncoKbAnnotations(
                shouldContinueForHierarchy
            );
        }
        if (isWsiCivicEnabled()) {
            void this.fetchAndMergeCivicAnnotations(shouldContinueForHierarchy);
        }
        void this.fetchAndMergeMutationFrequency(
            base,
            studyId,
            shouldContinueForHierarchy
        );
        if (isWsiOncoKbEnabled()) {
            void this.fetchAndMergeCnaOncoKbAnnotations(
                shouldContinueForHierarchy
            );
            void this.fetchAndMergeStructuralVariantOncoKbAnnotations(
                shouldContinueForHierarchy
            );
        }
        if (isWsiCivicEnabled()) {
            void this.fetchAndMergeCnaCivicAnnotations(
                shouldContinueForHierarchy
            );
        }
    }

    /**
     * Fetch sample-level clinical attributes from cBioPortal and merge them into
     * the in-memory hierarchy samples.  Only attributes present in the response
     * are updated; missing attributes keep their tile-server values.
     */
    private async fetchAndMergeClinicalData(
        base: string,
        _studyId: string,
        sampleIdentifiers: SampleIdentifier[],
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const data = await fetchClinicalDataRecordsReadOnly(
            base,
            sampleIdentifiers
        );
        if (!data || !shouldContinue()) return;

        this.applyHierarchyMutation(samples => {
            applyClinicalDataRecords(samples, data);
        });
    }

    /**
     * Fetch somatic mutations from cBioPortal mutations API.
     * Populates `oncogenic_mutations` (the display list) from ALL mutations returned by the
     * API — matching what cBioPortal's patient page shows — and sets `oncogenic_mutation_details`
     * (type, VAF per mutation) for tooltip display.  If the API returns no data, falls back to
     * whatever `fetchAndMergeClinicalData` already placed in `oncogenic_mutations`.
     */
    private async fetchAndMergeMutations(
        base: string,
        studyId: string,
        sampleIdentifiers: SampleIdentifier[],
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        // Declare maps here so the finally block can always mark details as ready,
        // even when the function returns early due to an error or missing data.
        const allMutsBySample = new Map<
            string,
            Array<{ token: string; vaf: number }>
        >();
        const detailsBySample = new Map<string, Map<string, MutationDetail>>();
        let mutationData: Awaited<ReturnType<
            typeof fetchMutationDataReadOnly
        >> = null;
        let lastError: unknown;
        try {
            // A cold portal load can briefly return a failed profile/data request
            // while the same request succeeds on refresh. Retry once with a
            // cache bypass so a transient response cannot permanently suppress
            // the variant table for the five-minute request-cache TTL.
            for (let attempt = 0; attempt < 2; attempt += 1) {
                if (!shouldContinue()) return;
                try {
                    mutationData = await fetchMutationDataReadOnly(
                        base,
                        studyId,
                        sampleIdentifiers,
                        {
                            forceRefresh: attempt > 0,
                            throwOnHttpError: true,
                        }
                    );
                    lastError = undefined;
                } catch (error) {
                    lastError = error;
                    mutationData = null;
                }
                if (mutationData !== null || attempt === 1) break;
                await new Promise(resolve =>
                    setTimeout(resolve, MUTATION_RETRY_DELAY_MS)
                );
            }
            if (!mutationData && lastError) {
                throw lastError;
            }
            if (!mutationData) return;

            mutationData.allMutsBySample.forEach(
                (value: Array<{ token: string; vaf: number }>, key: string) =>
                    allMutsBySample.set(key, value)
            );
            mutationData.detailsBySample.forEach(
                (value: Map<string, MutationDetail>, key: string) =>
                    detailsBySample.set(key, value)
            );
        } catch (e) {
            lastError = e;
            console.error('[WSIViewer] fetchAndMergeMutations failed:', e);
        } finally {
            if (!shouldContinue()) {
                return;
            }
            const hasApiMutationData =
                allMutsBySample.size > 0 || detailsBySample.size > 0;
            const hasExistingMutationText = (
                this.hierarchy?.samples ?? []
            ).some(sample => !!sample.oncogenic_mutations);
            if (!hasApiMutationData && !hasExistingMutationText) {
                this.setMutationDataStatus(lastError ? 'error' : 'ready');
                return;
            }
            this.applyHierarchyMutation(samples => {
                applyMutationData(samples, allMutsBySample, detailsBySample);
            });
            this.setMutationDataStatus(lastError ? 'error' : 'ready');
        }
    }

    /**
     * Fetch OncoKB annotations for all mutations collected by fetchAndMergeMutations and
     * merge oncogenic / mutationEffect / hotspot / geneSummary / variantSummary into each
     * MutationDetail object in-place so that MutationTable can show rich tooltips.
     *
     * Routes through the portal's configured OncoKB proxy to preserve the same
     * request path, credentials and response contract used by the rest of the
     * frontend. The tile origin is never used as an annotation host.
     *
     * Silently no-ops when the portal proxy is unavailable or returns an optional-service
     * failure, or when the hierarchy has no mutations with entrezGeneId.
     */
    private async fetchAndMergeOncoKbAnnotations(
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const allDetails = this.collectSampleEntries(
            sample => sample.oncogenic_mutation_details,
            detail => !!detail.entrezGeneId
        );
        if (!allDetails.length) return;

        let oncoKbBase: string;
        try {
            oncoKbBase = getOncoKbApiUrl();
        } catch {
            // Embedded viewers may not have portal config yet; enrichment is optional.
            return;
        }
        if (!oncoKbBase) return;

        const annotations = await fetchOncoKbMutationAnnotationsReadOnly(
            oncoKbBase,
            allDetails
        );
        if (!annotations?.length || !shouldContinue()) return;

        this.applyHierarchyMutationAndRefresh(samples => {
            applyOncoKbMutationAnnotations(samples, annotations);
        }, shouldContinue);
    }

    /**
     * Fetch CIViC gene/variant records for WSI mutation details so the compact
     * metadata table can reuse the same detailed CIViC card used elsewhere.
     */
    private async fetchAndMergeCivicAnnotations(
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const allDetails = this.collectSampleEntries(
            sample => sample.oncogenic_mutation_details
        );
        if (!allDetails.length) return;

        const annotations = await fetchCivicMutationAnnotationsReadOnly(
            allDetails
        );
        if (!annotations?.length || !shouldContinue()) return;

        this.applyHierarchyMutationAndRefresh(samples => {
            applyCivicMutationAnnotations(samples, annotations);
        }, shouldContinue);
    }

    /**
     * Fetch significant discrete copy-number alterations (value ≠ 0) from cBioPortal
     * and merge them into each sample's `cna_alterations` field.
     */
    private async fetchAndMergeCNA(
        base: string,
        studyId: string,
        sampleIdentifiers: SampleIdentifier[],
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const bySample = await fetchCnaDataReadOnly(
            base,
            studyId,
            sampleIdentifiers
        );
        if (!bySample || !shouldContinue()) return;

        this.applyHierarchyMutationAndRefresh(samples => {
            applyCnaData(samples, bySample);
        }, shouldContinue);
    }

    private async fetchAndMergeCnaCivicAnnotations(
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const allCnas = this.collectSampleEntries(
            sample => sample.cna_alterations
        );
        if (!allCnas.length) return;

        const annotations = await fetchCivicCnaAnnotationsReadOnly(allCnas);
        if (!annotations?.length || !shouldContinue()) return;

        this.applyHierarchyMutationAndRefresh(samples => {
            applyCivicCnaAnnotations(samples, annotations);
        }, shouldContinue);
    }

    /**
     * Fetch OncoKB annotations for CNA events so CNA annotation mouseover
     * matches the SNV annotation card.
     */
    private async fetchAndMergeCnaOncoKbAnnotations(
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const allCnas = this.collectSampleEntries(
            sample => sample.cna_alterations
        );
        let oncoKbBase: string;
        try {
            oncoKbBase = getOncoKbApiUrl();
        } catch {
            // Embedded viewers may not have portal config yet; enrichment is optional.
            return;
        }
        if (!oncoKbBase) return;

        const annotations = await fetchOncoKbCnaAnnotationsReadOnly(
            oncoKbBase,
            allCnas
        );
        if (!annotations?.length || !shouldContinue()) return;
        this.applyHierarchyMutationAndRefresh(samples => {
            applyOncoKbCnaAnnotations(samples, annotations);
        }, shouldContinue);
    }
    /**
     * Fetch sample-level structural variants from cBioPortal and merge them into
     * each sample's `structural_variants` field.
     */
    private async fetchAndMergeStructuralVariants(
        base: string,
        studyId: string,
        sampleIdentifiers: SampleIdentifier[],
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const bySample = await fetchStructuralVariantDataReadOnly(
            base,
            studyId,
            sampleIdentifiers
        );
        if (!bySample || !shouldContinue()) return;

        this.applyHierarchyMutationAndRefresh(samples => {
            applyStructuralVariantData(samples, bySample);
        }, shouldContinue);
    }

    private async fetchAndMergeStructuralVariantOncoKbAnnotations(
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const allStructuralVariants = this.collectSampleEntries(
            sample => sample.structural_variants
        );
        let oncoKbBase: string;
        try {
            oncoKbBase = getOncoKbApiUrl();
        } catch {
            // Embedded viewers may not have portal config yet; enrichment is optional.
            return;
        }
        if (!oncoKbBase) return;

        const annotations = await fetchOncoKbStructuralVariantAnnotationsReadOnly(
            oncoKbBase,
            allStructuralVariants
        );
        if (!annotations?.length || !shouldContinue()) return;
        this.applyHierarchyMutationAndRefresh(samples => {
            applyOncoKbStructuralVariantAnnotations(samples, annotations);
        }, shouldContinue);
    }
    /**
     * Fetch cohort mutation frequencies for all mutations and store as fraction (0–1)
     * in each MutationDetail's `cohortFrequency` field.
     * Uses /api/mutation-counts-by-position/fetch and the study's sequencedSampleCount.
     */
    private async fetchAndMergeMutationFrequency(
        base: string,
        studyId: string,
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        try {
            if (!shouldContinue()) return;
            const mutationFrequencyData = await fetchMutationFrequencyDataReadOnly(
                base,
                studyId,
                this.hierarchy?.samples ?? []
            );
            if (!mutationFrequencyData || !shouldContinue()) return;

            this.applyHierarchyMutation(samples => {
                applyMutationFrequencyData(
                    samples,
                    mutationFrequencyData.counts,
                    mutationFrequencyData.total
                );
            });
        } catch {
            // Non-critical — cohort % simply won't appear
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
                    {this.props.renderLoading ? (
                        this.props.renderLoading()
                    ) : (
                        <DefaultLoadingIndicator />
                    )}
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
                    fontFamily: WSI_FONT_FAMILY,
                    fontSize: 13,
                    color: C.text,
                }}
            >
                {/* Left nav panel */}
                {this.navCollapsed ? (
                    <WsiCollapsedRail
                        side="left"
                        title="Slides"
                        showLabel="Show slide list"
                        onExpand={this.showNav}
                        background={C.navBg}
                        testId="wsi-nav-rail"
                    />
                ) : (
                    <WsiNavPanel
                        dataVersion={this.hierarchyDataVersion}
                        hierarchy={hierarchy}
                        selectedSlide={selectedSlide}
                        slideIdFilter={getPathologyPreferredSlideKeys(
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
                        sampleTimelines={this.props.sampleTimelines}
                        theme={C}
                        navWidth={NAV_W}
                        sectionTitleStyle={sectionTitleStyle}
                        onHide={this.hideNav}
                    />
                )}

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
                    {this.requestedSlideUnavailable &&
                        !this.requestedSlideNoticeDismissed && (
                            <div
                                role="status"
                                data-testid="wsi-requested-slide-unavailable"
                                style={{
                                    position: 'absolute',
                                    top: 8,
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    zIndex: 120,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    padding: '6px 10px',
                                    borderRadius: 3,
                                    color: C.text,
                                    background: '#fcf8e3',
                                    border: '1px solid #faebcc',
                                    boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                                    fontSize: 12,
                                }}
                            >
                                <span>
                                    The requested slide is not available.
                                    Showing the default slide instead.
                                </span>
                                <button
                                    type="button"
                                    className="close"
                                    aria-label="Dismiss"
                                    onClick={this.dismissRequestedSlideNotice}
                                    style={{ float: 'none', fontSize: 16 }}
                                >
                                    &times;
                                </button>
                            </div>
                        )}
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
                            showDownload={!!this.props.showDownload}
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

                {this.metadataCollapsed ? (
                    <WsiCollapsedRail
                        side="right"
                        title="Details"
                        showLabel="Show image details"
                        onExpand={this.showMetadata}
                        background={C.sidebarBg}
                        testId="wsi-metadata-rail"
                    />
                ) : (
                    <>
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
                                    boxShadow:
                                        '4px 0 0 #c3c3c3, -4px 0 0 #c3c3c3',
                                }}
                            />
                        </div>

                        {/* Right metadata sidebar */}
                        <WsiMetaSidebar
                            seqRows={this.sidebarSeqRowsForRender}
                            sample={this.sidebarImpactSample}
                            mutationDataStatus={this.mutationDataStatus}
                            dataVersion={this.hierarchyDataVersion}
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
                                this.annotationController
                                    .visibleAnnotationCount +
                                ')'
                            }
                            agentPanel={
                                this.props.agentEnabled ? (
                                    <WsiAgentPanel
                                        apiUrl={
                                            this.props.annotationApiUrl || ''
                                        }
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
                            clinicalRows={this.selectedClinicalRows}
                            onHide={this.hideMetadata}
                        />
                    </>
                )}
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
