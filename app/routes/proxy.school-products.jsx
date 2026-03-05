import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

const SETTINGS_TABLE = "settings";
const DEFAULT_SORT = "COLLECTION_DEFAULT"; // fallback if nothing stored

async function getCollectionSortOrder(supabase, { shop, collectionHandle }) {
    if (!shop || !collectionHandle) return DEFAULT_SORT;

    const { data, error } = await supabase
        .from(SETTINGS_TABLE)
        .select("default_sort_order")
        .eq("shop", shop)
        .eq("collection_handle", collectionHandle)
        .maybeSingle();

    if (error) return DEFAULT_SORT;

    const v = String(data?.default_sort_order || "").trim();
    return v || DEFAULT_SORT;
}

function mapSortToShopify(sortOrder) {
    const s = String(sortOrder || "").trim();

    // Manual / client set order in Admin
    if (!s || s === "COLLECTION_DEFAULT") {
        return { sortKey: "COLLECTION_DEFAULT", reverse: false };
    }

    // Your settings options
    if (s === "TITLE_ASC") return { sortKey: "TITLE", reverse: false };
    if (s === "TITLE_DESC") return { sortKey: "TITLE", reverse: true };

    if (s === "PRICE_ASC") return { sortKey: "PRICE", reverse: false };
    if (s === "PRICE_DESC") return { sortKey: "PRICE", reverse: true };

    // Shopify best-selling is already “best selling first”
    if (s === "BEST_SELLING") return { sortKey: "BEST_SELLING", reverse: false };

    // CREATED: we want newest first for CREATED_DESC
    if (s === "CREATED_DESC") return { sortKey: "CREATED", reverse: true };
    if (s === "CREATED_ASC") return { sortKey: "CREATED", reverse: false };

    return { sortKey: "COLLECTION_DEFAULT", reverse: false };
}

function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

// Fetch ALL product handles in the collection, in Shopify Admin order (with pagination).
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
            variables: { handle: collectionHandle, first: 250, after: cursor, reverse: !!reverse },
        });

        const json = await resp.json();
        if (json.errors?.length) {
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
 * Reorder Supabase handles to match Shopify collection order.
 * - Keeps ONLY handles that exist in Supabase list, in Shopify order.
 * - Appends any extra Supabase handles not found in collection at the end.
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

    // Append leftovers (still keep them, but after Shopify-ordered items)
    for (const h of supabaseHandles || []) {
        const key = String(h).trim();
        if (supSet.has(key)) {
            ordered.push(key);
            supSet.delete(key);
        }
    }

    return ordered;
}

export async function loader({ request }) {
    try {
        // 1) Verify App Proxy request
        const { admin } = await authenticate.public.appProxy(request);
        if (!admin) return new Response("Unauthorized", { status: 401 });

        const url = new URL(request.url);

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

        const sortOrder = await getCollectionSortOrder(supabase, {
            shop,
            collectionHandle,
        });

        const sortSpec = mapSortToShopify(sortOrder);

        let rows = [];
        let error = null;

        if (productHandle) {
            const res = await supabase
                .from("product_grade_collection")
                .select("product_handle, grade, collection_handle")
                .eq("collection_handle", collectionHandle)
                .eq("product_handle", productHandle);

            rows = res.data || [];
            error = res.error || null;
        } else {
            const res = await supabase
                .from("product_grade_collection")
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

        // PRODUCT MODE
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
                    collection_handle: collectionHandle,
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

        // Build available grades
        const gradeSet = new Set();
        for (const r of safeRows) {
            for (const g of splitGrades(r.grade)) gradeSet.add(g);
        }
        const available_grades = Array.from(gradeSet).sort((a, b) => Number(a) - Number(b));

        // Grade filter (keeps gradeByHandle correct)
        const filteredRows = gradeSelected
            ? safeRows.filter((r) => splitGrades(r.grade).includes(gradeSelected))
            : safeRows;

        // Unique handles + gradeByHandle
        const gradeByHandleSet = {};
        for (const r of filteredRows) {
            const h = (r.product_handle || "").trim();
            if (!h) continue;

            if (!gradeByHandleSet[h]) gradeByHandleSet[h] = new Set();
            for (const g of splitGrades(r.grade)) gradeByHandleSet[h].add(g);
        }

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

        // ✅ IMPORTANT: reorder by Shopify Admin manual order
        // (If Shopify fails, we keep Supabase order as fallback)
        let shopifyOrderedHandles = [];
        try {
            shopifyOrderedHandles = await fetchShopifyCollectionHandles(admin, collectionHandle, sortSpec);
        } catch (e) {
            shopifyOrderedHandles = [];
        }

        const handles =
            shopifyOrderedHandles && shopifyOrderedHandles.length
                ? reorderHandlesByShopifyOrder(supabaseHandles, shopifyOrderedHandles)
                : supabaseHandles;

        return new Response(
            JSON.stringify({
                ok: true,
                collection_handle: collectionHandle,
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