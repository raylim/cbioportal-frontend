import {
    acceptedProvenance,
    aiOrigin,
    aiOriginDescription,
    annotationHistory,
    derivedProvenance,
    editedProvenance,
    isAiProvenance,
    isEditedAi,
    isRejectedAi,
    isUnreviewedAi,
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

    it('reads a note from another writer as a note, not a legacy layer', () => {
        // The service fills a missing layer_name and color with its
        // defaults, so only provenance tells these rows from legacy ones.
        const scripted = {
            comment: 'Check the margin',
            layer_name: 'Default',
            color: '#2f80ed',
            provenance: { source: 'script' },
        };
        expect(isLegacyLayerComment(scripted)).toBe(false);
        expect(readLayerAndNote(scripted)).toEqual({
            layerName: 'Default',
            note: 'Check the margin',
        });
        expect(
            isLegacyLayerComment({
                comment: 'Tumor',
                provenance: { source: 'agent' },
            })
        ).toBe(false);
        expect(
            isLegacyLayerComment({ comment: 'Tumor', provenance: null })
        ).toBe(true);
    });

    it('splits the layer and the note', () => {
        expect(
            readLayerAndNote({ comment: ' Stroma ', color: '#2f80ed' })
        ).toEqual({
            layerName: 'Stroma',
            note: '',
            legacyComment: ' Stroma ',
        });
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

    it('recognizes assistant provenance and its acceptance', () => {
        const agent = { source: 'agent', proposal_id: 'p1' };
        expect(isAiProvenance(agent)).toBe(true);
        expect(isAiProvenance({ source: 'user' })).toBe(false);
        expect(isAiProvenance(null)).toBe(false);
        expect(isUnreviewedAi(agent)).toBe(true);

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
        expect(isUnreviewedAi(accepted)).toBe(false);
        expect(isAiProvenance(accepted)).toBe(true);
    });

    it('treats model output as AI and says which kind made it', () => {
        expect(aiOrigin({ source: 'agent' })).toBe('assistant');
        expect(aiOrigin({ source: 'Assistant' })).toBe('assistant');
        expect(aiOrigin({ source: 'precomputed' })).toBe('model');
        expect(aiOrigin({ source: 'model' })).toBe('model');
        expect(aiOrigin({ source: ' AI ' })).toBe('model');
        expect(aiOrigin({ source: 'user' })).toBeNull();
        expect(aiOrigin({ source: 3 })).toBeNull();
        expect(aiOrigin(undefined)).toBeNull();

        const model = { source: 'precomputed', model: 'luad-patterns' };
        expect(isAiProvenance(model)).toBe(true);
        expect(isUnreviewedAi(model)).toBe(true);
        expect(aiOriginDescription(model)).toBe(
            'Made by a model (luad-patterns)'
        );
        expect(aiOriginDescription({ source: 'model' })).toBe(
            'Made by a model'
        );
        expect(aiOriginDescription({ source: 'agent' })).toBe(
            'Made by the research assistant'
        );
        expect(aiOriginDescription({ source: 'user' })).toBeNull();
    });

    it('counts a rejected AI annotation as reviewed, and as rejected', () => {
        const rejected = { source: 'precomputed', review_status: 'rejected' };
        expect(isUnreviewedAi(rejected)).toBe(false);
        expect(isRejectedAi(rejected)).toBe(true);
        expect(isRejectedAi({ source: 'precomputed' })).toBe(false);
        expect(isRejectedAi({ review_status: 'rejected' })).toBe(false);
    });

    it('marks AI annotations a person changed as "AI, edited"', () => {
        const agent = { source: 'agent', review_status: 'accepted' };
        expect(editedProvenance(agent)).toEqual({ ...agent, edited: true });
        expect(isEditedAi(editedProvenance(agent))).toBe(true);
        // A person's annotation keeps its provenance, and has none added.
        expect(editedProvenance(null)).toBeNull();
        expect(editedProvenance({ source: 'manual' })).toEqual({
            source: 'manual',
        });
        expect(isEditedAi({ source: 'manual', edited: true })).toBe(false);
        const derived = derivedProvenance('merge', [
            { id: 'a', provenance: agent },
            { id: 'b', provenance: null },
        ]);
        expect(derived).toEqual({
            source: 'manual',
            operation: 'merge',
            derived_from: ['a', 'b'],
            derived_from_ai: true,
        });
        // Not machine-made, so the service lets a user create it.
        expect(isAiProvenance(derived)).toBe(false);
        expect(isEditedAi(derived)).toBe(true);
        // Made from an edited AI annotation, it is still from AI.
        expect(
            derivedProvenance('split', [{ id: 'c', provenance: derived }])
                .derived_from_ai
        ).toBe(true);
        expect(
            derivedProvenance('cut', [{ id: 'd', provenance: null }])
        ).toEqual({ source: 'manual', operation: 'cut', derived_from: ['d'] });
        expect(
            annotationHistory({ creator: 'me', provenance: derived })[0].what
        ).toBe('Created (merge of 2 annotations, from AI)');
        expect(
            annotationHistory({
                creator: 'me',
                provenance: { source: 'agent', edited: true },
            }).map(entry => entry.what)
        ).toEqual([
            'Created (by the research assistant)',
            'Shape edited by a person (AI, edited)',
        ]);
    });
});
