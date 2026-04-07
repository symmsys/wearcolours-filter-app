/// <reference types="@shopify/ui-extensions/customer-account.profile.block.render" />

import '@shopify/ui-extensions/customer-account/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/**
 * @typedef {Object} StudentSizeDetail
 * @property {string=} fit
 * @property {string=} size
 * @property {boolean=} confirmed
 * @property {string=} sizeRange
 */

/**
 * @typedef {Object} Student
 * @property {number|string=} tier
 * @property {string=} grade
 * @property {Record<string, number>=} items
 * @property {Record<string, StudentSizeDetail>=} sizes
 * @property {string=} height
 * @property {string=} school
 * @property {string=} weight
 * @property {string=} last_name
 * @property {string=} first_name
 * @property {string|null=} style_notes
 * @property {string=} fit_preference
 * @property {string=} color_preference
 * @property {string=} uniform_category
 */

/**
 * @typedef {Object} CustomerGroup
 * @property {string=} customer_first_name
 * @property {string=} customer_last_name
 * @property {string=} customer_email
 * @property {string=} parent_phone
 * @property {boolean=} sms_opt_in
 * @property {string=} enrollment_status
 * @property {string=} current_step
 * @property {string=} shipping_street
 * @property {string=} shipping_apt
 * @property {string=} shipping_city
 * @property {string=} shipping_state
 * @property {string=} shipping_zip
 * @property {string=} shipping_instructions
 * @property {boolean=} billing_same_as_shipping
 * @property {string=} billing_street
 * @property {string=} billing_apt
 * @property {string=} billing_city
 * @property {string=} billing_state
 * @property {string=} billing_zip
 * @property {number|string=} discount_percent
 * @property {number|string=} estimated_total
 * @property {Student[]=} students
 */

/**
 * @typedef {Object} ExtensionData
 * @property {boolean} ok
 * @property {CustomerGroup | null} customerGroup
 * @property {string=} error
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function getErrorMessage(err) {
    return err instanceof Error ? err.message : 'Failed to load data.';
}

/**
 * @param {unknown} value
 * @param {string=} fallback
 * @returns {string}
 */
