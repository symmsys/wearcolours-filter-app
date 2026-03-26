import { getSupabaseAdmin } from "../supabase.server";

const EXTERNAL_TABLE = "product_grade_collection";
const MASTER_TABLE = "master database colours";

function cleanText(v) {
    return String(v ?? "").trim();
}

function uniqStrings(arr) {
    const out = [];
    const seen = new Set();

    for (const v of arr || []) {
        const s = cleanText(v);
        if (!s) continue;

        const key = s.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        out.push(s);
    }

    return out;
}

async function parseGraphql(res, { nodeGetter, nodeName = "operations" } = {}) {
    const json = await res.json();

    const gqlErr =
        Array.isArray(json?.errors) && json.errors.length
            ? json.errors.map((e) => e?.message || String(e)).join(" | ")
            : null;

    if (gqlErr) throw new Error(gqlErr);

    if (!nodeGetter) return json;

    const node = nodeGetter(json);
    if (!node) throw new Error(`${nodeName} returned no data`);

    const ue =
        Array.isArray(node?.userErrors) && node.userErrors.length
            ? node.userErrors.map((e) => e?.message || String(e)).join(" | ")
            : null;

    if (ue) throw new Error(ue);

    return { json, node };
}

async function fetchProductByHandleWithCollectionsAndSizes(admin, handle) {
    const res = await admin.graphql(
        `#graphql
      query ProductByHandle($handle: String!, $cFirst: Int!, $cAfter: String) {
        productByHandle(handle: $handle) {
          id
          title
          handle
          variants(first: 250) {
            edges { node { selectedOptions { name value } } }
          }
          collections(first: $cFirst, after: $cAfter) {
            pageInfo { hasNextPage endCursor }
            edges { node { id title handle } }
          }
        }
      }
    `,
        { variables: { handle, cFirst: 250, cAfter: null } }
    );

    const json = await parseGraphql(res);
    const p = json?.data?.productByHandle;
    if (!p?.id) return null;

    const variantEdges = p?.variants?.edges || [];
    const sizes = [];

    for (const ve of variantEdges) {
        const opts = ve?.node?.selectedOptions || [];
        for (const o of opts) {
            if (String(o?.name || "").toLowerCase() === "size" && o?.value) {
                sizes.push(o.value);
            }
        }
    }

    let cols = (p.collections?.edges || []).map((e) => e.node).filter(Boolean);
    let after = p.collections?.pageInfo?.endCursor || null;
    let hasNext = !!p.collections?.pageInfo?.hasNextPage;

    while (hasNext) {
        const res2 = await admin.graphql(
            `#graphql
        query ProductCollections($handle: String!, $first: Int!, $after: String) {
          productByHandle(handle: $handle) {
            collections(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { id title handle } }
            }
          }
        }
      `,
            { variables: { handle, first: 250, after } }
        );

        const json2 = await parseGraphql(res2);
        const conn = json2?.data?.productByHandle?.collections;
        const edges = conn?.edges || [];

        cols = cols.concat(edges.map((e) => e.node).filter(Boolean));
        hasNext = !!conn?.pageInfo?.hasNextPage;
        after = conn?.pageInfo?.endCursor || null;

        if (!after) break;
    }

    const seen = new Set();
    const uniqCols = [];

    for (const c of cols) {
        const id = String(c?.id || "");
        if (!id || seen.has(id)) continue;

        seen.add(id);
        uniqCols.push({
            id,
            title: c?.title || "",
            handle: c?.handle || "",
        });
    }

    return {
        id: p.id,
        title: p.title || "",
        handle: p.handle || "",
        sizes: uniqStrings(sizes),
        collections: uniqCols,
    };
}


