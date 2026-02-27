import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

/**
 * Fetch product handles in the SAME order as the collection is sorted in Shopify Admin.
 * This is the “manual / collection default” order.
 */
async function fetchShopifyCollectionHandlesInOrder(admin, collectionHandle) {
    const handles = [];
    let cursor = null;
    let hasNextPage = true;

    // We try COLLECTION_DEFAULT first (best match for Shopify Admin manual order).
    // If Shopify ever rejects the sortKey, we fallback to default (no sortKey).
    const queryWithSortKey = `#graphql
    query CollectionProducts($handle: String!, $first: Int!, $after: String) {
      collectionByHandle(handle: $handle) {
        id
        products(first: $first, after: $after, sortKey: COLLECTION_DEFAULT) {
          pageInfo { hasNextPage endCursor }
          edges { node { handle } }
        }
      }
    }
  `;

    const queryNoSortKey = `#graphql
    query CollectionProducts($handle: String!, $first: Int!, $after: String) {
      collectionByHandle(handle: $handle) {
        id
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { handle } }
        }
      }
    }
  `;

    async function runQuery(query) {
        handles.length = 0;
        cursor = null;
        hasNextPage = true;

        while (hasNextPage) {
            const resp = await admin.graphql(query, {
                variables: { handle: collectionHandle, first: 250, after: cursor },
            });

            const json = await resp.json();
            if (json.errors?.length) {
                const msg = json.errors.map((e) => e.message).join(" | ");
                throw new Error(msg);
            }

            const productsConn = json?.data?.collectionByHandle?.products;
            if (!productsConn) return []; // collection not found / no products

            for (const edge of productsConn.edges || []) {
                const h = edge?.node?.handle;
                if (h) handles.push(String(h).trim());
            }

            hasNextPage = !!productsConn.pageInfo?.hasNextPage;
            cursor = productsConn.pageInfo?.endCursor || null;
        }

        return handles;
    }

    // 1) try with sortKey
    try {
        return await runQuery(queryWithSortKey);
    } catch (e) {
        // 2) fallback to default (Shopify might still return collection order by default)
        try {
            return await runQuery(queryNoSortKey);
        } catch (e2) {
            // If Shopify fails completely, return empty (caller will keep Supabase order)
            return [];
        }
    }
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
            shopifyOrderedHandles = await fetchShopifyCollectionHandlesInOrder(admin, collectionHandle);
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