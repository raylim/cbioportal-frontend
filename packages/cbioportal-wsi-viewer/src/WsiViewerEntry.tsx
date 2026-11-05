import * as React from 'react';
import WSIViewer, { WsiViewerProps as ViewerProps } from './WSIViewer';
import { getWsiViewerRuntime } from './wsiViewerConfig';

/** The viewer's props; the annotation and agent services come from the runtime. */
export type WsiViewerProps = Omit<
    ViewerProps,
    'annotationApiUrl' | 'agentEnabled'
>;

/**
 * Patient slide viewer, with annotation authoring and the slide agent when
 * the runtime configures them.
 */
export default function WsiViewer(props: WsiViewerProps) {
    return (
        <WSIViewer
            {...props}
            annotationApiUrl={getWsiViewerRuntime().annotations?.apiUrl}
            agentEnabled={
                !!getWsiViewerRuntime().agent?.enabled &&
                !!getWsiViewerRuntime().annotations?.apiUrl
            }
        />
    );
}
