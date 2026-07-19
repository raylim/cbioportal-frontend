// react-markdown is ESM-only and incompatible with Jest's CJS transform;
// mock it to avoid a transform error. It is not exercised by these tests.
jest.mock('react-markdown', () => () => null);

import { assert } from 'chai';
import * as React from 'react';
import { mount } from 'enzyme';
import CustomTrack, { CustomTrackSpecification } from './CustomTrack';
import CustomTrackHeader from './CustomTrackHeader';
import { TimelineStore } from './TimelineStore';

function makeStore() {
    return new TimelineStore([
        {
            items: [
                {
                    start: 0,
                    end: 0,
                    event: {
                        attributes: [],
                        eventType: 'SPECIMEN',
                        patientId: 'P-001',
                        startNumberOfDaysSinceDiagnosis: 0,
                        studyId: 'study-1',
                        uniquePatientKey: 'event-1',
                    },
                    containingTrack: undefined as any,
                },
            ],
            type: 'SPECIMEN',
            uid: 'track-1',
        } as any,
    ]);
}

function makeSpecification(
    height: jest.Mock<number, [TimelineStore]>
): CustomTrackSpecification {
    return {
        height,
        labelForExport: 'Custom',
        renderHeader: () => <span>Header</span>,
        renderTrack: () => <g />,
    };
}

describe('CustomTrack', () => {
    it('computes custom track height only once per render', () => {
        const store = makeStore();
        const height = jest
            .fn<number, [TimelineStore]>()
            .mockReturnValue(25);
        const specification = makeSpecification(height);

        mount(
            <svg>
                <CustomTrack
                    store={store}
                    specification={specification}
                    width={500}
                    y={0}
                    handleTrackHover={() => {}}
                />
            </svg>
        );

        assert.equal(height.mock.calls.length, 1);
    });

    it('computes custom track header height only once per render', () => {
        const store = makeStore();
        const height = jest
            .fn<number, [TimelineStore]>()
            .mockReturnValue(30);
        const specification = makeSpecification(height);

        mount(
            <CustomTrackHeader
                store={store}
                specification={specification}
                handleTrackHover={() => {}}
            />
        );

        assert.equal(height.mock.calls.length, 1);
    });
});
