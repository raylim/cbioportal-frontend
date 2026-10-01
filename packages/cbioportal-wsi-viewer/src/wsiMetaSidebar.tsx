import * as React from 'react';
import { Sample, WsiMutationDataStatus } from './wsiViewerTypes';
import {
    CnaTable,
    MutationTable,
    StructuralVariantTable,
} from './wsiMolecularTables';

import { WSI_SECTION_TITLE_STYLE, WSI_THEME } from './wsiTheme';
import { WsiPanelHideButton } from './wsiPanelChrome';

const SIDEBAR_COLORS = WSI_THEME;
const sectionTitleStyle = WSI_SECTION_TITLE_STYLE;

const emptyStateStyle: React.CSSProperties = {
    color: '#bbb',
    fontSize: 11,
};

const linkedValueStyle: React.CSSProperties = {
    color: SIDEBAR_COLORS.blue,
    textDecoration: 'none',
};

export interface MetaRow {
    label: string;
    labelTip?: string;
    value: React.ReactNode;
    href?: string;
    valueTip?: string;
}

function SbSection({
    title,
    action,
    children,
}: {
    title: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div
            style={{
                padding: '10px 12px',
                borderBottom: `1px solid ${SIDEBAR_COLORS.border}`,
            }}
        >
            {action ? (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}
                >
                    <div style={sectionTitleStyle}>{title}</div>
                    {action}
                </div>
            ) : (
                <div style={sectionTitleStyle}>{title}</div>
            )}
            {children}
        </div>
    );
}

function EmptyState({ children = '—' }: { children?: React.ReactNode }) {
    return <span style={emptyStateStyle}>{children}</span>;
}

function renderMetaValue(row: MetaRow) {
    if (!row.href) {
        return row.value || '—';
    }

    return (
        <a
            href={row.href}
            target="_blank"
            rel="noopener noreferrer"
            style={linkedValueStyle}
            onMouseEnter={event => {
                (event.currentTarget as HTMLAnchorElement).style.textDecoration =
                    'underline';
            }}
            onMouseLeave={event => {
                (event.currentTarget as HTMLAnchorElement).style.textDecoration =
                    'none';
            }}
        >
            {row.value || '—'}
        </a>
    );
}

function hasMskImpactContent(
    sample: Sample | null,
    seqRows: MetaRow[],
    mutationDataStatus: WsiMutationDataStatus
) {
    return (
        seqRows.length > 0 ||
        !!(
            sample?.oncogenic_mutations &&
            sample.oncogenic_mutation_details !== undefined
        ) ||
        !!sample?.cna_alterations?.length ||
        !!sample?.structural_variants?.length ||
        (sample !== null && mutationDataStatus === 'loading') ||
        (sample !== null && mutationDataStatus === 'error')
    );
}

function MetaTable({ rows }: { rows: MetaRow[] }) {
    return (
        <table
            style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}
        >
            <tbody>
                {rows.map(row => (
                    <tr key={row.label}>
                        <td
                            title={row.labelTip}
                            style={{
                                fontSize: 11,
                                color: SIDEBAR_COLORS.muted,
                                width: '50%',
                                paddingRight: 5,
                                paddingTop: 2,
                                paddingBottom: 2,
                                verticalAlign: 'top',
                                lineHeight: 1.5,
                                cursor: row.labelTip ? 'help' : undefined,
                                borderBottom: row.labelTip
                                    ? `1px dotted ${SIDEBAR_COLORS.border}`
                                    : undefined,
                            }}
                        >
                            {row.label}
                        </td>
                        <td
                            title={row.valueTip}
                            style={{
                                fontSize: 11,
                                color: SIDEBAR_COLORS.text,
                                fontWeight: 500,
                                wordBreak: 'break-word',
                                verticalAlign: 'top',
                                lineHeight: 1.5,
                                cursor: row.valueTip ? 'help' : undefined,
                            }}
                        >
                            {renderMetaValue(row)}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function WsiMetaSidebarComponent({
    width,
    showImageProperties,
    wsiRows,
    showPathology,
    pathRows,
    seqRows,
    sample,
    mutationDataStatus,
    dataVersion,
    annotationLayersPanel,
    annotationPanel,
    annotationPanelTitle,
    agentPanel,
    onHide,
}: {
    width: number;
    showImageProperties: boolean;
    wsiRows: MetaRow[];
    showPathology: boolean;
    pathRows: MetaRow[];
    seqRows: MetaRow[];
    sample: Sample | null;
    mutationDataStatus: WsiMutationDataStatus;
    /** Invalidates the memoized sidebar when enrichment mutates a sample in place. */
    dataVersion?: number;
    annotationLayersPanel?: React.ReactNode;
    annotationPanel?: React.ReactNode;
    annotationPanelTitle?: string;
    agentPanel?: React.ReactNode;
    /** Shows a header button that hides the sidebar. */
    onHide?: () => void;
}) {
    // Keep the version in the component's props so React.memo observes
    // staged molecular/CNA/SV updates even when the sample object is mutated
    // in place to preserve hierarchy identity.
    void dataVersion;
    const showMskImpact = hasMskImpactContent(
        sample,
        seqRows,
        mutationDataStatus
    );

    return (
        <div
            data-testid="wsi-metadata-sidebar"
            style={{
                width,
                minWidth: width,
                background: SIDEBAR_COLORS.sidebarBg,
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
                flexShrink: 0,
            }}
        >
            <SbSection
                title="Image Properties"
                action={
                    onHide && (
                        <WsiPanelHideButton
                            side="right"
                            label="Hide image details"
                            onClick={onHide}
                            testId="wsi-metadata-hide"
                        />
                    )
                }
            >
                {showImageProperties ? (
                    <MetaTable rows={wsiRows} />
                ) : (
                    <EmptyState />
                )}
            </SbSection>

            <SbSection title="Pathology">
                {showPathology ? <MetaTable rows={pathRows} /> : <EmptyState />}
            </SbSection>

            {showMskImpact && (
                <SbSection title="MSK-IMPACT">
                    {seqRows.length > 0 && <MetaTable rows={seqRows} />}
                    {sample && (
                        <MutationTable
                            sample={sample}
                            mutationDataStatus={mutationDataStatus}
                        />
                    )}
                    {sample?.cna_alterations?.length ? (
                        <CnaTable sample={sample} />
                    ) : null}
                    {sample?.structural_variants?.length ? (
                        <StructuralVariantTable sample={sample} />
                    ) : null}
                </SbSection>
            )}
            {annotationLayersPanel && (
                <SbSection title="Layers">{annotationLayersPanel}</SbSection>
            )}
            {annotationPanel && (
                <SbSection title={annotationPanelTitle || 'Annotations'}>
                    {annotationPanel}
                </SbSection>
            )}
            {agentPanel && (
                <SbSection title="Research assistant">{agentPanel}</SbSection>
            )}
        </div>
    );
}

export const WsiMetaSidebar = React.memo(WsiMetaSidebarComponent);
