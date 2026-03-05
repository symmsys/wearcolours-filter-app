// app/routes/apps.school-products.jsx (or your proxy route file)
// App Proxy endpoint: /apps/school-products
// Purpose:
// 1) Read products + grades from Supabase (product_grade_collection)
// 2) Read per-collection sort preference from Supabase (settings)
// 3) Fetch Shopify collection product handles in that sort order
// 4) Reorder Supabase handles to match Shopify order and return JSON

import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

/* ─────────────────────────────────────────────
   Constants
───────────────────────────────────────────── */
const EXTERNAL_TABLE = "product_grade_collection";
const SETTINGS_TABLE = "settings";

// Fallback: manual order set in Shopify Admin for the collection
const DEFAULT_SORT = "COLLECTION_DEFAULT";

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */
function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

/**
 * Fetch Shopify collection id from handle (so we can query settings by shop+collection_id)
 */
async function fetchCollectionIdByHandle(admin, handle) {
    const resp = await admin.graphql(
        `#graphql
      query($handle: String!) {
        collectionByHandle(handle: $handle) { id handle title }
      }
    `,
        { variables: { handle } }
    );

    const json = await resp.json();
    if (json?.errors?.length) {
        const msg = json.errors.map((e) => e.message).join(" | ");
        throw new Error(msg);
    }

    const col = json?.data?.collectionByHandle;
    return col?.id ? String(col.id) : "";
}

/**
 * Read sort order from settings table using the UNIQUE KEY: (shop, collection_id)
 */
async function getCollectionSortOrder(supabase, { shop, collectionId }) {
    if (!shop || !collectionId) return DEFAULT_SORT;

    const { data, error } = await supabase
        .from(SETTINGS_TABLE)
        .select("default_sort_order")
        .eq("shop", shop)
        .eq("collection_id", collectionId)
        .maybeSingle();

    if (error) return DEFAULT_SORT;

    const v = String(data?.default_sort_order || "").trim();
    return v || DEFAULT_SORT;
}

/**
 * Map your settings values to Shopify Collection products sortKey + reverse
 * Shopify sort keys supported on collection products:
 * TITLE, PRICE, BEST_SELLING, CREATED, COLLECTION_DEFAULT
 */
function mapSortToShopify(sortOrder) {
    const s = String(sortOrder || "").trim();

    if (!s || s === "COLLECTION_DEFAULT") {
        return { sortKey: "COLLECTION_DEFAULT", reverse: false };
    }

    if (s === "TITLE_ASC") return { sortKey: "TITLE", reverse: false };
    if (s === "TITLE_DESC") return { sortKey: "TITLE", reverse: true };

    if (s === "PRICE_ASC") return { sortKey: "PRICE", reverse: false };
    if (s === "PRICE_DESC") return { sortKey: "PRICE", reverse: true };

    if (s === "BEST_SELLING") return { sortKey: "BEST_SELLING", reverse: false };

    if (s === "CREATED_DESC") return { sortKey: "CREATED", reverse: true };
    if (s === "CREATED_ASC") return { sortKey: "CREATED", reverse: false };

    return { sortKey: "COLLECTION_DEFAULT", reverse: false };
}

/**
 * Fetch product handles in Shopify order for a collection (pagination-safe).
 * NOTE: sortKey is injected as a literal enum, reverse is variable.
 */
async function fetchShopifyCollectionHandles(admin, collectionHandle, { sortKey, reverse }) {
    const handles = [];
    let cursor = null;
    let hasNextPage = true;

    const query = `#graphql
    query CollectionProducts($handle: String!, $first: Int!, $after: String, $reverse: Boolean!) {
      collectionByHandle(handle: $handle) {
        id
        products(first: $first, after: $after, sortKey: ${sortKey}, reverse: $reverse) {
          pageInfo { hasNextPage endCursor }
          edges { node { handle } }
        }
      }
    }
  `;

    while (hasNextPage) {
        const resp = await admin.graphql(query, {
            variables: {
                handle: collectionHandle,
                first: 250,
                after: cursor,
                reverse: !!reverse,
            },
        });

        const json = await resp.json();
        if (json?.errors?.length) {
            const msg = json.errors.map((e) => e.message).join(" | ");
            throw new Error(msg);
        }

        const productsConn = json?.data?.collectionByHandle?.products;
        if (!productsConn) return [];

        for (const edge of productsConn.edges || []) {
            const h = edge?.node?.handle;
            if (h) handles.push(String(h).trim());
        }

        hasNextPage = !!productsConn.pageInfo?.hasNextPage;
        cursor = productsConn.pageInfo?.endCursor || null;
    }

    return handles;
}

/**
 * Reorder Supabase handles to match Shopify order.
 * - Keeps only handles that exist in Supabase list, in Shopify order.
 * - Appends any extra Supabase handles not found in the Shopify collection at the end.
 */
function reorderHandlesByShopifyOrder(supabaseHandles, shopifyOrderedHandles) {
    const supSet = new Set((supabaseHandles || []).map((h) => String(h).trim()).filter(Boolean));

    const ordered = [];
    for (const h of shopifyOrderedHandles || []) {
        const key = String(h).trim();
        if (supSet.has(key)) {
            ordered.push(key);
            supSet.delete(key);
        }
    }

    // append leftovers
    for (const h of supabaseHandles || []) {
        const key = String(h).trim();
        if (supSet.has(key)) {
            ordered.push(key);
            supSet.delete(key);
        }
    }

    return ordered;
}

