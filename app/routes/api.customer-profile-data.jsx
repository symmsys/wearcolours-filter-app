import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

const TABLE = "Lovable_Shopify_Integration_CusotmerProfil";

function cleanText(value) {
    return String(value ?? "").trim();
}

function jsonResponse(data, init = {}) {
    return new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...(init.headers || {}),
        },
    });
}

function normalizeCustomerId(value) {
    const raw = cleanText(value);

    if (!raw) return "";

    const match = raw.match(/\/(\d+)$/);
    return match ? match[1] : raw;
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

// Handles Shopify preflight requests from the customer account extension
export async function loader({ request }) {
    if (request.method === "OPTIONS") {
        const { cors } = await authenticate.public.customerAccount(request);
        return cors(new Response(null, { status: 204 }));
    }

    const { cors, sessionToken } = await authenticate.public.customerAccount(
        request
    );

    try {
        // sessionToken.sub is the logged-in customer GID
        const customerGid = cleanText(sessionToken?.sub);
        const shopifyCustomerId = normalizeCustomerId(customerGid);

        if (!shopifyCustomerId) {
            return cors(
                jsonResponse(
                    { ok: false, error: "Unable to resolve logged-in customer." },
                    { status: 401 }
                )
            );
        }

        const supabase = getSupabaseAdmin();

        const { data, error } = await supabase
            .from(TABLE)
            .select("*")
            .eq("shopify_customer_id", shopifyCustomerId)
            .order("created_at", { ascending: true });

        if (error) {
            return cors(
                jsonResponse(
                    { ok: false, error: error.message || "Supabase query failed." },
                    { status: 500 }
                )
            );
        }

        const rows = data || [];
        const firstRow = rows[0] || null;

        if (!firstRow) {
            return cors(
                jsonResponse({
                    ok: true,
                    customerGroup: null,
                })
            );
        }

        return cors(
            jsonResponse({
                ok: true,
                customerGroup: {
                    shopify_customer_id: shopifyCustomerId,
                    customer_first_name: firstRow.customer_first_name || "",
                    customer_last_name: firstRow.customer_last_name || "",
                    customer_email: firstRow.customer_email || "",
                    parent_phone: firstRow.parent_phone || "",
                    sms_opt_in: firstRow.sms_opt_in ?? false,
                    enrollment_status: firstRow.enrollment_status || "",
                    current_step: firstRow.current_step || "",
                    shipping_street: firstRow.shipping_street || "",
                    shipping_apt: firstRow.shipping_apt || "",
                    shipping_city: firstRow.shipping_city || "",
                    shipping_state: firstRow.shipping_state || "",
                    shipping_zip: firstRow.shipping_zip || "",
                    shipping_instructions: firstRow.shipping_instructions || "",
                    billing_same_as_shipping: firstRow.billing_same_as_shipping ?? true,
                    billing_street: firstRow.billing_street || "",
                    billing_apt: firstRow.billing_apt || "",
                    billing_city: firstRow.billing_city || "",
                    billing_state: firstRow.billing_state || "",
                    billing_zip: firstRow.billing_zip || "",
                    discount_percent: firstRow.discount_percent ?? 0,
                    estimated_total: firstRow.estimated_total ?? 0,
                    created_at: firstRow.created_at || "",
                    updated_at: firstRow.updated_at || "",
                    students: normalizeStudents(rows),
                    row_count: rows.length,
                },
            })
        );
    } catch (err) {
        return cors(
            jsonResponse(
                {
                    ok: false,
                    error: err?.message || "Failed to load customer profile data.",
                },
                { status: 500 }
            )
        );
    }
}