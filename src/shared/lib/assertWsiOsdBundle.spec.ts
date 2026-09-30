import fs from 'fs';
import os from 'os';
import path from 'path';

const {
    assertWsiOsdBundle,
} = require('../../../scripts/assert_wsi_osd_bundle');

function makeTempDist() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsi-osd-bundle-'));
    const distDir = path.join(root, 'dist');
    const reactAppDir = path.join(distDir, 'reactapp');
    fs.mkdirSync(reactAppDir, { recursive: true });
    return { root, distDir };
}

function writeBundleFixture(
    distDir: string,
    bundles: Record<string, string>,
    html = '<script defer src="/reactapp/common.bundle.js"></script><script defer src="/reactapp/main.app.js"></script>'
) {
    fs.writeFileSync(path.join(distDir, 'index.html'), html);
    Object.entries(bundles).forEach(([relativePath, content]) => {
        const targetPath = path.join(distDir, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content);
    });
}

describe('assertWsiOsdBundle', () => {
    it('accepts one asynchronous OpenSeadragon chunk', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.__main__ = true;',
                'reactapp/wsi-openseadragon.123.js': 'window.__osd__ = true;',
            });

            const result = assertWsiOsdBundle({ distDir });

            expect(path.basename(result.osdBundlePath)).toBe(
                'wsi-openseadragon.123.js'
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('accepts OpenSeadragon in an initial bundle when no lazy chunk is emitted', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.openseadragon = true;',
            });

            const result = assertWsiOsdBundle({ distDir });

            expect(path.basename(result.osdBundlePath)).toBe('main.app.js');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails when OpenSeadragon is missing from all emitted bundles', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.__main__ = true;',
            });

            expect(() => assertWsiOsdBundle({ distDir })).toThrow(
                /Expected OpenSeadragon in an emitted bundle/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails when multiple asynchronous chunks are emitted', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.__main__ = true;',
                'reactapp/wsi-openseadragon.123.js': 'window.__osd__ = true;',
                'reactapp/wsi-openseadragon.456.js': 'window.__osd__ = true;',
            });

            expect(() => assertWsiOsdBundle({ distDir })).toThrow(
                /Expected at most one asynchronous/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails when OpenSeadragon is bundled into more than one chunk', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.__main__ = true;',
                'reactapp/wsi-openseadragon.123.js':
                    'c.version={versionStr:"6.0.2",major:6};',
                'reactapp/wsi-annotorious.456.js':
                    'c.version={versionStr:"6.0.2",major:6};',
            });

            expect(() => assertWsiOsdBundle({ distDir })).toThrow(
                /Expected one copy of OpenSeadragon/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('accepts Annotorious in its own chunk sharing OpenSeadragon', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js': 'window.__common__ = true;',
                'reactapp/main.app.js': 'window.__main__ = true;',
                'reactapp/wsi-openseadragon.123.js':
                    'c.version={versionStr:"6.0.2",major:6};',
                'reactapp/wsi-annotorious.456.js':
                    'e.className="a9s-annotationlayer";',
            });

            const result = assertWsiOsdBundle({ distDir });

            expect(path.basename(result.osdBundlePath)).toBe(
                'wsi-openseadragon.123.js'
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails when Annotorious is in an initial bundle', () => {
        const { root, distDir } = makeTempDist();
        try {
            writeBundleFixture(distDir, {
                'reactapp/common.bundle.js':
                    'e.className="a9s-annotationlayer";',
                'reactapp/main.app.js': 'window.__main__ = true;',
                'reactapp/wsi-openseadragon.123.js': 'window.__osd__ = true;',
            });

            expect(() => assertWsiOsdBundle({ distDir })).toThrow(
                /Expected Annotorious in an asynchronous chunk/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