function safeValue(value, fallback = '-') {
    return value === null || value === undefined || String(value).trim() === ''
        ? fallback
        : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatYesNo(value) {
    return value ? 'Yes' : 'No';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatCurrency(value) {
    const num = Number(value || 0);
    if (Number.isNaN(num)) return '-';
    return `$${num.toFixed(2)}`;
}

/**
 * @param {unknown} street
 * @param {unknown} apt
 * @param {unknown} city
 * @param {unknown} state
 * @param {unknown} zip
 * @returns {string}
 */
function formatAddress(street, apt, city, state, zip) {
    const line1 = [safeValue(street, ''), safeValue(apt, '')].filter(Boolean).join(', ');
    const line2 = [safeValue(city, ''), safeValue(state, ''), safeValue(zip, '')].filter(Boolean).join(', ');
    return [line1, line2].filter(Boolean).join(' | ') || '-';
}

/**
 * @param {{label: string, value: unknown}} props
 */
function DetailRow({ label, value }) {
    return (
        <s-box paddingBlockStart="small">
            <s-text>{label}</s-text>
            <s-text>{safeValue(value)}</s-text>
        </s-box>
    );
}

/**
 * @param {{title: string, children: any}} props
 */
function Section({ title, children }) {
    return (
        <s-box border="base" borderRadius="large" padding="base">
            <s-stack direction="block" gap="small">
                <s-heading>{title}</s-heading>
                {children}
            </s-stack>
        </s-box>
    );
}

/**
 * @param {{items?: Record<string, number>}} props
 */
function ItemList({ items }) {
    const entries = items && typeof items === 'object' ? Object.entries(items) : [];

    if (!entries.length) {
        return <s-text>No selected items.</s-text>;
    }

    return (
        <s-stack direction="block" gap="small">
            {entries.map(([name, qty]) => (
                <s-box key={name} border="base" borderRadius="base" padding="small">
                    <s-text>{name}: {safeValue(qty)}</s-text>
                </s-box>
            ))}
        </s-stack>
    );
}

/**
 * @param {{sizes?: Record<string, StudentSizeDetail>}} props
 */
function SizeList({ sizes }) {
    const entries = sizes && typeof sizes === 'object' ? Object.entries(sizes) : [];

    if (!entries.length) {
        return <s-text>No size data available.</s-text>;
    }

    return (
        <s-stack direction="block" gap="small">
            {entries.map(([category, details]) => (
                <s-box key={category} border="base" borderRadius="base" padding="small">
                    <s-stack direction="block" gap="small">
                        <s-text>{category}</s-text>
                        <s-text>Size: {safeValue(details?.size)}</s-text>
                        <s-text>Fit: {safeValue(details?.fit)}</s-text>
                        <s-text>Range: {safeValue(details?.sizeRange)}</s-text>
                        <s-text>Confirmed: {formatYesNo(details?.confirmed)}</s-text>
                    </s-stack>
                </s-box>
            ))}
        </s-stack>
    );
}

/**
 * @param {{student: Student, index: number}} props
 */
function StudentCard({ student, index }) {
    const fullName =
        `${safeValue(student?.first_name, '').trim()} ${safeValue(student?.last_name, '').trim()}`.trim() ||
        `Student ${index + 1}`;

    return (
        <s-box border="base" borderRadius="large" padding="base">
            <s-stack direction="block" gap="base">
                <s-heading>{fullName}</s-heading>

                <Section title="Student Overview">
                    <DetailRow label="School" value={student?.school} />
                    <DetailRow label="Grade" value={student?.grade} />
                    <DetailRow label="Tier" value={student?.tier} />
                    <DetailRow label="Uniform Category" value={student?.uniform_category} />
                </Section>

                <Section title="Body & Preferences">
                    <DetailRow label="Height" value={student?.height} />
                    <DetailRow label="Weight" value={student?.weight} />
                    <DetailRow label="Fit Preference" value={student?.fit_preference} />
                    <DetailRow label="Color Preference" value={student?.color_preference} />
                    <DetailRow label="Style Notes" value={student?.style_notes} />
                </Section>

                <Section title="Selected Items">
                    <ItemList items={student?.items} />
                </Section>

                <Section title="Size Profile">
                    <SizeList sizes={student?.sizes} />
                </Section>
            </s-stack>
        </s-box>
    );
}

export default async () => {
    render(<Extension />, document.body);
};

function Extension() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [data, setData] = useState(/** @type {CustomerGroup | null} */(null));

    useEffect(() => {
        async function load() {
            try {
                if (!globalThis.shopify) {
                    throw new Error('Shopify runtime not available in extension.');
                }

                if (!globalThis.shopify.sessionToken || typeof globalThis.shopify.sessionToken.get !== 'function') {
                    throw new Error('Session token API is not available in this extension runtime.');
                }

                const token = await globalThis.shopify.sessionToken.get();

                const res = await fetch('https://app.wearcolours.com/api/customer-profile-data', {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                });

                /** @type {ExtensionData} */
                const json = await res.json();

                if (!res.ok || !json.ok) {
                    throw new Error(json.error || 'Failed to load profile data.');
                }

                setData(json.customerGroup);
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        }

        load();
    }, []);

    if (loading) {
        return (
            <s-box padding="base">
                <s-text>Loading customer profile...</s-text>
            </s-box>
        );
    }

    if (error) {
        return (
            <s-box border="base" borderRadius="large" padding="base">
                <s-stack direction="block" gap="small">
                    <s-heading>Unable to load profile</s-heading>
                    <s-text>{error}</s-text>
                </s-stack>
            </s-box>
        );
    }

    if (data === null) {
        return (
            <s-box border="base" borderRadius="large" padding="base">
                <s-text>No profile data found.</s-text>
            </s-box>
        );
    }

    const fullName = `${data.customer_first_name || ''} ${data.customer_last_name || ''}`.trim();
    const students = Array.isArray(data.students) ? data.students : [];

    return (
        <s-box padding="base">
            <s-stack direction="block" gap="base">
                <s-heading>Club Colours Profile</s-heading>

                <Section title="Personal Information">
                    <DetailRow label="Full Name" value={fullName} />
                    <DetailRow label="Email" value={data.customer_email} />
                    <DetailRow label="Phone" value={data.parent_phone} />
                    <DetailRow label="SMS Opt In" value={formatYesNo(data.sms_opt_in)} />
                </Section>

                <Section title="Enrollment Details">
                    <DetailRow label="Enrollment Status" value={data.enrollment_status} />
                    <DetailRow label="Current Step" value={data.current_step} />
                    <DetailRow label="Discount Percent" value={`${Number(data.discount_percent || 0)}%`} />
                    <DetailRow label="Estimated Total" value={formatCurrency(data.estimated_total)} />
                </Section>

                <Section title="Shipping Address">
                    <DetailRow
                        label="Address"
                        value={formatAddress(
                            data.shipping_street,
                            data.shipping_apt,
                            data.shipping_city,
                            data.shipping_state,
                            data.shipping_zip
                        )}
                    />
                    <DetailRow label="Instructions" value={data.shipping_instructions} />
                </Section>

                <Section title="Billing Address">
                    <DetailRow label="Same as Shipping" value={formatYesNo(data.billing_same_as_shipping)} />
                    {!data.billing_same_as_shipping && (
                        <DetailRow
                            label="Address"
                            value={formatAddress(
                                data.billing_street,
                                data.billing_apt,
                                data.billing_city,
                                data.billing_state,
                                data.billing_zip
                            )}
                        />
                    )}
                </Section>

                <Section title={`Students (${students.length})`}>
                    {students.length > 0 ? (
                        <s-stack direction="block" gap="base">
                            {students.map((student, index) => (
                                <StudentCard
                                    key={`${student?.first_name || 'student'}-${student?.last_name || index}-${index}`}
                                    student={student}
                                    index={index}
                                />
                            ))}
                        </s-stack>
                    ) : (
                        <s-text>No students added yet.</s-text>
                    )}
                </Section>
            </s-stack>
        </s-box>
    );
}