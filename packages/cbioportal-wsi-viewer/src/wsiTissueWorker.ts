/**
 * The tissue selection Web Worker: holds prepared rasters and runs the magic
 * wand and the smart brush on them (`wsiTissueCore.ts`), off the main
 * thread. Bundled inline by rollup-plugin-web-worker-loader
 * (`web-worker:./wsiTissueWorker`); see `wsiTissueEngine.ts` for the
 * messages.
 */
import { handleTissueMessage, WsiTissueEngineState } from './wsiTissueCompute';

const state: WsiTissueEngineState = { rasters: new Map() };
const scope: any = self;

scope.onmessage = (event: MessageEvent) => {
    const message = event.data;
    try {
        const result = handleTissueMessage(state, message);
        scope.postMessage({ id: message.id, result });
    } catch (error) {
        scope.postMessage({
            id: message.id,
            error: String((error as Error)?.message || error),
        });
    }
};
