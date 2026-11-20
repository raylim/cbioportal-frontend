const fs = require('fs');
const path = require('path');

// A message string of OpenSeadragon's own code, kept by minification. The
// library name alone is not enough: the webpack runtime in an initial bundle
// names the wsi-openseadragon chunk.
const OPENSEADRAGON_MARKER = '[Viewer.addTiledImage]';
// OpenSeadragon defines its version object once per bundled copy.
const OSD_LIBRARY_MARKER = /versionStr\s*:\s*["'`]\d/;
// A class name from the Annotorious annotation layer.
const ANNOTORIOUS_MARKER = 'a9s-annotationlayer';
// A message of the magic wand (wsiTissueSelect.ts), in the wsi-tissue chunk.
const TISSUE_MARKER = 'The outline stops at the edge of the view';
// A message of polygon-clipping, which the shape operations
// (wsiAnnotationShapeOps.ts) load in the wsi-shapeops chunk.
const SHAPE_OPS_MARKER = 'Unable to complete output ring';
// The only chunks polygon-clipping may be in: the shape operations', or a
// chunk shared by them and the tissue tools.
const SHAPE_OPS_CHUNK = /^wsi-(shapeops|tissue)(?:\.|-)/;

function containsOpenSeadragon(bundle) {
    return bundle.includes(OPENSEADRAGON_MARKER);
}

function getInitialBundlePaths(distDir, indexHtml) {
    const initialBundleMatches = [
        ...indexHtml.matchAll(/src="\/(reactapp\/[^"]+\.js)"/g),
    ];
    return initialBundleMatches.map(match => path.join(distDir, match[1]));
}

function assertWsiOsdBundle(options = {}) {
    const distDir = options.distDir || path.join(__dirname, '..', 'dist');
    const reactAppDir = path.join(distDir, 'reactapp');
    const indexHtmlPath = path.join(distDir, 'index.html');

    if (!fs.existsSync(indexHtmlPath)) {
        throw new Error(`Missing frontend HTML entrypoint: ${indexHtmlPath}`);
    }

    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    const initialBundlePaths = getInitialBundlePaths(distDir, indexHtml);

    if (!initialBundlePaths.length) {
        throw new Error(
            `Could not find any initial frontend JS bundles in ${indexHtmlPath}`
        );
    }

    const bundleEntries = initialBundlePaths.map(bundlePath => {
        if (!fs.existsSync(bundlePath)) {
            throw new Error(`Missing frontend bundle: ${bundlePath}`);
        }

        return {
            bundlePath,
            bundle: fs.readFileSync(bundlePath, 'utf8'),
        };
    });

    const initialOsdBundle = bundleEntries.find(({ bundle }) =>
        containsOpenSeadragon(bundle)
    );
    if (initialOsdBundle) {
        throw new Error(
            `OpenSeadragon must only load in the asynchronous wsi-openseadragon chunk, but it is in the initial bundle ${initialOsdBundle.bundlePath}`
        );
    }

    const osdChunkNames = fs
        .readdirSync(reactAppDir)
        .filter(name => /^wsi-openseadragon(?:\.|-).*\.js$/.test(name));

    if (osdChunkNames.length !== 1) {
        throw new Error(
            `Expected one asynchronous wsi-openseadragon chunk in ${reactAppDir}, found ${osdChunkNames.length}`
        );
    }

    const osdBundlePath = path.join(reactAppDir, osdChunkNames[0]);
    if (!containsOpenSeadragon(fs.readFileSync(osdBundlePath, 'utf8'))) {
        throw new Error(
            `Expected OpenSeadragon in the wsi-openseadragon chunk ${osdBundlePath}`
        );
    }

    // The viewer and Annotorious both import OpenSeadragon. Each copy
    // outside the OpenSeadragon bundle doubles its download.
    const osdLibraryCopies = fs
        .readdirSync(reactAppDir)
        .filter(name => name.endsWith('.js'))
        .filter(name =>
            OSD_LIBRARY_MARKER.test(
                fs.readFileSync(path.join(reactAppDir, name), 'utf8')
            )
        );
    if (osdLibraryCopies.length > 1) {
        throw new Error(
            `Expected one copy of OpenSeadragon in ${reactAppDir}, found it in ${osdLibraryCopies.join(
                ', '
            )}`
        );
    }

    // Annotorious is only needed by viewers with annotations enabled.
    const initialAnnotoriousBundles = bundleEntries.filter(({ bundle }) =>
        bundle.includes(ANNOTORIOUS_MARKER)
    );
    if (initialAnnotoriousBundles.length) {
        throw new Error(
            `Expected Annotorious in an asynchronous chunk, but it is in ${initialAnnotoriousBundles
                .map(({ bundlePath }) => path.basename(bundlePath))
                .join(', ')}`
        );
    }

    // The magic wand and smart brush load when either tool is picked.
    const initialTissueBundles = bundleEntries.filter(({ bundle }) =>
        bundle.includes(TISSUE_MARKER)
    );
    if (initialTissueBundles.length) {
        throw new Error(
            `Expected the tissue tools in an asynchronous chunk, but they are in ${initialTissueBundles
                .map(({ bundlePath }) => path.basename(bundlePath))
                .join(', ')}`
        );
    }

    // The shape operations (polygon-clipping) load when one first runs:
    // in no initial bundle, and not in the viewer's own chunk.
    const shapeOpsChunks = fs
        .readdirSync(reactAppDir)
        .filter(name => name.endsWith('.js'))
        .filter(name =>
            fs
                .readFileSync(path.join(reactAppDir, name), 'utf8')
                .includes(SHAPE_OPS_MARKER)
        );
    const misplacedShapeOps = shapeOpsChunks.filter(
        name => !SHAPE_OPS_CHUNK.test(name)
    );
    if (misplacedShapeOps.length) {
        throw new Error(
            `Expected the shape operations (polygon-clipping) only in the asynchronous wsi-shapeops chunk, but they are in ${misplacedShapeOps.join(
                ', '
            )}`
        );
    }

    return {
        distDir,
        reactAppDir,
        osdBundlePath,
    };
}

if (require.main === module) {
    const result = assertWsiOsdBundle();
    console.log(
        `WSI OpenSeadragon bundle check passed (${path.relative(
            result.reactAppDir,
            result.osdBundlePath
        )})`
    );
}

module.exports = {
    assertWsiOsdBundle,
    OPENSEADRAGON_MARKER,
    SHAPE_OPS_MARKER,
    TISSUE_MARKER,
    getInitialBundlePaths,
};
