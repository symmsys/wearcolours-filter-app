// app/routes/apps.school-products.jsx
// App Proxy endpoint: /apps/school-products

import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

const EXTERNAL_TABLE = "product_grade_collection";
const SETTINGS_TABLE = "settings";
const MANUAL_SORT_TABLE = "product_sort_order";

const DEFAULT_SORT = "MANUAL";

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
 * Get Shopify collection id from handle
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
 * Read sort order from settings table by collection_id
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
        "BEST_SELLING",
        "MANUAL",
    ]);

    return ALLOWED_SORTS.has(v) ? v : DEFAULT_SORT;
}

/**
 * Fetch manual sort row for one collection + grade context
 */
async function getManualSortRow(supabase, collectionId, grade = "") {
    const safeCollectionId = clean(collectionId);
    const safeGrade = clean(grade);

    if (!safeCollectionId) return null;

    const { data, error } = await supabase
        .from(MANUAL_SORT_TABLE)
        .select("school_id, grade, product_order, grade_override, status")
        .eq("school_id", safeCollectionId)
        .eq("grade", safeGrade)
        .eq("status", 1)
        .maybeSingle();

    if (error) {
        throw new Error(error.message || "Failed to fetch manual sort row");
    }

    return data || null;
}

/**
 * Resolve which manual order should be used
 *
 * Rule:
 * - collection-level row (grade="") is default order
 * - grade-specific row is used only if grade_override === true
 */
async function resolveManualSortRow(supabase, collectionId, gradeSelected = "") {
    const safeGrade = clean(gradeSelected);

    // collection-level row is always the default order
    const collectionRow = await getManualSortRow(supabase, collectionId, "");

    // if no grade selected, use collection default only
    if (!safeGrade) {
        return collectionRow;
    }

    // if grade selected, check grade-specific row
    const gradeRow = await getManualSortRow(supabase, collectionId, safeGrade);

    // use grade row only when override is true
    if (gradeRow && gradeRow.grade_override === true) {
        return gradeRow;
    }

    // otherwise keep collection-level default order
    return collectionRow;
}

/**
 * Reorder current valid handles using saved manual handles
 * - keeps only valid handles
 * - appends missing/new valid handles at the end
 */
function applyManualOrder(validHandles, manualHandles) {
    const safeValidHandles = Array.isArray(validHandles) ? validHandles : [];
    const safeManualHandles = Array.isArray(manualHandles) ? manualHandles : [];

    const validSet = new Set(safeValidHandles);

    const ordered = safeManualHandles.filter((h) => validSet.has(clean(h)));
    const orderedSet = new Set(ordered);

    const missing = safeValidHandles.filter((h) => !orderedSet.has(h));

    return [...ordered, ...missing];
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

        // 2) read sort preference from settings
        const sortOrder = await getCollectionSortOrder(supabase, collectionId);

        // 3) fetch rows from product_grade_collection
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
                        Pragma: "no-cache",
                        Expires: "0",
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

        // build gradeByHandleSet
        const gradeByHandleSet = {};
        for (const r of filteredRows) {
            const h = clean(r.product_handle);
            if (!h) continue;

            if (!gradeByHandleSet[h]) gradeByHandleSet[h] = new Set();
            for (const g of splitGrades(r.grade)) gradeByHandleSet[h].add(g);
        }

        // de-dupe to one row per handle
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

            if (!existingTitle && newTitle) rowByHandle.set(h, r);
        }

        const uniqueRows = Array.from(rowByHandle.values());

        let handles = uniqueRows
            .map((r) => clean(r.product_handle))
            .filter(Boolean);

        // APPLY MANUAL ORDER ONLY WHEN SETTINGS SAY MANUAL
        if (sortOrder === "MANUAL") {
            const manualRow = await resolveManualSortRow(supabase, collectionId, gradeSelected);

            const manualHandles = manualRow?.product_order?.handles || [];
            handles = applyManualOrder(handles, manualHandles);
        }

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
                    Pragma: "no-cache",
                    Expires: "0",
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