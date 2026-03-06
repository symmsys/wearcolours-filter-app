// app/routes/apps.school-products.jsx
// App Proxy endpoint: /apps/school-products
//
// TITLE-ONLY SORTING VERSION (NO NEW COLUMNS / NO EXTRA DATA)
// - Reads default_sort_order from settings using collection_id
// - Fetches rows from product_grade_collection by collection_id
// - De-dupes by product_handle
// - Sorts ONLY by product_title (A→Z / Z→A)
// - Returns handles in that sorted order

import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

const EXTERNAL_TABLE = "product_grade_collection";
const SETTINGS_TABLE = "settings";

const DEFAULT_SORT = "TITLE_ASC";

/* ---------------- Helpers ---------------- */

function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

function clean(v) {
    return String(v ?? "").trim();
}

/**
 * Get Shopify collection id from handle (we only use Shopify for THIS lookup)
 * Because your URL provides collection_handle, but your DB is keyed by collection_id.
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
        throw new Error(json.errors.map((e) => e.message).join(" | "));
    }

    const col = json?.data?.collectionByHandle;
    return col?.id ? String(col.id) : "";
}

/**
 * Read sort order from settings table by collection_id ONLY
 */
async function getCollectionSortOrder(supabase, collectionId) {
    if (!collectionId) return DEFAULT_SORT;

    const { data, error } = await supabase
        .from(SETTINGS_TABLE)
        .select("default_sort_order")
        .eq("collection_id", collectionId)
        .maybeSingle();

    if (error || !data) return DEFAULT_SORT;

    const v = clean(data.default_sort_order).toUpperCase();

    const ALLOWED_SORTS = new Set([
        "TITLE_ASC",
        "TITLE_DESC",
        "PRICE_ASC",
        "PRICE_DESC",
        "CREATED_ASC",
        "CREATED_DESC",
        "BEST_SELLING"
    ]);

    return ALLOWED_SORTS.has(v) ? v : DEFAULT_SORT;
}

/* ---------------- Proxy Loader ---------------- */

export async function loader({ request }) {
    try {
        const { admin } = await authenticate.public.appProxy(request);
        if (!admin) return new Response("Unauthorized", { status: 401 });

        const url = new URL(request.url);

        const collectionHandle = clean(url.searchParams.get("collection_handle"));
        const gradeSelected = clean(url.searchParams.get("grade"));
        const productHandle = clean(url.searchParams.get("product_handle"));

        if (!collectionHandle) {
            return new Response(JSON.stringify({ ok: false, error: "Missing collection_handle" }), {
                status: 400,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }

        const supabase = getSupabaseAdmin();

        // 1) resolve collection_id from Shopify
        const collectionId = await fetchCollectionIdByHandle(admin, collectionHandle);
        if (!collectionId) {
            return new Response(JSON.stringify({ ok: false, error: "Collection not found in Shopify" }), {
                status: 404,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }

        // 2) read sort preference from settings (by collection_id)
        const sortOrder = await getCollectionSortOrder(supabase, collectionId);

        // 3) fetch rows from product_grade_collection (by collection_id)
        let query = supabase
            .from(EXTERNAL_TABLE)
            .select("*")
            .eq("collection_id", collectionId)
            .not("product_handle", "is", null);

        if (productHandle) {
            query = query.eq("product_handle", productHandle);
        }

        const { data: rows, error } = await query;

        if (error) {
            return new Response(JSON.stringify({ ok: false, error: error.message || "Supabase error" }), {
                status: 500,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }

        const safeRows = rows || [];

        // PRODUCT MODE (grades for one product)
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
                    collection_id: collectionId,
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

        // COLLECTION MODE

        // available grades
        const gradeSet = new Set();
        for (const r of safeRows) {
            for (const g of splitGrades(r.grade)) gradeSet.add(g);
        }
        const available_grades = Array.from(gradeSet).sort((a, b) => Number(a) - Number(b));

        // grade filter
        const filteredRows = gradeSelected
            ? safeRows.filter((r) => splitGrades(r.grade).includes(gradeSelected))
            : safeRows;

        // build gradeByHandleSet (so you can show grades per handle)
        const gradeByHandleSet = {};
        for (const r of filteredRows) {
            const h = clean(r.product_handle);
            if (!h) continue;
            if (!gradeByHandleSet[h]) gradeByHandleSet[h] = new Set();
            for (const g of splitGrades(r.grade)) gradeByHandleSet[h].add(g);
        }

        // de-dupe to one row per handle
        // if multiple rows exist per handle, keep the one that has a product_title
        const rowByHandle = new Map();
        for (const r of filteredRows) {
            const h = clean(r.product_handle);
            if (!h) continue;

            if (!rowByHandle.has(h)) {
                rowByHandle.set(h, r);
                continue;
            }

            const existing = rowByHandle.get(h);
            const existingTitle = clean(existing?.product_title);
            const newTitle = clean(r?.product_title);

            // Prefer the row that actually has a title
            if (!existingTitle && newTitle) rowByHandle.set(h, r);
        }

        const uniqueRows = Array.from(rowByHandle.values());
        const handles = uniqueRows
            .map((r) => clean(r.product_handle))
            .filter(Boolean);




        const gradeByHandle = {};
        for (const h of handles) {
            const set = gradeByHandleSet[h];
            gradeByHandle[h] = set ? Array.from(set).join(",") : "";
        }

        return new Response(
            JSON.stringify({
                ok: true,
                mode: "collection",
                collection_handle: collectionHandle,
                collection_id: collectionId,
                sort_order: sortOrder,
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