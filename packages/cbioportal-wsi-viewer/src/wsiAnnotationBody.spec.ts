import {
    acceptedProvenance,
    isAssistantProvenance,
    isUnreviewedAssistant,
    isLegacyLayerComment,
    readLayerAndNote,
    serviceColor,
} from './wsiAnnotationBody';

describe('wsiAnnotationBody', () => {
    it('reads a legacy layer only from rows with the service defaults', () => {
        // Old rows: no layer_name or color sent, so the service stored its
        // defaults, and the layer is in comment.
        expect(
            isLegacyLayerComment({
                comment: 'Tumor',
                layer_name: 'Default',
                color: '#2f80ed',
            })
        ).toBe(true);
        expect(isLegacyLayerComment({ comment: 'Tumor' })).toBe(true);
        // Rows this viewer writes always carry a color.
        expect(
            isLegacyLayerComment({
                comment: 'Tumor',
                layer_name: 'Default',
                color: '#3b82f6',
            })
        ).toBe(false);
        expect(
            isLegacyLayerComment({
                comment: 'Tumor',
                layer_name: 'Default',
                color: '#2F80ED',
            })
        ).toBe(false);
        expect(
            isLegacyLayerComment({ comment: 'Note', layer_name: 'Stroma' })
        ).toBe(false);
        // A comment that cannot be a layer name.
        expect(isLegacyLayerComment({ comment: 'line 1\nline 2' })).toBe(false);
        expect(isLegacyLayerComment({ comment: 'x'.repeat(101) })).toBe(false);
        expect(isLegacyLayerComment({ comment: '  ' })).toBe(false);
        expect(isLegacyLayerComment(null)).toBe(false);
    });

    it('splits the layer and the note', () => {
        expect(
            readLayerAndNote({ comment: ' Stroma ', color: '#2f80ed' })
        ).toEqual({ layerName: 'Stroma', note: '' });
        expect(
            readLayerAndNote({
                comment: 'Mitoses here',
                layer_name: 'Tumor',
                color: '#ef4444',
            })
        ).toEqual({ layerName: 'Tumor', note: 'Mitoses here' });
        // Assistant rows copy the layer into comment.
        expect(
            readLayerAndNote({
                comment: 'AI review',
                layer_name: 'AI review',
                color: '#ef4444',
            })
        ).toEqual({ layerName: 'AI review', note: '' });
        expect(readLayerAndNote({ layer_name: '', color: '#fff' })).toEqual({
            layerName: 'Default',
            note: '',
        });
        expect(readLayerAndNote(undefined)).toEqual({
            layerName: 'Default',
            note: '',
        });
    });

    it('never writes the service default color in its legacy spelling', () => {
        expect(serviceColor('#2f80ed')).toBe('#2F80ED');
        expect(serviceColor('#2F80ed')).toBe('#2F80ED');
        expect(serviceColor('#ef4444')).toBe('#ef4444');
    });

    it('recognizes assistant provenance and its review', () => {
        const agent = { source: 'agent', proposal_id: 'p1' };
        expect(isAssistantProvenance(agent)).toBe(true);
        expect(isAssistantProvenance({ source: 'user' })).toBe(false);
        expect(isAssistantProvenance(null)).toBe(false);
        expect(isUnreviewedAssistant(agent)).toBe(true);

        const accepted = acceptedProvenance(
            agent,
            new Date('2026-11-16T12:00:00Z')
        );
        expect(accepted).toEqual({
            source: 'agent',
            proposal_id: 'p1',
            review_status: 'accepted',
            reviewed_at: '2026-11-16T12:00:00.000Z',
        });
        expect(isUnreviewedAssistant(accepted)).toBe(false);
        expect(isAssistantProvenance(accepted)).toBe(true);
    });
});
