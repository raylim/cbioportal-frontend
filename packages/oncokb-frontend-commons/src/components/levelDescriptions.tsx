import * as React from 'react';

export const LEVEL_DESC: { [level: string]: JSX.Element } = {
    '1': (
        <span>
            <b>FDA-recognized</b> biomarker predictive of response to an{' '}
            <b>FDA-approved drug</b> in this indication
        </span>
    ),
    '2': (
        <span>
            <b>Standard care</b> biomarker recommended by the NCCN or other
            expert panels predictive of response to an <b>FDA-approved drug</b>{' '}
            in this indication
        </span>
    ),
    '3A': (
        <span>
            <b>Compelling clinical evidence</b> supports the biomarker as being
            predictive of response to a drug in this indication
        </span>
    ),
    '3B': (
        <span>
            <b>Standard care</b> or <b>investigational</b> biomarker predictive
            of response to an <b>FDA-approved</b> or <b>investigational</b>{' '}
            drug in another indication
        </span>
    ),
    '4': (
        <span>
            <b>Compelling biological evidence</b> supports the biomarker as
            being predictive of response to a drug
        </span>
    ),
    R1: (
        <span>
            <b>Standard care</b> biomarker predictive of <b>resistance</b> to
            an <b>FDA-approved</b> drug <b>in this indication</b>
        </span>
    ),
    R2: (
        <span>
            <b>Compelling clinical evidence</b> supports the biomarker as being
            predictive of <b>resistance</b> to a drug
        </span>
    ),
    Dx1: (
        <span>
            <b>FDA and/or professional guideline-recognized</b> biomarker
            required for diagnosis in this indication
        </span>
    ),
    Dx2: (
        <span>
            <b>FDA and/or professional guideline-recognized</b> biomarker that
            supports diagnosis in this indication
        </span>
    ),
    Dx3: (
        <span>
            Biomarker that <b>may assist disease diagnosis</b> in this
            indication based on <b>clinical evidence</b>
        </span>
    ),
    Px1: (
        <span>
            <b>FDA and/or professional guideline-recognized</b> biomarker
            prognostic in this indication based on <b>well-powered studie(s)</b>
        </span>
    ),
    Px2: (
        <span>
            <b>FDA and/or professional guideline-recognized</b> biomarker
            prognostic in this indication based on <b>a single or multiple
            small studies</b>
        </span>
    ),
    Px3: (
        <span>
            Biomarker is prognostic in this indication based on{' '}
            <b>clinical evidence</b> in <b>well-powered studies</b>
        </span>
    ),
};
