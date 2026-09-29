import * as React from 'react';
import {
    PathologySlideFilter,
    readWsiHashState,
    WsiStainFilter,
} from 'cbioportal-wsi-viewer';
import {
    AppWsiViewer,
    AppWsiViewerProps,
} from 'shared/components/wsiViewer/wsiAppConfig';

/** Patient view query params that scope the Pathology Slides tab. */
export interface WsiSlidesTabQuery {
    sampleId?: string;
    stainFilter?: string;
    matchLevel?: string;
    specimenKey?: string;
}

export type WsiSlidesTabScope = Pick<
    AppWsiViewerProps,
    'preferredSampleId' | 'pathologyFilter' | 'initialStainFilter'
>;

function queryValue(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * Maps pathology slide link params (`sampleId`, `matchLevel`, `specimenKey`,
 * `stainFilter`) to viewer props. A slide named by a `#wsi:slide=` hash
 * wins: the link scope and stain filter are dropped so they cannot exclude
 * or hide that slide.
 */
export function wsiSlidesTabScopeFromQuery(
    query: WsiSlidesTabQuery,
    hashSlideId?: string
): WsiSlidesTabScope {
    const sampleId = queryValue(query.sampleId);
    if (hashSlideId) {
        return { preferredSampleId: sampleId };
    }
    const matchLevel = queryValue(query.matchLevel);
    const specimenKey = queryValue(query.specimenKey);
    const stain = queryValue(query.stainFilter)?.toLowerCase();
    const pathologyFilter: PathologySlideFilter | undefined =
        matchLevel || specimenKey
            ? { sampleId, matchLevel, specimenKey }
            : undefined;
    const initialStainFilter: WsiStainFilter | undefined =
        stain === 'hne' || stain === 'ihc' ? stain : undefined;
    return {
        preferredSampleId: sampleId,
        pathologyFilter,
        initialStainFilter,
    };
}

type Props = Omit<AppWsiViewerProps, keyof WsiSlidesTabScope> & {
    query: WsiSlidesTabQuery;
};

/** Pathology Slides tab: the viewer scoped by the patient view URL. */
export default function PatientWsiSlidesTab({ query, ...viewerProps }: Props) {
    const { sampleId, stainFilter, matchLevel, specimenKey } = query;
    // The hash is read when the link params change, not on every hash
    // update, because the viewer rewrites it as the user moves around.
    const scope = React.useMemo(
        () =>
            wsiSlidesTabScopeFromQuery(
                { sampleId, stainFilter, matchLevel, specimenKey },
                readWsiHashState()?.slideId
            ),
        [sampleId, stainFilter, matchLevel, specimenKey]
    );
    return <AppWsiViewer {...viewerProps} {...scope} />;
}
