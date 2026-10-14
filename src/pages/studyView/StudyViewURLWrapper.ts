import URLWrapper from '../../shared/lib/URLWrapper';
import { StudyViewPageTabKey, StudyViewURLQuery } from './StudyViewPageStore';
import { PagePath } from '../../shared/enums/PagePaths';
import { computed, makeObservable } from 'mobx';
import { StudyViewPageTabKeyEnum } from './StudyViewPageTabs';
import ExtendedRouterStore from '../../shared/lib/ExtendedRouterStore';
import {
    PLOTS_TAB_URL_PARAMS,
    PlotsColoringParamProps,
} from 'shared/components/plots/PlotsTabUrlParameters';

export default class StudyViewURLWrapper extends URLWrapper<
    Pick<
        StudyViewURLQuery,
        | 'tab'
        | 'resourceUrl'
        | 'wsiStudyId'
        | 'wsiPatientId'
        | 'wsiView'
        | 'wsiStain'
        | 'wsiMatch'
        | 'wsiSearch'
        | 'plots_horz_selection'
        | 'plots_vert_selection'
        | 'plots_coloring_selection'
        | 'embeddings_coloring_selection'
        | 'embeddings_map'
        | 'embeddings_tooltip_fields'
        | 'embeddings_legend_collapsed'
        | 'embeddings_panel2_coloring_selection'
        | 'embeddings_panel2_map'
        | 'embeddings_panel2_legend_collapsed'
        | 'embeddings_panel3_coloring_selection'
        | 'embeddings_panel3_map'
        | 'embeddings_panel3_legend_collapsed'
        | 'embeddings_panel4_coloring_selection'
        | 'embeddings_panel4_map'
        | 'embeddings_panel4_legend_collapsed'
        | 'geneset_list'
        | 'generic_assay_groups'
    >
> {
    constructor(routing: ExtendedRouterStore) {
        super(routing, {
            tab: { isSessionProp: false },
            resourceUrl: { isSessionProp: false },
            wsiStudyId: { isSessionProp: false },
            wsiPatientId: { isSessionProp: false },
            wsiView: { isSessionProp: false },
            wsiStain: { isSessionProp: false },
            wsiMatch: { isSessionProp: false },
            wsiSearch: { isSessionProp: false },
            ...PLOTS_TAB_URL_PARAMS,
            embeddings_coloring_selection: {
                isSessionProp: false,
                nestedObjectProps: PlotsColoringParamProps,
            },
            embeddings_map: { isSessionProp: false },
            embeddings_tooltip_fields: { isSessionProp: false },
            embeddings_legend_collapsed: { isSessionProp: false },
            embeddings_panel2_coloring_selection: {
                isSessionProp: false,
                nestedObjectProps: PlotsColoringParamProps,
            },
            embeddings_panel2_map: { isSessionProp: false },
            embeddings_panel2_legend_collapsed: { isSessionProp: false },
            embeddings_panel3_coloring_selection: {
                isSessionProp: false,
                nestedObjectProps: PlotsColoringParamProps,
            },
            embeddings_panel3_map: { isSessionProp: false },
            embeddings_panel3_legend_collapsed: { isSessionProp: false },
            embeddings_panel4_coloring_selection: {
                isSessionProp: false,
                nestedObjectProps: PlotsColoringParamProps,
            },
            embeddings_panel4_map: { isSessionProp: false },
            embeddings_panel4_legend_collapsed: { isSessionProp: false },
            geneset_list: { isSessionProp: true },
            generic_assay_groups: { isSessionProp: false },
        });
        makeObservable(this);
    }

    public setTab(tab: string): void {
        this.updateURL({}, `${PagePath.Study}/${tab}`);
    }

    @computed public get tabId(): StudyViewPageTabKey {
        const regex = new RegExp(`${PagePath.Study}\/(.+)`);
        const regexMatch = regex.exec(this.pathName);
        const tabInPath = regexMatch && regexMatch[1];
        return (
            (tabInPath as StudyViewPageTabKey | undefined) ||
            StudyViewPageTabKeyEnum.SUMMARY
        );
    }

    public setResourceUrl(resourceUrl: string) {
        this.updateURL({ resourceUrl });
    }

    /**
     * Updates the query and keeps the page's hash. The router rebuilds the
     * URL with its own copy of the hash, which is stale once the slide viewer
     * has written its `#wsi:` state straight to the browser history.
     */
    private updateWsiURL(params: Partial<StudyViewURLQuery>, replace: boolean) {
        const hash = window.location.hash;
        this.updateURL(params, undefined, false, replace);
        if (window.location.hash !== hash) {
            const url = new URL(window.location.href);
            url.hash = hash;
            window.history.replaceState(
                window.history.state,
                '',
                url.toString()
            );
        }
    }

    /** Records the Pathology Slides tab's view; the viewer is the default. */
    public setWsiView(view: 'viewer' | 'table') {
        this.updateWsiURL(
            { wsiView: view === 'table' ? 'table' : undefined },
            true
        );
    }

    /**
     * Records the Pathology Slides tab's patient. Moving to another patient
     * gets its own history entry, so Back returns to the previous one.
     */
    public setWsiPatient(
        patient: { studyId: string; patientId: string } | undefined,
        push: boolean
    ) {
        this.updateWsiURL(
            {
                wsiStudyId: patient?.studyId,
                wsiPatientId: patient?.patientId,
            },
            !push
        );
    }

    /** Records the Pathology Slides tab's list filters, replacing the history entry. */
    public setWsiSlideFilters(filters: {
        stainGroups: string[];
        matchLevels: string[];
        search: string;
    }) {
        this.updateWsiURL(
            {
                wsiStain: filters.stainGroups.join(',') || undefined,
                wsiMatch: filters.matchLevels.join(',') || undefined,
                wsiSearch: filters.search || undefined,
            },
            true
        );
    }
}
