import React from 'react';
import {
    ITimelineConfig,
    ITrackEventConfig,
    TimelineTrackSpecification,
} from './types';

type CachedTrackRendererEntry = {
    config?: ITrackEventConfig;
    signature: string;
};

type CachedTrackRenderersSignatureEntry = {
    rendererSignatures: string[];
    signature: string;
};

const rendererConfigResolutionCache = new WeakMap<
    NonNullable<ITimelineConfig['trackEventRenderers']>,
    Map<string, CachedTrackRendererEntry>
>();
const trackRenderersSignatureCache = new WeakMap<
    NonNullable<ITimelineConfig['trackEventRenderers']>,
    CachedTrackRenderersSignatureEntry
>();
const functionIdentityCache = new WeakMap<Function, number>();
let nextFunctionIdentity = 1;

function getFunctionIdentity(fn: Function): number {
    const cached = functionIdentityCache.get(fn);
    if (cached) {
        return cached;
    }

    const nextId = nextFunctionIdentity++;
    functionIdentityCache.set(fn, nextId);
    return nextId;
}

function buildTrackRendererSignature(conf: ITrackEventConfig): string {
    let legendSignature = '';
    const legend = conf.legend || [];

    for (let index = 0; index < legend.length; index += 1) {
        const item = legend[index];
        if (index > 0) {
            legendSignature += '|';
        }
        legendSignature += `${item.label}:${item.color}`;
    }

    return `${conf.trackTypeMatch.source}::${conf.trackTypeMatch.flags}::${
        conf.attributeOrder?.join('|') || ''
    }::${legendSignature}::${getFunctionIdentity(conf.configureTrack)}`;
}

function buildTrackRenderersSignature(
    renderers: NonNullable<ITimelineConfig['trackEventRenderers']>
): string {
    let signature = '';
    const rendererSignatures = new Array(renderers.length);

    for (let index = 0; index < renderers.length; index += 1) {
        const rendererSignature = buildTrackRendererSignature(renderers[index]);
        rendererSignatures[index] = rendererSignature;
        if (index > 0) {
            signature += '||';
        }
        signature += rendererSignature;
    }

    const cached = trackRenderersSignatureCache.get(renderers);
    if (
        cached &&
        cached.rendererSignatures.length === rendererSignatures.length &&
        cached.rendererSignatures.every(
            (signature, index) => signature === rendererSignatures[index]
        )
    ) {
        return cached.signature;
    }

    trackRenderersSignatureCache.set(renderers, {
        rendererSignatures,
        signature,
    });
    return signature;
}

function resolveTrackRendererConfig(
    trackType: string,
    timelineConfig: ITimelineConfig,
    renderersSignature?: string
): ITrackEventConfig | undefined {
    const renderers = timelineConfig.trackEventRenderers;
    if (!renderers?.length) {
        return undefined;
    }

    const signature = renderersSignature || buildTrackRenderersSignature(renderers);
    const cachedByType =
        rendererConfigResolutionCache.get(renderers) || new Map();
    const cached = cachedByType.get(trackType);
    if (cached && cached.signature === signature) {
        return cached.config;
    }

    let resolved: ITrackEventConfig | undefined;
    for (let index = 0; index < renderers.length; index += 1) {
        const candidate = renderers[index];
        if (candidate.trackTypeMatch.test(trackType)) {
            resolved = candidate;
            break;
        }
    }
    cachedByType.set(trackType, {
        config: resolved,
        signature,
    });
    rendererConfigResolutionCache.set(renderers, cachedByType);
    return resolved;
}

export const configureTracks = function(
    tracks: TimelineTrackSpecification[],
    timelineConfig: ITimelineConfig,
    parentConf?: ITrackEventConfig,
    renderersSignature?: string
) {
    const resolvedRenderersSignature =
        renderersSignature ||
        (timelineConfig.trackEventRenderers?.length
            ? buildTrackRenderersSignature(timelineConfig.trackEventRenderers)
            : undefined);

    for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const conf = resolveTrackRendererConfig(
            track.type,
            timelineConfig,
            resolvedRenderersSignature
        );

        // add top level config to each track for later reference
        track.timelineConfig = timelineConfig;

        // if we have a conf, attach it to the track for later use
        // otherwise, attach parentConf //
        if (conf) {
            track.trackConf = conf;
            conf.configureTrack(track);
        } else if (parentConf) {
            track.trackConf = parentConf;
        }

        if (track.tracks && track.tracks.length) {
            configureTracks(
                track.tracks,
                timelineConfig,
                conf || parentConf,
                resolvedRenderersSignature
            );
        }
    }
};