/* ─────────────────────────────────────────────
   Proxy Loader
───────────────────────────────────────────── */
export async function loader({ request }) {
    try {
        // 1) Verify App Proxy request
        const { admin } = await authenticate.public.appProxy(request);
        if (!admin) return new Response("Unauthorized", { status: 401 });

        const url = new URL(request.url);

        // Shopify app proxy usually includes ?shop=xxx.myshopify.com
        const shop = (url.searchParams.get("shop") || "").trim().toLowerCase();

        const collectionHandle = (url.searchParams.get("collection_handle") || "").trim();
        const gradeSelected = (url.searchParams.get("grade") || "").trim();
        const productHandle = (url.searchParams.get("product_handle") || "").trim();

        if (!collectionHandle) {
            return new Response(JSON.stringify({ ok: false, error: "Missing collection_handle" }), {
                status: 400,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }

        const supabase = getSupabaseAdmin();

        // 2) Resolve collectionId from Shopify (needed because settings unique key is shop+collection_id)
        let collectionId = "";
        try {
            collectionId = await fetchCollectionIdByHandle(admin, collectionHandle);
        } catch {
            collectionId = "";
        }

        // 3) Read sort order from settings, map to Shopify sort
        const sortOrder = await getCollectionSortOrder(supabase, { shop, collectionId });
        const sortSpec = mapSortToShopify(sortOrder);

        // 4) Fetch rows from Supabase
        let rows = [];
        let error = null;

        // PRODUCT MODE: return grades for a specific product inside a collection
        if (productHandle) {
            const res = await supabase
                .from(EXTERNAL_TABLE)
                .select("product_handle, grade, collection_handle")
                .eq("collection_handle", collectionHandle)
                .eq("product_handle", productHandle);

            rows = res.data || [];
            error = res.error || null;
        } else {
            const res = await supabase
                .from(EXTERNAL_TABLE)
                .select("product_handle, grade, shopify_product_id, collection_id, collection_handle")
                .eq("collection_handle", collectionHandle)
                .not("product_handle", "is", null);

            rows = res.data || [];
            error = res.error || null;
        }

        if (error) {
            return new Response(JSON.stringify({ ok: false, error: error.message || "Supabase error" }), {
                status: 500,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }

        const safeRows = rows || [];

        // ── PRODUCT MODE RESPONSE ──────────────────
        if (productHandle) {
            const gradeSet = new Set();
            for (const r of safeRows) {
                for (const g of splitGrades(r.grade)) gradeSet.add(g);
            }

            const grades = Array.from(gradeSet).sort((a, b) => Number(a) - Number(b));

            return new Response(
                JSON.stringify({
                    ok: true,
                    mode: "product",
                    shop,
                    collection_handle: collectionHandle,
                    collection_id: collectionId || null,
                    sort_order: sortOrder,
                    product_handle: productHandle,
                    grades,
                    grades_csv: grades.join(","),
                }),
                {
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
                    },
                }
            );
        }

        // ── COLLECTION MODE RESPONSE ───────────────

        // Available grades (full list for that collection)
        const gradeSet = new Set();
        for (const r of safeRows) {
            for (const g of splitGrades(r.grade)) gradeSet.add(g);
        }
        const available_grades = Array.from(gradeSet).sort((a, b) => Number(a) - Number(b));

        // Apply grade filter
        const filteredRows = gradeSelected
            ? safeRows.filter((r) => splitGrades(r.grade).includes(gradeSelected))
            : safeRows;

        // gradeByHandle based on filtered rows
        const gradeByHandleSet = {};
        for (const r of filteredRows) {
            const h = (r.product_handle || "").trim();
            if (!h) continue;

            if (!gradeByHandleSet[h]) gradeByHandleSet[h] = new Set();
            for (const g of splitGrades(r.grade)) gradeByHandleSet[h].add(g);
        }

        // Unique handles from filtered rows
        const supabaseHandles = Array.from(
            new Set(
                filteredRows
                    .map((r) => (r.product_handle || "").trim())
                    .filter(Boolean)
            )
        );

        const gradeByHandle = {};
        for (const h of supabaseHandles) {
            const set = gradeByHandleSet[h];
            gradeByHandle[h] = set ? Array.from(set).join(",") : "";
        }

        // 5) Fetch Shopify handles in desired order, then reorder supabase handles
        let shopifyOrderedHandles = [];
        try {
            shopifyOrderedHandles = await fetchShopifyCollectionHandles(admin, collectionHandle, sortSpec);
        } catch {
            shopifyOrderedHandles = [];
        }

        const handles =
            shopifyOrderedHandles && shopifyOrderedHandles.length
                ? reorderHandlesByShopifyOrder(supabaseHandles, shopifyOrderedHandles)
                : supabaseHandles;

        return new Response(
            JSON.stringify({
                ok: true,
                mode: "collection",
                shop,
                collection_handle: collectionHandle,
                collection_id: collectionId || null,
                sort_order: sortOrder,
                sort_spec: sortSpec,
                grade_selected: gradeSelected || null,
                total_handles: handles.length,
                handles,
                available_grades,
                gradeByHandle,
            }),
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
                },
            }
        );
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || "Server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }
}