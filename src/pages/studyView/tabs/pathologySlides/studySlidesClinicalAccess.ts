import _ from 'lodash';
import { DataFilterValue } from 'cbioportal-ts-api-client';
import { getPriorityByClinicalAttribute } from 'pages/studyView/StudyViewUtils';
import { StudyViewPageStore } from 'pages/studyView/StudyViewPageStore';
import { StudySlidesClinicalAccess } from './StudyPathologySlidesStore';

/**
 * The study view's categorical clinical filters, for the Pathology Slides
 * tab: a filter set from the tab is the study view's own filter.
 */
export function studySlidesClinicalAccess(
    store: StudyViewPageStore
): StudySlidesClinicalAccess {
    return {
        getAttributes: () =>
            _.uniqBy(
                _.sortBy(
                    (store.clinicalAttributes.result || []).filter(
                        a => a.datatype === 'STRING'
                    ),
                    a => -getPriorityByClinicalAttribute(a)
                ),
                a => a.clinicalAttributeId
            ).map(a => ({
                attributeId: a.clinicalAttributeId,
                displayName: a.displayName,
            })),
        getFilters: () =>
            store.clinicalDataFilters
                .map(f => ({
                    attributeId: f.attributeId,
                    values: f.values
                        .map(v => v.value)
                        .filter((v): v is string => v !== undefined),
                }))
                // Numeric (range) filters are left to the study view.
                .filter(f => f.values.length > 0),
        setFilterValues: (attributeId, values) =>
            store.updateClinicalAttributeFilterByValues(
                attributeId,
                values.map(value => ({ value } as DataFilterValue))
            ),
    };
}
