import { expect, test } from '../fixtures';
import {
    IMAGE_ID,
    installFoundationMocks,
    PATIENT_ID,
    STUDY_ID,
} from './wsi-foundation-mocks';

test('loads annotation layers and commits an agent proposal in the viewer', async ({
    page,
}) => {
    await installFoundationMocks(page, {
        enableAnnotations: true,
        enableAgent: true,
    });

    await page.route('**/api/wsi/access-token*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                access_token: 'agent-capability-token',
                token_type: 'Bearer',
                expires_in: 300,
            }),
        })
    );

    await page.route('**/wsi/annotations*', async route => {
        if (route.request().method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: '[]',
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: 'annotation-agent-1',
                slide_id: IMAGE_ID,
                study_id: STUDY_ID,
                body: {
                    label: 'AI tumor region',
                    comment: 'AI review',
                    type: 'AI review|#ef4444',
                },
                target: {
                    selector: {
                        type: 'SvgSelector',
                        value:
                            '<svg><rect x="100" y="100" width="100" height="100" /></svg>',
                    },
                },
                created_by: 'e2e-user',
                version: 1,
            }),
        });
    });

    await page.route('**/wsi/agent/chat', async route => {
        const request = JSON.parse(route.request().postData() || '{}') as {
            context: {
                slide_id: string;
                study_id: string;
                viewport: {
                    source_fingerprint: string;
                    capture_id: string;
                    viewer_generation: number;
                };
            };
            session_id: string;
        };
        const viewport = request.context.viewport;
        const proposal = {
            id: 'proposal-agent-1',
            session_id: request.session_id,
            action_type: 'create_annotation',
            study_id: request.context.study_id,
            slide_id: request.context.slide_id,
            payload: {
                label: 'AI tumor region',
                layer_name: 'AI review',
                color: '#ef4444',
                rationale: 'Mocked visual evidence for the browser contract.',
                geometry_type: 'rectangle',
                points: [
                    { x: 100, y: 100 },
                    { x: 200, y: 200 },
                ],
                geometry_version: 2,
                coordinate_space: 'slide_pixels',
                source_fingerprint: viewport.source_fingerprint,
                capture_id: viewport.capture_id,
                viewer_generation: viewport.viewer_generation,
            },
            status: 'pending',
            created_at: new Date().toISOString(),
        };
        const body = [
            'event: message.delta',
            'data: {"text":"I found a candidate region."}',
            '',
            'event: proposal',
            `data: ${JSON.stringify(proposal)}`,
            '',
            'event: complete',
            'data: {"success":true}',
            '',
        ].join('\n');
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
        });
    });

    await page.route(
        '**/wsi/agent/actions/proposal-agent-1/commit-annotations',
        route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    action: {
                        id: 'proposal-agent-1',
                        session_id: 'browser-e2e',
                        action_type: 'create_annotation',
                        study_id: STUDY_ID,
                        slide_id: IMAGE_ID,
                        payload: {},
                        status: 'completed',
                        created_at: new Date().toISOString(),
                    },
                    annotations: [
                        {
                            id: 'annotation-agent-1',
                            slide_id: IMAGE_ID,
                            study_id: STUDY_ID,
                            body: {
                                label: 'AI tumor region',
                                comment: 'AI review',
                                type: 'AI review|#ef4444',
                            },
                            target: {
                                selector: {
                                    type: 'SvgSelector',
                                    value:
                                        '<svg><rect x="100" y="100" width="100" height="100" /></svg>',
                                },
                            },
                            created_by: 'e2e-user',
                            version: 1,
                        },
                    ],
                }),
            })
    );

    await page.goto(
        `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${IMAGE_ID}&x=256&y=256&z=0.75`
    );

    await expect(
        page.getByTestId('wsi-filtered-slide-count')
    ).toHaveText('Showing 1 slide', { timeout: 30_000 });
    await expect(page.getByTestId('wsi-annotation-layers')).toBeVisible();
    await expect(page.getByTestId('wsi-agent-panel')).toBeVisible();
    await expect(page.getByLabel('Ask the research assistant')).toBeVisible();

    await page.getByLabel('Ask the research assistant').fill('Mark the tumor');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(
        page.getByTestId('wsi-agent-proposal-proposal-agent-1')
    ).toBeVisible({
        timeout: 30_000,
    });
    await expect(page.getByText('Auto-approve')).toBeVisible();
    await page.getByTestId('wsi-agent-apply-proposal-agent-1').click();
    await expect(
        page.getByTestId('annotation-row-annotation-agent-1')
    ).toBeVisible({
        timeout: 30_000,
    });
    await expect(page.getByText('AI tumor region')).toBeVisible();
});

