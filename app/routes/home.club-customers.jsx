import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import {
    Page,
    Layout,
    Card,
    IndexTable,
    Text,
    Spinner,
    EmptyState,
    Badge,
} from "@shopify/polaris";

const TABLE = "Lovable_Shopify_Integration_CusotmerProfil";

/* ---------------- HELPERS ---------------- */

function cleanText(v) {
    return String(v ?? "").trim();
}

function formatLabel(str) {
    return String(str)
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.length ? JSON.stringify(value, null, 2) : "-";
    if (value && typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
}

function isPlainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
}

function formatPrimitiveValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
}

function renderObjectList(obj) {
    const entries = Object.entries(obj || {});
    if (!entries.length) return <div>-</div>;

    return (
        <div style={{ display: "grid", gap: 8 }}>
            {entries.map(([k, v]) => (
                <div
                    key={k}
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "8px 10px",
                        background: "#f6f6f7",
                        borderRadius: 8,
                    }}
                >
                    <div style={{ fontWeight: 600 }}>{formatLabel(k)}</div>
                    <div>{formatPrimitiveValue(v)}</div>
                </div>
            ))}
        </div>
    );
}

function renderNestedSizeObject(obj) {
    const entries = Object.entries(obj || {});
    if (!entries.length) return <div>-</div>;

    return (
        <div style={{ display: "grid", gap: 12 }}>
            {entries.map(([itemName, details]) => (
                <div
                    key={itemName}
                    style={{
                        border: "1px solid #e1e3e5",
                        borderRadius: 10,
                        padding: 12,
                        background: "#fff",
                    }}
                >
                    <div style={{ fontWeight: 700, marginBottom: 10 }}>
                        {formatLabel(itemName)}
                    </div>

                    {isPlainObject(details) ? (
                        <div style={{ display: "grid", gap: 8 }}>
                            {Object.entries(details).map(([k, v]) => (
                                <div
                                    key={k}
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        gap: 12,
                                        padding: "6px 0",
                                        borderTop: "1px solid #f1f1f1",
                                    }}
                                >
                                    <div style={{ fontWeight: 600 }}>{formatLabel(k)}</div>
                                    <div>{formatPrimitiveValue(v)}</div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div>{formatPrimitiveValue(details)}</div>
                    )}
                </div>
            ))}
        </div>
    );
}

function renderStudentField(key, value) {
    if (key === "items" && isPlainObject(value)) {
        return renderObjectList(value);
    }

    if (key === "sizes" && isPlainObject(value)) {
        return renderNestedSizeObject(value);
    }

    if (Array.isArray(value)) {
        if (!value.length) return <div>-</div>;

        return (
            <div style={{ display: "grid", gap: 8 }}>
                {value.map((item, index) => (
                    <div
                        key={index}
                        style={{
                            padding: "8px 10px",
                            background: "#f6f6f7",
                            borderRadius: 8,
                        }}
                    >
                        {isPlainObject(item) ? renderObjectList(item) : formatPrimitiveValue(item)}
                    </div>
                ))}
            </div>
        );
    }

    if (isPlainObject(value)) {
        return renderObjectList(value);
    }

    return <div>{formatPrimitiveValue(value)}</div>;
}

function normalizeStudents(rows = []) {
    const out = [];

    for (const row of rows) {
        const students = row?.students;

        if (Array.isArray(students)) {
            for (const student of students) {
                if (student && typeof student === "object") {
                    out.push(student);
                }
            }
        } else if (students && typeof students === "object") {
            out.push(students);
        }
    }

    return out;
}

function groupCustomersForList(rows = []) {
    const map = new Map();

    for (const row of rows) {
        const shopifyCustomerId = cleanText(row.shopify_customer_id);
        const fallbackKey = `row-${row.id}`;
        const key = shopifyCustomerId || fallbackKey;

        if (!map.has(key)) {
            map.set(key, {
                id: row.id,
                shopify_customer_id: shopifyCustomerId || null,
                customer_first_name: row.customer_first_name || "",
                customer_last_name: row.customer_last_name || "",
                customer_email: row.customer_email || "",
                created_at: row.created_at || null,
                row_count: 1,
                student_count: Array.isArray(row.students)
                    ? row.students.length
                    : row.students && typeof row.students === "object"
                        ? 1
                        : 0,
            });
        } else {
            const existing = map.get(key);
            existing.row_count += 1;

            const countToAdd = Array.isArray(row.students)
                ? row.students.length
                : row.students && typeof row.students === "object"
                    ? 1
                    : 0;

            existing.student_count += countToAdd;

            if (!existing.customer_first_name && row.customer_first_name) {
                existing.customer_first_name = row.customer_first_name;
            }
            if (!existing.customer_last_name && row.customer_last_name) {
                existing.customer_last_name = row.customer_last_name;
            }
            if (!existing.customer_email && row.customer_email) {
                existing.customer_email = row.customer_email;
            }
        }
    }

    return Array.from(map.values()).sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bTime - aTime;
    });
}