export async function processOneSyncBatch({ admin, jobId }) {
    const supabase = getSupabaseAdmin();

    const { data: job, error: jobErr } = await supabase
        .from("sync_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

    if (jobErr) throw new Error(jobErr.message);
    if (!job) throw new Error("Sync job not found");

    if (job.cancel_requested) {
        await supabase
            .from("sync_jobs")
            .update({
                status: "cancelled",
                updated_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
            })
            .eq("id", job.id);

        return { done: true, cancelled: true };
    }

    const batchOffset = Number(job.batch_offset || 0);
    const batchLimit = Number(job.batch_limit || 50);

    await supabase
        .from("sync_jobs")
        .update({
            status: "running",
            started_at: job.started_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            error_message: null,
        })
        .eq("id", job.id);

    const { data: masterRows, error: masterErr, count: masterTotal } = await supabase
        .from(MASTER_TABLE)
        .select('"Handle","Grade"', { count: "exact" })
        .range(batchOffset, batchOffset + batchLimit - 1);

    if (masterErr) {
        await supabase
            .from("sync_jobs")
            .update({
                status: "failed",
                error_message: masterErr.message,
                updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);

        throw new Error(masterErr.message);
    }

    const rows = masterRows || [];
    const batchFetched = rows.length;

    if (batchFetched === 0) {
        await supabase
            .from("sync_jobs")
            .update({
                status: "completed",
                total_master: typeof masterTotal === "number" ? masterTotal : job.total_master,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);

        return {
            done: true,
            summary: {
                batchFetched: 0,
            },
        };
    }

    const handleToGrade = new Map();

    for (const r of rows) {
        const handleRaw = cleanText(r?.Handle);
        if (!handleRaw) continue;

        const key = handleRaw.toLowerCase();
        const grade = cleanText(r?.Grade);

        if (!handleToGrade.has(key)) {
            handleToGrade.set(key, { handleRaw, grade });
        } else {
            const prev = handleToGrade.get(key);
            if ((!prev?.grade || prev.grade === "") && grade) {
                handleToGrade.set(key, {
                    handleRaw: prev?.handleRaw || handleRaw,
                    grade,
                });
            }
        }
    }

    const keys = Array.from(handleToGrade.keys());

    let uniqueHandles = keys.length;
    let updatedHandles = 0;
    let updatedRows = 0;
    let insertedProducts = 0;
    let insertedRows = 0;
    let missingInShopify = 0;

    for (const hKey of keys) {
        const entry = handleToGrade.get(hKey);
        const handleRaw = entry?.handleRaw || hKey;
        const grade = cleanText(entry?.grade);

        const { data: existing, error: existErr } = await supabase
            .from(EXTERNAL_TABLE)
            .select("id,size")
            .ilike("product_handle", handleRaw);

        if (existErr) throw new Error(existErr.message);

        const exists = Array.isArray(existing) && existing.length > 0;

        if (exists) {
            const mergedSizes = [];

            for (const row of existing) {
                const s = row?.size;
                if (Array.isArray(s)) mergedSizes.push(...s);
                else if (typeof s === "string" && s.trim()) mergedSizes.push(s.trim());
            }

            const mergedSizeArray = uniqStrings(mergedSizes);

            const { data: updData, error: updErr, count } = await supabase
                .from(EXTERNAL_TABLE)
                .update({
                    grade: grade || null,
                    size: mergedSizeArray.length ? mergedSizeArray : null,
                    updated_at: new Date().toISOString(),
                })
                .ilike("product_handle", handleRaw)
                .select("id", { count: "exact" });

            if (updErr) throw new Error(updErr.message);

            updatedHandles += 1;
            if (typeof count === "number") updatedRows += count;
            else if (Array.isArray(updData)) updatedRows += updData.length;

            continue;
        }

        const prod = await fetchProductByHandleWithCollectionsAndSizes(admin, handleRaw);

        if (!prod?.id) {
            missingInShopify += 1;
            continue;
        }

        const cols = prod.collections || [];
        if (cols.length === 0) continue;

        const upsertRecords = cols.map((c) => ({
            shopify_product_id: prod.id,
            product_title: prod.title || null,
            product_handle: prod.handle || handleRaw || null,
            collection_id: c.id || null,
            collection_title: c.title || null,
            collection_handle: c.handle || null,
            grade: grade || null,
            size: prod.sizes && prod.sizes.length ? prod.sizes : null,
            updated_at: new Date().toISOString(),
        }));

        const { data: insData, error: insErr } = await supabase
            .from(EXTERNAL_TABLE)
            .upsert(upsertRecords, { onConflict: "shopify_product_id,collection_id" })
            .select("id");

        if (insErr) throw new Error(insErr.message);

        insertedProducts += 1;
        if (Array.isArray(insData)) insertedRows += insData.length;
        else insertedRows += upsertRecords.length;
    }

    const nextBatchOffset = batchOffset + batchLimit;
    const total = typeof masterTotal === "number" ? masterTotal : job.total_master;
    const hasMore = total == null ? true : nextBatchOffset < total;

    await supabase
        .from("sync_jobs")
        .update({
            status: hasMore ? "running" : "completed",
            batch_offset: nextBatchOffset,
            total_master: total,
            batches: Number(job.batches || 0) + 1,
            unique_handles: Number(job.unique_handles || 0) + uniqueHandles,
            updated_handles: Number(job.updated_handles || 0) + updatedHandles,
            updated_rows: Number(job.updated_rows || 0) + updatedRows,
            inserted_products: Number(job.inserted_products || 0) + insertedProducts,
            inserted_rows: Number(job.inserted_rows || 0) + insertedRows,
            missing_in_shopify: Number(job.missing_in_shopify || 0) + missingInShopify,
            updated_at: new Date().toISOString(),
            completed_at: hasMore ? null : new Date().toISOString(),
            error_message: null,
        })
        .eq("id", job.id);

    return {
        done: !hasMore,
        summary: {
            batchOffset,
            batchLimit,
            batchFetched,
            nextBatchOffset,
            hasMore,
            total,
            uniqueHandles,
            updatedHandles,
            updatedRows,
            insertedProducts,
            insertedRows,
            missingInShopify,
        },
    };
}
