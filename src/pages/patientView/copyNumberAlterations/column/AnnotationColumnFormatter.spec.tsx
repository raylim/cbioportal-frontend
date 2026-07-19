import AnnotationColumnFormatter from './AnnotationColumnFormatter';
import React from 'react';
import { assert } from 'chai';
import { shallow, mount } from 'enzyme';
import sinon from 'sinon';
import * as oncoKbFrontendCommons from 'oncokb-frontend-commons';
import * as mutationMapper from 'react-mutation-mapper';

import {
    getCivicGenes,
    getCnaCivicVariants,
    getCnaData,
    getExpectedCnaCivicEntry,
    getCnaCivicEmptyVariants,
} from 'test/CivicMockUtils';

describe('AnnotationColumnFormatter', () => {
    it('properly creates a civic entry', () => {
        let civicGenes = getCivicGenes();

        let civicVariants = getCnaCivicVariants();

        let cna = getCnaData();

        let expectedCivicEntry = getExpectedCnaCivicEntry();

        assert.deepEqual(
            AnnotationColumnFormatter.getCivicEntry(
                cna,
                civicGenes,
                civicVariants
            ),
            expectedCivicEntry,
            'Equal Civic Entry'
        );
    });

    it('properly points that Civic has variants', () => {
        let civicGenes = getCivicGenes();

        let civicVariants = getCnaCivicVariants();

        let cna = getCnaData();

        assert.deepEqual(
            AnnotationColumnFormatter.hasCivicVariants(
                cna,
                civicGenes,
                civicVariants
            ),
            true,
            'Civic has variants'
        );
    });

    it('properly points that Civic has no variants', () => {
        let civicGenes = getCivicGenes();

        let civicVariants = getCnaCivicEmptyVariants();

        let cna = getCnaData();

        assert.deepEqual(
            AnnotationColumnFormatter.hasCivicVariants(
                cna,
                civicGenes,
                civicVariants
            ),
            false,
            'Civic has no variants'
        );
    });

    it('combines OncoKB and CIViC sort values with the cancer-gene flag', () => {
        const getDataStub = sinon
            .stub(AnnotationColumnFormatter, 'getData')
            .returns({
                oncoKbIndicator: {} as any,
                civicEntry: {} as any,
                isOncoKbCancerGene: true,
            } as any);
        const oncoKbSortStub = sinon
            .stub(oncoKbFrontendCommons, 'oncoKbAnnotationSortValue')
            .returns([7, 8]);
        const civicSortStub = sinon
            .stub(mutationMapper, 'civicSortValue')
            .returns([3, 4]);

        assert.deepEqual(AnnotationColumnFormatter.sortValue([] as any), [
            7,
            8,
            3,
            4,
            1,
        ]);

        getDataStub.restore();
        oncoKbSortStub.restore();
        civicSortStub.restore();
    });
});