/* ---------------- LOADER ---------------- */

export async function loader({ request }) {
    await authenticate.admin(request);
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
        .from(TABLE)
        .select(`
      id,
      shopify_customer_id,
      customer_first_name,
      customer_last_name,
      customer_email,
      students,
      created_at
    `)
        .order("created_at", { ascending: false });

    if (error) {
        throw new Response(error.message, { status: 500 });
    }

    const customers = groupCustomersForList(data || []);

    return { customers };
}

/* ---------------- ACTION ---------------- */

export async function action({ request }) {
    await authenticate.admin(request);
    const supabase = getSupabaseAdmin();

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent !== "getCustomerDetail") {
        return { ok: false, error: "Invalid intent" };
    }

    const shopifyCustomerId = cleanText(formData.get("shopifyCustomerId"));

    if (!shopifyCustomerId) {
        return { ok: false, error: "Missing shopifyCustomerId" };
    }

    const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("shopify_customer_id", shopifyCustomerId)
        .order("created_at", { ascending: true });

    if (error) {
        return { ok: false, error: error.message };
    }

    const rows = data || [];
    const firstRow = rows[0] || null;
    const allStudents = normalizeStudents(rows);

    return {
        ok: true,
        customerGroup: {
            shopify_customer_id: shopifyCustomerId,
            customer_first_name: firstRow?.customer_first_name || "",
            customer_last_name: firstRow?.customer_last_name || "",
            customer_email: firstRow?.customer_email || "",
            parent_phone: firstRow?.parent_phone || "",
            sms_opt_in: firstRow?.sms_opt_in ?? false,
            enrollment_status: firstRow?.enrollment_status || "",
            current_step: firstRow?.current_step || "",
            shipping_street: firstRow?.shipping_street || "",
            shipping_apt: firstRow?.shipping_apt || "",
            shipping_city: firstRow?.shipping_city || "",
            shipping_state: firstRow?.shipping_state || "",
            shipping_zip: firstRow?.shipping_zip || "",
            shipping_instructions: firstRow?.shipping_instructions || "",
            billing_same_as_shipping: firstRow?.billing_same_as_shipping ?? true,
            billing_street: firstRow?.billing_street || "",
            billing_apt: firstRow?.billing_apt || "",
            billing_city: firstRow?.billing_city || "",
            billing_state: firstRow?.billing_state || "",
            billing_zip: firstRow?.billing_zip || "",
            discount_percent: firstRow?.discount_percent ?? 0,
            estimated_total: firstRow?.estimated_total ?? 0,
            created_at: firstRow?.created_at || "",
            updated_at: firstRow?.updated_at || "",
            students: allStudents,
            row_count: rows.length,
        },
    };
}

/* ---------------- PAGE ---------------- */

