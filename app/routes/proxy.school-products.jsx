import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
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


        // Optional pagination for speed
        const limit = Math.max(1, Math.min(48, Number(url.searchParams.get("limit") || 24)));
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const offset = (page - 1) * limit;

        if (!collectionHandle) {
            return new Response(
                JSON.stringify({ ok: false, error: "Missing collection_handle" }),
                { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
            );
        }

        // 2) Fetch mapping rows from Supabase (ONLY what we need)
        const supabase = getSupabaseAdmin();

        let rows = [];
        let error = null;

        if (productHandle) {
            // PRODUCT MODE: fetch only this product in this collection
            const res = await supabase
                .from("product_grade_collection")
                .select("product_handle, grade, collection_handle")
                .eq("collection_handle", collectionHandle)
                .eq("product_handle", productHandle);

            rows = res.data || [];
            error = res.error || null;
        } else {
            // COLLECTION MODE: keep your current behavior
            const res = await supabase
                .from("product_grade_collection")
                .select("product_handle, grade, shopify_product_id, collection_id, collection_handle")
                .eq("collection_handle", collectionHandle)
                .not("product_handle", "is", null)
                .order("updated_at", { ascending: false });

            rows = res.data || [];
            error = res.error || null;
        }


        if (error) {
            return new Response(
                JSON.stringify({ ok: false, error: error.message || "Supabase error" }),
                { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
            );
        }

        const safeRows = rows || [];

        // PRODUCT MODE RESPONSE (does not affect collection mode)
        if (productHandle) {
            const gradeSet = new Set();
            for (const r of safeRows) {
                for (const g of splitGrades(r.grade)) gradeSet.add(g);
            }

            const grades = Array.from(gradeSet).sort();

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


        // 3) Build available grades for this school (for dropdown)
        const gradeSet = new Set();
        for (const r of safeRows) {
            for (const g of splitGrades(r.grade)) gradeSet.add(g);
        }
        const available_grades = Array.from(gradeSet).sort();

        // 4) Grade filter
        const filteredRows = gradeSelected
            ? safeRows.filter((r) => splitGrades(r.grade).includes(gradeSelected))
            : safeRows;

        // 5) Unique handles + gradeByHandle
        const gradeByHandleSet = {};
        for (const r of filteredRows) {
            const h = (r.product_handle || "").trim();
            if (!h) continue;

            if (!gradeByHandleSet[h]) gradeByHandleSet[h] = new Set();
            for (const g of splitGrades(r.grade)) gradeByHandleSet[h].add(g);
        }

        const allHandles = Array.from(new Set(filteredRows.map((r) => (r.product_handle || "").trim()).filter(Boolean)));

        // 6) Apply pagination to handles (faster first render)
        const pagedHandles = allHandles.slice(offset, offset + limit);

        // 7) Build gradeByHandle output (only for returned handles)
        const gradeByHandle = {};
        for (const h of pagedHandles) {
            const set = gradeByHandleSet[h];
            gradeByHandle[h] = set ? Array.from(set).join(",") : "all";
        }

        // 8) Return ONLY mapping data (fast)
        return new Response(
            JSON.stringify({
                ok: true,
                collection_handle: collectionHandle,
                grade_selected: gradeSelected || null,

                page,
                limit,
                total_handles: allHandles.length,
                handles: pagedHandles,

                available_grades,
                gradeByHandle,
            }),
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    // Small cache helps a lot; adjust as needed
                    "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
                },
            }
        );
    } catch (e) {
        return new Response(
            JSON.stringify({ ok: false, error: e?.message || "Server error" }),
            { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
    }
}
