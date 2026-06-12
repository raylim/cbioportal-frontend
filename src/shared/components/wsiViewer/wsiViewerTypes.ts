export interface Slide {
    image_id: string;
    stain_name: string;
    stain_group: string;
    is_hne: boolean;
    is_ihc: boolean;
    magnification: string;
    file_size_bytes: string;
    can_serve_tiles: boolean;
    barcode: string;
    block_label: string;
    block_number: string;
}

export interface Block {
    block_number: string;
    block_label: string;
    slides: Slide[];
}

export interface Part {
    part_number: string;
    part_designator: string;
    part_type: string;
    part_description: string;
    subspecialty: string;
    path_dx_title: string;
    blocks: Block[];
}

export interface Sample {
    sample_id: string;
    cancer_type: string;
    cancer_type_detailed: string;
    oncotree_code: string;
    primary_site: string;
    sample_type: string;
    parts: Part[];
}

export interface PatientHierarchy {
    patient_id: string;
    samples: Sample[];
}

export interface TileMetadata {
    dimensions: { width: number; height: number };
    levels: number;
    level_dimensions: Array<{ width: number; height: number }>;
    max_zoom: number;
    tile_size: number;
    mpp?: { x: number; y: number };
    objective_power?: number;
}

// ---------------------------------------------------------------------------
// W3C Web Annotation types (Annotorious-compatible)
// ---------------------------------------------------------------------------

export interface FragmentSelector {
    type: 'FragmentSelector';
    conformsTo: 'http://www.w3.org/TR/media-frags/';
    /** e.g. "xywh=pixel:100,200,300,400" */
    value: string;
}

export interface SvgSelector {
    type: 'SvgSelector';
    /** e.g. '<svg><polygon points="100,200 300,400 500,600" /></svg>' */
    value: string;
}

export type AnnotationSelector = FragmentSelector | SvgSelector;

export interface AnnotationBody {
    type: 'TextualBody';
    value: string;
    purpose: 'commenting' | 'tagging' | string;
}

export interface W3CAnnotation {
    '@context': 'http://www.w3.org/ns/anno.jsonld';
    type: 'Annotation';
    id: string;
    body: AnnotationBody[];
    target: {
        source: string;
        selector: AnnotationSelector;
    };
    /** ISO datetime string from the annotation API */
    created?: string;
    /** Keycloak sub of the creator */
    creator?: string;
    /** Optimistic concurrency version from the annotation API */
    version?: number;
}
