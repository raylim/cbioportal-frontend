import * as React from 'react';
import { DefaultTooltip } from 'cbioportal-frontend-commons';

/** What a high-power field is, in plain language. */
export const HPF_HELP_TEXT =
    "HPF (high-power field): the area of tissue seen through the microscope at high magnification (40× objective). Mitoses and other counts are often reported per 10 HPF. The field's area depends on the microscope's eyepiece (its field number): pick your microscope's area, or enter it in mm². Default 0.237 mm² (0.55 mm diameter).";

/** What the high-power field table's rate columns mean. */
export const HPF_RATE_HELP: ReadonlyArray<{ label: string; text: string }> = [
    {
        label: 'Per 10 HPF',
        text:
            'The points inside the fields, divided by the number of fields, times 10: the count as pathology reports give it (e.g. "12 mitoses per 10 HPF").',
    },
    {
        label: 'Per mm²',
        text:
            'The points inside the fields, divided by the fields’ total area: comparable between microscopes with different field sizes.',
    },
];

let nextHelpId = 0;

/** A stable id for a hidden help text, unique on the page. */
export function useHpfHelpId(): string {
    const id = React.useRef<string | null>(null);
    if (id.current === null) id.current = `wsi-hpf-help-${++nextHelpId}`;
    return id.current;
}

/**
 * An info icon whose tooltip (on hover and on focus) explains high-power
 * fields; `describedById` names a hidden element with the same text, for
 * controls to point `aria-describedby` at.
 */
export function WsiHpfInfo({
    testId,
    describedById,
    rates = false,
    style,
}: {
    testId: string;
    /** The id of the hidden description this renders. */
    describedById: string;
    /** Explain the table's rate columns too. */
    rates?: boolean;
    style?: React.CSSProperties;
}) {
    const text = rates
        ? `${HPF_HELP_TEXT} ${HPF_RATE_HELP.map(
              item => `${item.label}: ${item.text}`
          ).join(' ')}`
        : HPF_HELP_TEXT;
    return (
        <>
            <DefaultTooltip
                trigger={['hover', 'focus']}
                placement="bottom"
                overlay={
                    <div
                        data-testid={`${testId}-help`}
                        style={{ maxWidth: 320 }}
                    >
                        <div>{HPF_HELP_TEXT}</div>
                        {rates &&
                            HPF_RATE_HELP.map(item => (
                                <div key={item.label} style={{ marginTop: 4 }}>
                                    <b>{item.label}:</b> {item.text}
                                </div>
                            ))}
                    </div>
                }
            >
                <i
                    className="fa fa-info-circle"
                    role="img"
                    tabIndex={0}
                    aria-label="What a high-power field (HPF) is"
                    aria-describedby={describedById}
                    data-testid={`${testId}-info`}
                    style={{
                        color: '#595959',
                        cursor: 'help',
                        fontSize: 12,
                        ...style,
                    }}
                />
            </DefaultTooltip>
            <span id={describedById} hidden data-testid={`${testId}-text`}>
                {text}
            </span>
        </>
    );
}
