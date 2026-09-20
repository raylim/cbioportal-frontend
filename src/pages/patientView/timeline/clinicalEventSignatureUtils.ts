import { ClinicalEvent } from 'cbioportal-ts-api-client';

type CachedAttributeSignatureEntry = {
    orderedSnapshot: string;
    unorderedSignature: string;
};

type CachedEventSignatureEntry = {
    attributeRef?: ClinicalEvent['attributes'];
    attributeSignature: string;
    includeUniqueKeys: boolean;
    snapshot: string;
    signature: string;
};

type CachedEventsSignatureEntry = {
    ignoreOrder: boolean;
    orderedSnapshot: string;
    includeUniqueKeys: boolean;
    signature: string;
};

const attributeSignatureCache = new WeakMap<
    NonNullable<ClinicalEvent['attributes']>,
    CachedAttributeSignatureEntry
>();

function signatureValue(value: unknown): string {
    const text = String(value ?? '');
    // Keep the established compact format for ordinary identifiers while
    // escaping delimiter characters in user-provided values. This prevents
    // distinct events or attributes from sharing a cache key.
    return /^[A-Za-z0-9_.-]*$/.test(text)
        ? text
        : `~${encodeURIComponent(text)}`;
}
const eventSignatureCache = new WeakMap<ClinicalEvent, CachedEventSignatureEntry>();
const eventsSignatureCache = new WeakMap<
    ClinicalEvent[],
    CachedEventsSignatureEntry
>();

export function buildClinicalEventAttributesSignature(
    attributes: ClinicalEvent['attributes']
): string {
    if (!attributes?.length) {
        return '';
    }

    const entries = new Array<string>(attributes.length);
    for (let index = 0; index < attributes.length; index += 1) {
        const attribute = attributes[index];
        entries[index] = `${signatureValue(attribute.key)}:${signatureValue(
            attribute.value
        )}`;
    }
    const orderedSnapshot = entries.join('|');

    const cached = attributeSignatureCache.get(attributes);
    if (cached && cached.orderedSnapshot === orderedSnapshot) {
        return cached.unorderedSignature;
    }

    entries.sort((left, right) => left.localeCompare(right));
    const unorderedSignature = entries.join('|');

    attributeSignatureCache.set(attributes, {
        orderedSnapshot,
        unorderedSignature,
    });

    return unorderedSignature;
}

export function buildClinicalEventSignature(
    event: ClinicalEvent,
    { includeUniqueKeys = true }: { includeUniqueKeys?: boolean } = {}
): string {
    const attributes = event.attributes;
    const attributeSignature = buildClinicalEventAttributesSignature(attributes);
    const cached = eventSignatureCache.get(event);

    const snapshot = [
        signatureValue(event.eventType),
        signatureValue(event.patientId),
        signatureValue(event.studyId),
        ...(includeUniqueKeys
            ? [
                  signatureValue(event.uniquePatientKey),
                  signatureValue(event.uniqueSampleKey),
              ]
            : []),
        signatureValue(event.startNumberOfDaysSinceDiagnosis),
        signatureValue(event.endNumberOfDaysSinceDiagnosis),
        attributeSignature,
    ].join('::');

    if (
        cached &&
        cached.attributeRef === attributes &&
        cached.attributeSignature === attributeSignature &&
        cached.includeUniqueKeys === includeUniqueKeys &&
        cached.snapshot === snapshot
    ) {
        return cached.signature;
    }

    const signature = snapshot;

    eventSignatureCache.set(event, {
        attributeRef: attributes,
        attributeSignature,
        includeUniqueKeys,
        snapshot: signature,
        signature,
    });

    return signature;
}

export function buildClinicalEventsSignature(
    events: ClinicalEvent[],
    options?: { includeUniqueKeys?: boolean; ignoreOrder?: boolean }
): string {
    const includeUniqueKeys = options?.includeUniqueKeys ?? true;
    const ignoreOrder = options?.ignoreOrder ?? false;
    const cached = eventsSignatureCache.get(events);
    const eventSignatures = new Array<string>(events.length);

    for (let index = 0; index < events.length; index += 1) {
        eventSignatures[index] = buildClinicalEventSignature(
            events[index],
            options
        );
    }
    const orderedSnapshot = eventSignatures.join('||');

    if (
        cached &&
        cached.includeUniqueKeys === includeUniqueKeys &&
        cached.ignoreOrder === ignoreOrder &&
        cached.orderedSnapshot === orderedSnapshot
    ) {
        return cached.signature;
    }

    let signature = orderedSnapshot;
    if (ignoreOrder && eventSignatures.length > 1) {
        const unorderedEventSignatures = [...eventSignatures];
        unorderedEventSignatures.sort((left, right) => left.localeCompare(right));
        signature = unorderedEventSignatures.join('||');
    }

    eventsSignatureCache.set(events, {
        ignoreOrder,
        orderedSnapshot,
        includeUniqueKeys,
        signature,
    });

    return signature;
}
