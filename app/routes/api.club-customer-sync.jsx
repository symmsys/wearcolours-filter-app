import crypto from "node:crypto";
import { getSupabaseAdmin } from "../supabase.server";
import { unauthenticated } from "../shopify.server";

const TABLE = "Lovable_Shopify_Integration_CusotmerProfil";

function jsonResponse(data, init = {}) {
    return new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: {
            "Content-Type": "application/json",
            ...(init.headers || {}),
        },
    });
}

function cleanText(value) {
    return String(value ?? "").trim();
}

function toCustomerGid(shopifyCustomerId) {
    const raw = cleanText(shopifyCustomerId);
    if (!raw) return "";

    if (raw.startsWith("gid://shopify/Customer/")) {
        return raw;
    }

    return `gid://shopify/Customer/${raw}`;
}

function verifySignature(rawBody, signature) {
    const secret = process.env.LOVABLE_SYNC_SHARED_SECRET;

    if (!secret || !signature) return false;

    const expected = crypto
        .createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("hex");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected, "hex"),
            Buffer.from(String(signature), "hex")
        );
    } catch {
        return false;
    }
}

export async function action({ request }) {
    if (request.method !== "POST") {
        return jsonResponse(
            { ok: false, error: "Method not allowed" },
            { status: 405 }
        );
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-club-signature");

    if (!verifySignature(rawBody, signature)) {
        return jsonResponse(
            { ok: false, error: "Invalid signature" },
            { status: 401 }
        );
    }

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return jsonResponse(
            { ok: false, error: "Invalid JSON body" },
            { status: 400 }
        );
    }

    const shop = cleanText(body?.shop);
    const shopifyCustomerId = cleanText(body?.shopifyCustomerId);
    const customerEmail = cleanText(body?.customerEmail).toLowerCase();

    if (!shop) {
        return jsonResponse(
            { ok: false, error: "Missing shop" },
            { status: 400 }
        );
    }

    if (!shopifyCustomerId && !customerEmail) {
        return jsonResponse(
            { ok: false, error: "Missing shopifyCustomerId or customerEmail" },
            { status: 400 }
        );
    }

    try {
        const supabase = getSupabaseAdmin();

        let query = supabase
            .from(TABLE)
            .select(`
        id,
        shopify_customer_id,
        customer_email,
        customer_first_name,
        customer_last_name,
        updated_at,
        created_at
      `)
            .order("updated_at", { ascending: false })
            .limit(1);

        if (shopifyCustomerId) {
            query = query.eq("shopify_customer_id", shopifyCustomerId);
        } else {
            query = query.eq("customer_email", customerEmail);
        }

        const { data: rows, error: supabaseError } = await query;

        if (supabaseError) {
            return jsonResponse(
                { ok: false, error: supabaseError.message || "Supabase fetch failed" },
                { status: 500 }
            );
        }

        const row = rows?.[0];

        if (!row) {
            return jsonResponse(
                { ok: false, error: "No matching customer row found in Supabase" },
                { status: 404 }
            );
        }

        const firstName = cleanText(row.customer_first_name);
        const lastName = cleanText(row.customer_last_name);
        const customerIdGid = toCustomerGid(row.shopify_customer_id);

        if (!customerIdGid) {
            return jsonResponse(
                { ok: false, error: "Missing shopify_customer_id in Supabase row" },
                { status: 400 }
            );
        }

        if (!firstName && !lastName) {
            return jsonResponse(
                { ok: false, error: "No first name or last name available to sync" },
                { status: 400 }
            );
        }

        const { admin } = await unauthenticated.admin(shop);

        const mutation = `#graphql
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            firstName
            lastName
            email
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

        const variables = {
            input: {
                id: customerIdGid,
                firstName,
                lastName,
            },
        };

        const response = await admin.graphql(mutation, { variables });
        const result = await response.json();

        const payload = result?.data?.customerUpdate;
        const userErrors = payload?.userErrors || [];

        if (userErrors.length) {
            return jsonResponse(
                {
                    ok: false,
                    error: "Shopify returned userErrors",
                    userErrors,
                },
                { status: 422 }
            );
        }

        return jsonResponse({
            ok: true,
            syncedFrom: {
                shopify_customer_id: row.shopify_customer_id,
                customer_email: row.customer_email,
                customer_first_name: firstName,
                customer_last_name: lastName,
            },
            customer: payload?.customer || null,
        });
    } catch (error) {
        return jsonResponse(
            {
                ok: false,
                error: error?.message || "Unexpected server error",
            },
            { status: 500 }
        );
    }
}