export default function ClubCustomerPage() {
    const { customers } = useLoaderData();
    const fetcher = useFetcher();

    const [drawerOpen, setDrawerOpen] = useState(false);
    const [selectedCustomerGroup, setSelectedCustomerGroup] = useState(null);

    const isLoading =
        fetcher.state !== "idle" &&
        fetcher.formData?.get("intent") === "getCustomerDetail";

    const handleClick = (shopifyCustomerId) => {
        setDrawerOpen(true);
        setSelectedCustomerGroup(null);

        const fd = new FormData();
        fd.append("intent", "getCustomerDetail");
        fd.append("shopifyCustomerId", String(shopifyCustomerId));

        fetcher.submit(fd, { method: "post" });
    };

    useEffect(() => {
        if (fetcher.data?.customerGroup) {
            setSelectedCustomerGroup(fetcher.data.customerGroup);
        }
    }, [fetcher.data]);

    const rows = useMemo(() => {
        return customers.map((c, i) => {
            const name = `${c.customer_first_name || ""} ${c.customer_last_name || ""}`.trim();

            return (
                <IndexTable.Row key={c.shopify_customer_id || c.id} id={String(c.shopify_customer_id || c.id)} position={i}>
                    <IndexTable.Cell>
                        <button
                            type="button"
                            onClick={() => handleClick(c.shopify_customer_id)}
                            style={{
                                background: "none",
                                border: "none",
                                color: "#0b5fff",
                                cursor: "pointer",
                                textDecoration: "underline",
                                padding: 0,
                                font: "inherit",
                            }}
                        >
                            {name || "No name"}
                        </button>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                        <Text as="span">{c.customer_email || "-"}</Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                        <Badge>{c.student_count || 0}</Badge>
                    </IndexTable.Cell>
                </IndexTable.Row>
            );
        });
    }, [customers]);

    return (
        <Page title="Club Customers" fullWidth>
            <Layout>
                <Layout.Section>
                    <Card>
                        {customers.length ? (
                            <IndexTable
                                resourceName={{ singular: "customer", plural: "customers" }}
                                itemCount={customers.length}
                                selectable={false}
                                headings={[
                                    { title: "Name" },
                                    { title: "Email" },
                                    { title: "Students" },
                                ]}
                            >
                                {rows}
                            </IndexTable>
                        ) : (
                            <EmptyState heading="No customers">
                                <p>No data found.</p>
                            </EmptyState>
                        )}
                    </Card>
                </Layout.Section>
            </Layout>

            <CustomerDrawer
                open={drawerOpen}
                onClose={() => {
                    setDrawerOpen(false);
                    setSelectedCustomerGroup(null);
                }}
                data={selectedCustomerGroup}
                loading={isLoading}
            />
        </Page>
    );
}

/* ---------------- DRAWER ---------------- */

function CustomerDrawer({ open, onClose, data, loading }) {
    if (!open) return null;

    const students = Array.isArray(data?.students) ? data.students : [];

    return (
        <>
            <div
                onClick={onClose}
                style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.30)",
                    zIndex: 9998,
                }}
            />

            <div
                style={{
                    position: "fixed",
                    top: 0,
                    right: 0,
                    width: "60%",
                    maxWidth: "100%",
                    height: "100vh",
                    background: "#fff",
                    zIndex: 9999,
                    padding: "20px",
                    overflowY: "auto",
                    boxShadow: "-5px 0 20px rgba(0,0,0,0.15)",
                }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <h2 style={{ margin: 0 }}>Customer Details</h2>
                    <button type="button" onClick={onClose}>Close</button>
                </div>

                {loading ? (
                    <div style={{ paddingTop: 40, textAlign: "center" }}>
                        <Spinner accessibilityLabel="Loading customer details" size="large" />
                    </div>
                ) : data ? (
                    <>
                        <div style={{ marginBottom: 24 }}>
                            <h3 style={{ marginBottom: 12 }}>Customer Info</h3>

                            {Object.entries(data)
                                .filter(([key]) => key !== "students")
                                .map(([key, value]) => (
                                    <div key={key} style={{ marginBottom: 12 }}>
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{formatLabel(key)}</div>
                                        <div>{formatValue(value)}</div>
                                    </div>
                                ))}
                        </div>

                        <div>
                            <h3 style={{ marginBottom: 12 }}>Students</h3>

                            {students.length ? (
                                students.map((student, index) => (
                                    <div
                                        key={index}
                                        style={{
                                            border: "1px solid #e1e3e5",
                                            borderRadius: 12,
                                            padding: 14,
                                            marginBottom: 14,
                                            background: "#fafbfb",
                                        }}
                                    >
                                        <div style={{ fontWeight: 700, marginBottom: 10 }}>
                                            Student {index + 1}
                                        </div>

                                        {Object.entries(student).map(([key, value]) => (
                                            <div key={key} style={{ marginBottom: 14 }}>
                                                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                                                    {formatLabel(key)}
                                                </div>
                                                {renderStudentField(key, value)}
                                            </div>
                                        ))}
                                    </div>
                                ))
                            ) : (
                                <p>No student data found.</p>
                            )}
                        </div>
                    </>
                ) : (
                    <p>No data found.</p>
                )}
            </div>
        </>
    );
}