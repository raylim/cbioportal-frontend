import * as React from 'react';
import WSIViewer, { WsiViewerProps as ViewerProps } from './WSIViewer';
import { getWsiViewerRuntime } from './wsiViewerConfig';

/** The viewer's props; the annotation service comes from the runtime. */
export type WsiViewerProps = Omit<ViewerProps, 'annotationApiUrl'>;

/**
 * Patient slide viewer, with annotation authoring when the runtime
 * configures an annotation service.
 */
export default function WsiViewer(props: WsiViewerProps) {
    return (
        <WSIViewer
            {...props}
            annotationApiUrl={getWsiViewerRuntime().annotations?.apiUrl}
        />
    );
}
