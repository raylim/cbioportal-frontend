import { assert } from 'chai';
import { getLineChartAxisTickKey } from './LineChartAxis';
import { getMinorTimelineTickKey, getTimelineTickKey } from './TickAxis';
import { TimelineTick, TimelineTrackSpecification } from './types';

describe('axis key helpers', () => {
    it('builds stable line-chart axis tick keys from track uid and tick position', () => {
        const track = {
            uid: 'line-track',
            type: 'MEASUREMENTS',
            items: [],
        } as TimelineTrackSpecification;

        assert.equal(
            getLineChartAxisTickKey(track, { label: '5', offset: 18 }),
            'line-track:5:18'
        );
    });

    it('builds stable major timeline tick keys from tick content', () => {
        const tick: TimelineTick = {
            start: 0,
            end: 29,
            offset: 12,
            isTrim: false,
        };

        assert.equal(getTimelineTickKey(tick, 0), '0:0:29::12:0');
    });

    it('builds stable minor timeline tick keys from parent tick and pixel position', () => {
        assert.equal(
            getMinorTimelineTickKey('0:0:29::12:0', 4, 128),
            '0:0:29::12:0:minor:4:128'
        );
    });
});