test('applies an approved navigation proposal to the native viewer', async ({
    page,
}) => {
    await installFoundationMocks(page, {
        enableAnnotations: true,
        enableAgent: true,
    });

    await page.route('**/api/wsi/access-token*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                access_token: 'agent-capability-token',
                token_type: 'Bearer',
                expires_in: 300,
            }),
        })
    );

    await page.route('**/wsi/annotations*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '[]',
        })
    );
    let navigationContext: Record<string, unknown>;
    await page.route('**/wsi/agent/chat', async route => {
        const request = JSON.parse(route.request().postData() || '{}') as {
            context: {
                slide_id: string;
                study_id: string;
                patient_id: string;
                viewport: {
                    source_fingerprint: string;
                    viewer_generation: number;
                };
            };
            session_id: string;
        };
        navigationContext = request.context;
        const proposal = {
            id: 'proposal-navigation-1',
            session_id: request.session_id,
            action_type: 'viewer_action',
            study_id: request.context.study_id,
            slide_id: request.context.slide_id,
            payload: {
                action: 'go_to_coordinates',
                parameters: { x: 100, y: 120 },
                context: {
                    study_id: request.context.study_id,
                    patient_id: request.context.patient_id,
                    slide_id: request.context.slide_id,
                    viewport: request.context.viewport,
                },
                rationale: 'Move to the requested region.',
            },
            status: 'pending',
            created_at: new Date().toISOString(),
        };
        const body = [
            'event: message.delta',
            'data: {"text":"I will move the viewer."}',
            '',
            'event: proposal',
            `data: ${JSON.stringify(proposal)}`,
            '',
            'event: complete',
            'data: {"success":true}',
            '',
        ].join('\n');
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
        });
    });
    await page.route(
        '**/wsi/agent/actions/proposal-navigation-1/apply',
        route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    id: 'proposal-navigation-1',
                    session_id: 'browser-e2e',
                    action_type: 'viewer_action',
                    study_id: STUDY_ID,
                    slide_id: IMAGE_ID,
                    payload: {
                        action: 'go_to_coordinates',
                        parameters: { x: 100, y: 120 },
                        context: navigationContext,
                    },
                    status: 'approved',
                    created_at: new Date().toISOString(),
                }),
            })
    );
    await page.route(
        '**/wsi/agent/actions/proposal-navigation-1/complete',
        route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    id: 'proposal-navigation-1',
                    session_id: 'browser-e2e',
                    action_type: 'viewer_action',
                    study_id: STUDY_ID,
                    slide_id: IMAGE_ID,
                    payload: {
                        action: 'go_to_coordinates',
                        parameters: { x: 100, y: 120 },
                        context: navigationContext,
                    },
                    status: 'completed',
                    created_at: new Date().toISOString(),
                    outcome: {
                        success: true,
                        detail: 'Coordinates updated.',
                    },
                }),
            })
    );

    await page.goto(
        `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${IMAGE_ID}`
    );
    await expect(page.getByTestId('wsi-agent-panel')).toBeVisible();
    await page.getByLabel('Ask the research assistant').fill('Go to 100, 120');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(
        page.getByTestId('wsi-agent-proposal-proposal-navigation-1')
    ).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('wsi-agent-apply-proposal-navigation-1').click();
    await expect(page.locator('input[type="number"]').nth(0)).toHaveValue(
        '100'
    );
    await expect(page.locator('input[type="number"]').nth(1)).toHaveValue(
        '120'
    );
});
