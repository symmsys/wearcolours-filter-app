// app/routes/home.products.jsx

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import { DeleteIcon } from "@shopify/polaris-icons";

import {
    Page,
    Layout,
    Card,
    Icon,
    IndexTable,
    Text,
    TextField,
    Button,
    InlineStack,
    BlockStack,
    Banner,
    Select,
    Pagination,
    Badge,
} from "@shopify/polaris";

const EXTERNAL_TABLE = "product_grade_collection";
const MASTER_TABLE = "master database colours"; // exact name, with spaces

// Only allow these collections in dropdown
const ALLOWED_COLLECTION_IDS = new Set([
    "gid://shopify/Collection/276875509831",
    "gid://shopify/Collection/276875247687",
    "gid://shopify/Collection/276875411527",
    "gid://shopify/Collection/276875280455",
    "gid://shopify/Collection/276875444295",
    "gid://shopify/Collection/282935689287",
]);

// Shopify metafield: custom.grade
const GRADE_NAMESPACE = "custom";
const GRADE_KEY = "grade";
const GRADE_TYPE = "single_line_text_field";

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
      metafields { id namespace key value }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = `#graphql
  mutation CollectionAddProducts($collectionId: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $collectionId, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS = `#graphql
  mutation CollectionRemoveProducts($collectionId: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $collectionId, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

function cleanText(v) {
    return String(v ?? "").trim();
}

function toInt(v, fallback = 0) {
    const n = Number.parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
}

function uniqStrings(arr) {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
        const s = cleanText(v);
        if (!s) continue;
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
    }
    return out;
}

function getGqlErrors(json) {
    const errs = json?.errors;
    if (Array.isArray(errs) && errs.length) return errs.map((e) => e?.message || String(e)).join(" | ");
    return null;
}

function getUserErrors(node) {
    const errs = node?.userErrors;
    if (Array.isArray(errs) && errs.length) return errs.map((e) => e?.message || String(e)).join(" | ");
    return null;
}

async function parseGraphql(res, { nodeGetter, nodeName = "operation" } = {}) {
    const json = await res.json();
    const gqlErr = getGqlErrors(json);
    if (gqlErr) throw new Error(gqlErr);

    if (!nodeGetter) return json;

    const node = nodeGetter(json);
    if (!node) throw new Error(`${nodeName} returned no data`);

    const ue = getUserErrors(node);
    if (ue) throw new Error(ue);

    return { json, node };
}

async function fetchAllCollections(admin) {
    const all = [];
    let after = null;

    while (true) {
        const res = await admin.graphql(
            `#graphql
        query Collections($first: Int!, $after: String) {
          collections(first: $first, after: $after, sortKey: TITLE) {
            pageInfo { hasNextPage endCursor }
            edges { node { id title handle } }
          }
        }
      `,
            { variables: { first: 250, after } }
        );

        const json = await parseGraphql(res);
        const conn = json?.data?.collections;
        const edges = conn?.edges || [];

        for (const e of edges) {
            if (e?.node?.id) {
                all.push({
                    id: e.node.id,
                    title: e.node.title || "",
                    handle: e.node.handle || "",
                });
            }
        }

        const pageInfo = conn?.pageInfo;
        if (!pageInfo?.hasNextPage) break;
        after = pageInfo?.endCursor;
        if (!after) break;
    }

    return all;
}

async function fetchAgeSizeRangeMap(supabase, handles = []) {
    try {
        let query = supabase
            .from(MASTER_TABLE)
            .select('"Handle","Age Size Range"');

        if (Array.isArray(handles) && handles.length > 0) {
            query = query.in("Handle", handles);
        }

        const { data, error } = await query;
        if (error) {
            console.error("Error fetching Age Size Range:", error);
            return {};
        }

        const map = {};

        for (const row of data || []) {
            const handle = cleanText(row?.Handle).toLowerCase();
            if (!handle) continue;

            // keep first non-empty value
            if (!map[handle]) {
                map[handle] = cleanText(row?.["Age Size Range"]);
            }
        }

        return map;
    } catch (err) {
        console.error("fetchAgeSizeRangeMap error:", err);
        return {};
    }
}

async function fetchProductsWithGradeAndCollection(
    admin,
    supabase,
    { first = 50, after = null, search = "", collectionId = "" } = {}
) {
    const searchText = String(search || "").trim();

    /* ---------------- SEARCH MODE (Supabase global search) ---------------- */

    if (searchText) {
        const res = await admin.graphql(
            `#graphql
        query ProductsSearch($first: Int!, $query: String!) {
          products(first: $first, query: $query, sortKey: TITLE) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                handle
                metafield(namespace: "${GRADE_NAMESPACE}", key: "${GRADE_KEY}") { value }
                featuredImage { url altText }
                variants(first: 250) {
                  edges { node { selectedOptions { name value } } }
                }
                collections(first: 50) {
                  edges { node { id title handle } }
                }
              }
            }
          }
        }
        `,
            {
                variables: {
                    first,
                    query: searchText,
                },
            }
        );

        const json = await parseGraphql(res);
        const conn = json?.data?.products;
        const normalizedSearch = cleanText(searchText).toLowerCase();

        const shopifyItems = (conn?.edges || [])
            .map((e) => e?.node)
            .filter(Boolean)
            .sort((a, b) => {
                const aTitle = cleanText(a?.title).toLowerCase();
                const bTitle = cleanText(b?.title).toLowerCase();

                const aExact = aTitle === normalizedSearch ? 1 : 0;
                const bExact = bTitle === normalizedSearch ? 1 : 0;

                if (aExact !== bExact) return bExact - aExact;

                const aContains = aTitle.includes(normalizedSearch) ? 1 : 0;
                const bContains = bTitle.includes(normalizedSearch) ? 1 : 0;

                if (aContains !== bContains) return bContains - aContains;

                return aTitle.localeCompare(bTitle);
            });

        if (!shopifyItems.length) {
            return {
                items: [],
                hasNextPage: false,
                endCursor: null,
            };
        }

        const allHandles = shopifyItems
            .map((p) => cleanText(p.handle))
            .filter(Boolean);

        const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, allHandles);

        let savedQuery = supabase.from(EXTERNAL_TABLE).select("*").in("product_handle", allHandles);

        if (collectionId) {
            savedQuery = savedQuery.eq("collection_id", collectionId);
        }

        const { data: savedData, error: savedErr } = await savedQuery;
        if (savedErr) throw new Error(savedErr.message);

        const collectionsByProductId = {};
        if (Array.isArray(savedData)) {
            for (const record of savedData) {
                const pId = record.shopify_product_id;
                if (!pId) continue;

                if (!collectionsByProductId[pId]) collectionsByProductId[pId] = [];

                if (record.collection_id && record.collection_title) {
                    collectionsByProductId[pId].push({
                        id: record.collection_id,
                        title: record.collection_title,
                        handle: record.collection_handle || "",
                        grade: record.grade || "",
                    });
                }
            }
        }

        const products = shopifyItems
            .map((p) => {
                const variantEdges = p?.variants?.edges || [];

                const collectArray = (optName) => {
                    const vals = [];
                    for (const ve of variantEdges) {
                        const opts = ve?.node?.selectedOptions || [];
                        for (const o of opts) {
                            if (String(o.name || "").toLowerCase() === optName) vals.push(o.value);
                        }
                    }
                    return Array.from(new Set(vals)).filter((v) => v != null && String(v).trim() !== "");
                };

                const firstValue = (optName) => {
                    for (const ve of variantEdges) {
                        const opts = ve?.node?.selectedOptions || [];
                        for (const o of opts) {
                            if (String(o.name || "").toLowerCase() === optName && o.value) return o.value;
                        }
                    }
                    return null;
                };

                const firstCol = p?.collections?.edges?.[0]?.node || null;
                const savedCollections = collectionsByProductId[p.id] || [];

                return {
                    id: p.id,
                    title: p.title || "",
                    handle: p.handle || "",
                    grade: p?.metafield?.value || "",
                    imageUrl: p?.featuredImage?.url || "",
                    size: collectArray("size"),
                    size_type: firstValue("size type"),
                    size_range: firstValue("size range"),
                    age_size_range: ageSizeRangeMap[cleanText(p.handle).toLowerCase()] || "",
                    collectionId: savedCollections[0]?.id || firstCol?.id || "",
                    collectionTitle: savedCollections[0]?.title || firstCol?.title || "",
                    collectionHandle: savedCollections[0]?.handle || firstCol?.handle || "",
                    savedCollections,
                };
            })
            .filter((p) => {
                if (!collectionId) return true;
                return (p.savedCollections || []).some((c) => String(c.id) === String(collectionId));
            });

        return {
            items: products,
            hasNextPage: false,
            endCursor: null,
        };
    }

    if (!searchText && collectionId) {
        const numericOffset = Number.isFinite(Number(after)) ? Number(after) : 0;

        const { data: matchedRows, error: matchErr } = await supabase
            .from(EXTERNAL_TABLE)
            .select(`
            shopify_product_id,
            product_title,
            product_handle,
            collection_id,
            collection_title,
            collection_handle,
            grade
        `)
            .eq("collection_id", collectionId)
            .order("product_title", { ascending: true });

        if (matchErr) throw new Error(matchErr.message);

        const uniqueHandleMap = new Map();

        for (const row of matchedRows || []) {
            const handle = cleanText(row?.product_handle);
            if (!handle) continue;

            const key = handle.toLowerCase();

            if (!uniqueHandleMap.has(key)) {
                uniqueHandleMap.set(key, {
                    id: row?.shopify_product_id || "",
                    handle,
                    title: row?.product_title || "",
                    collection_id: cleanText(row?.collection_id),
                    collection_title: cleanText(row?.collection_title),
                    collection_handle: cleanText(row?.collection_handle),
                    grade: cleanText(row?.grade),
                });
            }
        }

        const matchedProducts = Array.from(uniqueHandleMap.values());

        if (!matchedProducts.length) {
            return {
                items: [],
                hasNextPage: false,
                endCursor: null,
            };
        }

        const pagedMatches = matchedProducts.slice(numericOffset, numericOffset + first);
        const nextOffset = numericOffset + first;
        const hasNextPage = nextOffset < matchedProducts.length;

        const handles = pagedMatches
            .map((entry) => cleanText(entry.handle))
            .filter(Boolean);

        const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, handles);

        const products = [];

        for (const entry of pagedMatches) {
            const res = await admin.graphql(
                `#graphql
            query ProductByHandle($handle: String!) {
              productByHandle(handle: $handle) {
                id
                title
                handle
                metafield(namespace: "${GRADE_NAMESPACE}", key: "${GRADE_KEY}") { value }
                featuredImage { url altText }
                variants(first: 250) {
                  edges { node { selectedOptions { name value } } }
                }
              }
            }
            `,
                { variables: { handle: entry.handle } }
            );

            const json = await parseGraphql(res);
            const p = json?.data?.productByHandle;

            if (!p?.id) continue;

            const variantEdges = p?.variants?.edges || [];

            const collectArray = (optName) => {
                const vals = [];
                for (const ve of variantEdges) {
                    const opts = ve?.node?.selectedOptions || [];
                    for (const o of opts) {
                        if (String(o.name || "").toLowerCase() === optName) vals.push(o.value);
                    }
                }
                return Array.from(new Set(vals)).filter((v) => v != null && String(v).trim() !== "");
            };

            const firstValue = (optName) => {
                for (const ve of variantEdges) {
                    const opts = ve?.node?.selectedOptions || [];
                    for (const o of opts) {
                        if (String(o.name || "").toLowerCase() === optName && o.value) return o.value;
                    }
                }
                return null;
            };

            products.push({
                id: p.id,
                title: p.title || entry.title || "",
                handle: p.handle || entry.handle || "",
                grade: entry.grade || p?.metafield?.value || "",
                imageUrl: p?.featuredImage?.url || "",
                size: collectArray("size"),
                size_type: firstValue("size type"),
                size_range: firstValue("size range"),
                age_size_range: ageSizeRangeMap[cleanText(p.handle).toLowerCase()] || "",
                collectionId: entry.collection_id || "",
                collectionTitle: entry.collection_title || "",
                collectionHandle: entry.collection_handle || "",
                savedCollections: [
                    {
                        id: entry.collection_id || "",
                        title: entry.collection_title || "",
                        handle: entry.collection_handle || "",
                        grade: entry.grade || "",
                    },
                ],
            });
        }

        return {
            items: products,
            hasNextPage,
            endCursor: hasNextPage ? String(nextOffset) : null,
        };
    }

    const res = await admin.graphql(
        `#graphql
      query Products($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              handle
              metafield(namespace: "${GRADE_NAMESPACE}", key: "${GRADE_KEY}") { value }
              featuredImage { url altText }
              variants(first: 250) {
                edges { node { selectedOptions { name value } } }
              }
              collections(first: 1) {
                edges { node { id title handle } }
              }
            }
          }
        }
      }
    `,
        { variables: { first, after } }
    );

    const json = await parseGraphql(res);
    const conn = json?.data?.products;

    const items = (conn?.edges || []).map((e) => {
        const p = e.node;
        const firstCol = p?.collections?.edges?.[0]?.node || null;
        const variantEdges = p?.variants?.edges || [];

        const collectArray = (optName) => {
            const vals = [];
            for (const ve of variantEdges) {
                const opts = ve?.node?.selectedOptions || [];
                for (const o of opts) {
                    if (String(o.name || "").toLowerCase() === optName) vals.push(o.value);
                }
            }
            return Array.from(new Set(vals)).filter((v) => v != null && String(v).trim() !== "");
        };

        const firstValue = (optName) => {
            for (const ve of variantEdges) {
                const opts = ve?.node?.selectedOptions || [];
                for (const o of opts) {
                    if (String(o.name || "").toLowerCase() === optName && o.value) return o.value;
                }
            }
            return null;
        };

        return {
            id: p.id,
            title: p.title || "",
            handle: p.handle || "",
            grade: p?.metafield?.value || "",
            imageUrl: p?.featuredImage?.url || "",
            size: collectArray("size"),
            size_type: firstValue("size type"),
            size_range: firstValue("size range"),
            collectionId: firstCol?.id || "",
            collectionTitle: firstCol?.title || "",
            collectionHandle: firstCol?.handle || "",
        };
    });

    const { data: savedData, error: fetchErr } = await supabase.from(EXTERNAL_TABLE).select("*");
    if (fetchErr) console.error("Error fetching from Supabase:", fetchErr);

    const allProductHandles = items
        .map((item) => cleanText(item.handle))
        .filter(Boolean);

    const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, allProductHandles);

    const collectionsByProductId = {};
    if (savedData && Array.isArray(savedData)) {
        for (const record of savedData) {
            const pId = record.shopify_product_id;
            if (!collectionsByProductId[pId]) collectionsByProductId[pId] = [];
            if (record.collection_id && record.collection_title) {
                collectionsByProductId[pId].push({
                    id: record.collection_id,
                    title: record.collection_title,
                    handle: record.collection_handle || "",
                    grade: record.grade || "",
                });
            }
        }
    }

    const mergedItems = items.map((item) => {
        const savedCollections = collectionsByProductId[item.id] || [];
        const ageSizeRange = ageSizeRangeMap[cleanText(item.handle).toLowerCase()] || "";

        if (savedCollections.length > 0) {
            return {
                ...item,
                age_size_range: ageSizeRange,
                collectionId: savedCollections[0]?.id || "",
                collectionTitle: savedCollections[0]?.title || "",
                collectionHandle: savedCollections[0]?.handle || "",
                savedCollections,
            };
        }

        return {
            ...item,
            age_size_range: ageSizeRange,
            savedCollections: [],
        };
    });



    return {
        items: mergedItems,
        hasNextPage: !!conn?.pageInfo?.hasNextPage,
        endCursor: conn?.pageInfo?.endCursor || null,
    };
}

// Fetch product, all collections, and sizes from Shopify
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

    // collect sizes (variant option name "Size")
    const variantEdges = p?.variants?.edges || [];
    const sizes = [];
    for (const ve of variantEdges) {
        const opts = ve?.node?.selectedOptions || [];
        for (const o of opts) {
            if (String(o?.name || "").toLowerCase() === "size" && o?.value) sizes.push(o.value);
        }
    }

    // paginate collections if needed
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

    // de-dupe collections
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

function safeErrToString(e) {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    if (e?.message && typeof e.message === "string") return e.message;
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}

/* ---------------- LOADER ---------------- */

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session?.shop || "";
    const supabase = getSupabaseAdmin();

    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const q = (url.searchParams.get("q") || "").trim();
    const collectionId = (url.searchParams.get("collectionId") || "").trim();

    const { items, hasNextPage, endCursor } = await fetchProductsWithGradeAndCollection(admin, supabase, {
        first: 50,
        after: after || null,
        search: q,
        collectionId,
    });

    const collections = await fetchAllCollections(admin);

    let masterTotal = null;
    try {
        const { count, error } = await supabase.from(MASTER_TABLE).select('"Handle"', { count: "exact", head: true });
        if (!error && typeof count === "number") masterTotal = count;
    } catch {
        // ignore
    }

    return {
        shop,
        products: items,
        searchQuery: q,
        selectedCollectionId: collectionId,
        collections,
        hasNextPage,
        endCursor,
        after: after || null,
        masterTotal,
    };
};

/* ---------------- ACTION ---------------- */

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const supabase = getSupabaseAdmin();
    const form = await request.formData();
    const intent = cleanText(form.get("intent"));

    // Sync ONLY: process N master rows at a time. UI can auto-chain.
    if (intent === "syncGradesBatch") {
        const offset = Math.max(0, toInt(form.get("offset"), 0));
        const limit = Math.max(1, Math.min(200, toInt(form.get("limit"), 50)));

        // Run totals come from the client, but are UPDATED on the server each batch.
        let runTotals = {
            batches: 0,
            uniqueHandles: 0,
            updatedHandles: 0,
            updatedRows: 0,
            insertedProducts: 0,
            insertedRows: 0,
            missingInShopify: 0,
        };
        const runTotalsRaw = form.get("runTotals");
        if (runTotalsRaw) {
            try {
                const parsed = JSON.parse(String(runTotalsRaw));
                if (parsed && typeof parsed === "object") runTotals = { ...runTotals, ...parsed };
            } catch {
                // ignore
            }
        }

        try {
            const { data: masterRows, error: masterErr, count: masterTotal } = await supabase
                .from(MASTER_TABLE)
                .select('"Handle","Grade"', { count: "exact" })
                .range(offset, offset + limit - 1);

            if (masterErr) throw new Error(masterErr.message);

            const rows = masterRows || [];
            const batchFetched = rows.length;

            // Nothing left => done. (Important: avoid throwing errors here.)
            if (batchFetched === 0) {
                return {
                    ok: true,
                    intent,
                    done: true,
                    summary: {
                        offset,
                        limit,
                        batchFetched: 0,
                        uniqueHandles: 0,
                        updatedHandles: 0,
                        updatedRows: 0,
                        insertedProducts: 0,
                        insertedRows: 0,
                        missingInShopify: 0,
                        masterTotal: typeof masterTotal === "number" ? masterTotal : null,
                        nextOffset: offset,
                        hasMore: false,
                    },
                    runTotals: { ...runTotals },
                };
            }

            // unique handle => grade (prefer non-empty grade)
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
                        handleToGrade.set(key, { handleRaw: prev?.handleRaw || handleRaw, grade });
                    }
                }
            }

            const keys = Array.from(handleToGrade.keys());
            const uniqueHandles = keys.length;

            let updatedHandles = 0;
            let updatedRows = 0;
            let insertedProducts = 0;
            let insertedRows = 0;
            let missingInShopify = 0;

            for (const hKey of keys) {
                const entry = handleToGrade.get(hKey);
                const handleRaw = entry?.handleRaw || hKey;
                const grade = cleanText(entry?.grade);

                // Does handle already exist in EXTERNAL_TABLE? (case-insensitive)
                const { data: existing, error: existErr } = await supabase
                    .from(EXTERNAL_TABLE)
                    .select("id,size")
                    .ilike("product_handle", handleRaw);

                if (existErr) throw new Error(existErr.message);

                const exists = Array.isArray(existing) && existing.length > 0;

                if (exists) {
                    // Merge ALL existing size arrays for this handle into a single array and write it back.
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

                // Not in external table: fetch from Shopify; if not in Shopify, do not add.
                const prod = await fetchProductByHandleWithCollectionsAndSizes(admin, handleRaw);
                if (!prod?.id) {
                    missingInShopify += 1;
                    continue;
                }

                const cols = prod.collections || [];
                if (cols.length === 0) {
                    // Nothing to insert if no collections
                    continue;
                }

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

            const nextOffset = offset + limit;
            const total = typeof masterTotal === "number" ? masterTotal : null;
            const hasMore = total == null ? true : nextOffset < total;

            // Update totals on the server (so UI can show ONLY final totals)
            const newTotals = {
                batches: (runTotals.batches || 0) + 1,
                uniqueHandles: (runTotals.uniqueHandles || 0) + (uniqueHandles || 0),
                updatedHandles: (runTotals.updatedHandles || 0) + (updatedHandles || 0),
                updatedRows: (runTotals.updatedRows || 0) + (updatedRows || 0),
                insertedProducts: (runTotals.insertedProducts || 0) + (insertedProducts || 0),
                insertedRows: (runTotals.insertedRows || 0) + (insertedRows || 0),
                missingInShopify: (runTotals.missingInShopify || 0) + (missingInShopify || 0),
            };

            return {
                ok: true,
                intent,
                done: !hasMore,
                summary: {
                    offset,
                    limit,
                    batchFetched,
                    uniqueHandles,
                    updatedHandles,
                    updatedRows,
                    insertedProducts,
                    insertedRows,
                    missingInShopify,
                    masterTotal: total,
                    nextOffset,
                    hasMore,
                },
                runTotals: newTotals,
            };
        } catch (e) {
            return { ok: false, intent, error: safeErrToString(e) };
        }
    }

    if (intent === "deleteMapping") {

        const productId = cleanText(form.get("productId"));
        const collectionId = cleanText(form.get("collectionId"));

        if (!productId || !collectionId) {
            return { ok: false, error: "Missing productId or collectionId" };
        }

        const { error } = await supabase
            .from(EXTERNAL_TABLE)
            .delete()
            .eq("shopify_product_id", productId)
            .eq("collection_id", collectionId);

        if (error) {
            return { ok: false, error: error.message };
        }

        return { ok: true, intent, productId, collectionId };
    }

    // delete only one collection row from external DB
    if (intent === "deleteCollection") {
        const productId = cleanText(form.get("productId"));
        const collectionId = cleanText(form.get("collectionId"));

        if (!productId) return { ok: false, error: "Missing productId" };
        if (!collectionId) return { ok: false, error: "Missing collectionId" };

        try {
            const { error: delErr } = await supabase
                .from(EXTERNAL_TABLE)
                .delete()
                .eq("shopify_product_id", productId)
                .eq("collection_id", collectionId);

            if (delErr) throw new Error(delErr.message);

            return { ok: true, intent, productId, collectionId };
        } catch (e) {
            return { ok: false, error: safeErrToString(e) };
        }
    }

    // saveRow (manual edits)
    if (intent !== "saveRow") return { ok: false, error: "Unknown intent" };

    const productId = cleanText(form.get("productId"));
    const productTitle = cleanText(form.get("productTitle"));
    const productHandle = cleanText(form.get("productHandle"));
    const collectionGradesJson = form.get("collectionGrades");

    if (!productId) return { ok: false, error: "Missing productId" };

    try {
        const parseArr = (k) => {
            const v = form.get(k);
            if (!v) return null;
            try {
                const parsed = JSON.parse(v);
                return Array.isArray(parsed) ? parsed : null;
            } catch {
                return null;
            }
        };

        const sizeArr = parseArr("size");
        const sizeRangeVal = form.get("size_range") || null;
        const sizeTypeVal = form.get("size_type") || null;

        let collectionGradesList = [];
        if (collectionGradesJson) {
            try {
                collectionGradesList = JSON.parse(collectionGradesJson);
                if (!Array.isArray(collectionGradesList)) collectionGradesList = [];
            } catch {
                collectionGradesList = [];
            }
        }

        // Ensure collection handle exists for each item
        for (let i = 0; i < collectionGradesList.length; i++) {
            const item = collectionGradesList[i] || {};
            const hasId = item.id && String(item.id).trim() !== "";
            const missingHandle = !item.handle || String(item.handle).trim() === "";
            if (hasId && missingHandle) {
                try {
                    const res = await admin.graphql(
                        `#graphql
              query NodeCollection($id: ID!) {
                node(id: $id) {
                  ... on Collection { id handle title }
                }
              }
            `,
                        { variables: { id: item.id } }
                    );

                    const json = await parseGraphql(res);
                    const node = json?.data?.node;
                    if (node) {
                        collectionGradesList[i].handle = node.handle || collectionGradesList[i].handle || "";
                        collectionGradesList[i].title =
                            collectionGradesList[i].title || node.title || collectionGradesList[i].title || "";
                    }
                } catch (err) {
                    console.error("Failed to fetch collection handle for", item.id, err);
                }
            }
        }

        const upsertRecords = collectionGradesList.map((item) => ({
            shopify_product_id: productId,
            product_title: productTitle || null,
            product_handle: productHandle || null,

            collection_id: item.id || null,
            collection_title: item.title || null,
            collection_handle: String(item.handle ?? "").trim() || null,

            grade: String(item.grade ?? "").trim() || null,
            size_range: sizeRangeVal,
            size_type: sizeTypeVal,
            size: sizeArr,
            updated_at: new Date().toISOString(),
        }));

        if (upsertRecords.length > 0) {
            const { error: upErr } = await supabase
                .from(EXTERNAL_TABLE)
                .upsert(upsertRecords, { onConflict: "shopify_product_id,collection_id" });
            if (upErr) throw new Error(upErr.message);
        } else {
            const { error: delErr } = await supabase.from(EXTERNAL_TABLE).delete().eq("shopify_product_id", productId);
            if (delErr) throw new Error(delErr.message);
        }

        return { ok: true, productId };
    } catch (e) {
        return { ok: false, error: safeErrToString(e) };
    }
};

/* ---------------- UI ---------------- */

export default function GradeCollectionPage() {
    const loaderData = useLoaderData();

    useAppBridge(); // keep bridge ready

    const fetcher = useFetcher(); // saveRow
    const syncFetcher = useFetcher(); // syncGradesBatch
    const searchFetcher = useFetcher(); // for search form (to reset pagination)

    const data = searchFetcher.data || loaderData;

    const {
        shop,
        products,
        collections,
        hasNextPage,
        endCursor,
        after,
        masterTotal,
        searchQuery: initialSearchQuery,
        selectedCollectionId: initialSelectedCollectionId,
    } = data;

    const [collectionGradeByProductId, setCollectionGradeByProductId] = useState({});

    const [selectedCollectionId, setSelectedCollectionId] = useState(initialSelectedCollectionId || "");
    useEffect(() => {
        setSelectedCollectionId(initialSelectedCollectionId || "");
    }, [initialSelectedCollectionId]);
    const [addingCollectionFor, setAddingCollectionFor] = useState(null);
    const [addDraftByProductId, setAddDraftByProductId] = useState({});
    const [searchQuery, setSearchQuery] = useState(initialSearchQuery || "");
    const [editingUnsavedCollection, setEditingUnsavedCollection] = useState(null);

    // auto-sync controls
    const [syncOffset, setSyncOffset] = useState(0);
    const [autoSyncOn, setAutoSyncOn] = useState(false);
    const syncLimit = 50;
    const [waveFrozen, setWaveFrozen] = useState(false);
    const [waveBgPos, setWaveBgPos] = useState("0px 0px");
    const waveRef = useRef(null);

    // Only show FINAL report when done
    const [finalReport, setFinalReport] = useState(null);

    // run totals (kept in memory; updated from server response each batch)
    const [syncTotals, setSyncTotals] = useState({
        batches: 0,
        uniqueHandles: 0,
        updatedHandles: 0,
        updatedRows: 0,
        insertedProducts: 0,
        insertedRows: 0,
        missingInShopify: 0,
    });

    const lastBatchIdRef = useRef(0);
    const latestRunTotalsRef = useRef(syncTotals);

    // Progress animation (smooth percent count-up)
    const [displayPct, setDisplayPct] = useState(0);

    // Persist offset
    useEffect(() => {
        try {
            const raw = window.localStorage.getItem("master_sync_offset");
            const n = Number.parseInt(raw || "0", 10);
            if (Number.isFinite(n) && n >= 0) setSyncOffset(n);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem("master_sync_offset", String(syncOffset));
        } catch {
            // ignore
        }
    }, [syncOffset]);

    const isSaving = fetcher.state !== "idle";
    const isSyncing = syncFetcher.state !== "idle";
    const isSearching = searchFetcher.state !== "idle";

    // Track if we're currently searching (not filtering)
    const [isSearchLoading, setIsSearchLoading] = useState(false);
    const [isCollectionFilterLoading, setIsCollectionFilterLoading] = useState(false);

    const saveError = fetcher.data?.ok === false ? fetcher.data.error : null;

    const syncError =
        syncFetcher.data?.intent === "syncGradesBatch" && syncFetcher.data?.ok === false ? syncFetcher.data.error : null;

    // additional error state for stalled auto-sync runs
    const [syncAllError, setSyncAllError] = useState(null);

    const syncSummary =
        syncFetcher.data?.intent === "syncGradesBatch" && syncFetcher.data?.ok === true ? syncFetcher.data.summary : null;

    const syncRunTotals =
        syncFetcher.data?.intent === "syncGradesBatch" && syncFetcher.data?.ok === true ? syncFetcher.data.runTotals : null;

    const syncDone =
        syncFetcher.data?.intent === "syncGradesBatch" && syncFetcher.data?.ok === true ? !!syncFetcher.data.done : false;

    // Keep totals updated from server response (no per-batch UI rendering)
    useEffect(() => {
        if (!syncSummary) return;

        // update offset from server (authoritative)
        if (typeof syncSummary.nextOffset === "number") {
            setSyncOffset(syncSummary.nextOffset);
        }

        // prevent double processing
        const batchId = (syncSummary.offset ?? 0) + (syncSummary.limit ?? 0);
        if (batchId === lastBatchIdRef.current) return;
        lastBatchIdRef.current = batchId;

        if (syncRunTotals) {
            const nextTotals = {
                batches: Number(syncRunTotals.batches || 0),
                uniqueHandles: Number(syncRunTotals.uniqueHandles || 0),
                updatedHandles: Number(syncRunTotals.updatedHandles || 0),
                updatedRows: Number(syncRunTotals.updatedRows || 0),
                insertedProducts: Number(syncRunTotals.insertedProducts || 0),
                insertedRows: Number(syncRunTotals.insertedRows || 0),
                missingInShopify: Number(syncRunTotals.missingInShopify || 0),
            };
            setSyncTotals(nextTotals);
            latestRunTotalsRef.current = nextTotals;
        }

        // If done, show ONLY final report
        if (syncDone) {
            setAutoSyncOn(false);
            setFinalReport({
                totals: syncRunTotals || latestRunTotalsRef.current,
                completedAt: new Date().toISOString(),
            });
        }
    }, [syncSummary, syncRunTotals, syncDone]);

    useEffect(() => {
        if (displayPct >= 100 && !waveFrozen) {
            const el = waveRef.current;
            if (el) {
                const computed = window.getComputedStyle(el);
                const bgPos = computed.backgroundPosition || "0px 0px";
                setWaveBgPos(bgPos);
            }
            setWaveFrozen(true);
        }

        if (displayPct < 100 && waveFrozen) {
            setWaveFrozen(false);
            setWaveBgPos("0px 0px");
        }
    }, [displayPct, waveFrozen]);

    // detect if auto-sync stops unexpectedly (no response/data)
    useEffect(() => {
        if (!autoSyncOn) {
            setSyncAllError(null);
            return;
        }
        // if fetcher is idle but we haven't received data and not currently syncing
        if (syncFetcher.state === "idle" && syncFetcher.data == null && !isSyncing) {
            setSyncAllError("Sync stopped unexpectedly. Please check your network or try again.");
            setAutoSyncOn(false);
        }
    }, [autoSyncOn, syncFetcher.state, syncFetcher.data, isSyncing]);

    // Auto-chain batches (STOP button will set autoSyncOn=false, so it stops after current batch)
    useEffect(() => {
        if (!autoSyncOn) return;
        if (isSyncing) return;
        if (!syncSummary) return;

        if (syncSummary.hasMore) {
            syncFetcher.submit(
                {
                    intent: "syncGradesBatch",
                    offset: String(syncSummary.nextOffset),
                    limit: String(syncLimit),
                    runTotals: JSON.stringify(latestRunTotalsRef.current),
                },
                { method: "POST" }
            );
        } else {
            setAutoSyncOn(false);
            setFinalReport({
                totals: latestRunTotalsRef.current,
                completedAt: new Date().toISOString(),
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSyncOn, isSyncing, syncSummary]);

    const collectionOptions = useMemo(() => {
        const filtered = (collections || []).filter((c) =>
            ALLOWED_COLLECTION_IDS.has(String(c.id))
        );

        return [
            { label: "No collection", value: "" },
            ...filtered.map((c) => ({ label: c.title, value: c.id })),
        ];
    }, [collections]);

    const allowedCollectionFilterOptions = useMemo(() => {
        const filtered = (collections || []).filter((c) =>
            ALLOWED_COLLECTION_IDS.has(String(c.id))
        );

        return [
            { label: "All collections", value: "" },
            ...filtered.map((c) => ({
                label: c.title,
                value: c.id,
            })),
        ];
    }, [collections]);

    const gidToTitle = useMemo(() => {
        const m = new Map();
        for (const c of collections || []) m.set(String(c.id), String(c.title || ""));
        return m;
    }, [collections]);

    const gidToHandle = useMemo(() => {
        const m = new Map();
        for (const c of collections || []) m.set(String(c.id), String(c.handle || ""));
        return m;
    }, [collections]);

    useEffect(() => {
        const cg = {};
        for (const p of products) {
            if (p.savedCollections && p.savedCollections.length > 0) {
                cg[p.id] = p.savedCollections;
            } else if (p.collectionId && p.collectionTitle) {
                cg[p.id] = [
                    {
                        id: p.collectionId,
                        title: p.collectionTitle,
                        handle: p.collectionHandle || "",
                        grade: p.grade || "",
                    },
                ];
            } else {
                cg[p.id] = [];
            }
        }
        setCollectionGradeByProductId(cg);
    }, [products]);

    const headings = useMemo(() => [{ title: "Product" }, { title: "Age size range" }, { title: "Collection" },
    { title: "Grade" }, { title: "Action" }], []);

    const filteredProducts = products || [];
    const shouldShowPagination = !!after || hasNextPage;

    // progress
    const totalForUI = syncSummary?.masterTotal ?? masterTotal;

    // completed rows: use server nextOffset when available
    const completed = typeof syncSummary?.nextOffset === "number" ? syncSummary.nextOffset : syncOffset;

    const syncedSoFar = Math.min(completed, typeof totalForUI === "number" ? totalForUI : completed);
    const progressPct =
        typeof totalForUI === "number" && totalForUI > 0 ? Math.min(100, Math.round((syncedSoFar / totalForUI) * 100)) : 0;

    // smooth % counter animation
    useEffect(() => {
        let raf = 0;
        const start = displayPct;
        const end = progressPct;
        const duration = 350;
        const t0 = performance.now();

        const step = (t) => {
            const p = Math.min(1, (t - t0) / duration);
            const next = Math.round(start + (end - start) * p);
            setDisplayPct(next);
            if (p < 1) raf = requestAnimationFrame(step);
        };

        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [progressPct]);

    const alreadyComplete = typeof totalForUI === "number" && totalForUI > 0 && syncOffset >= totalForUI;

    const startAutoSync = () => {
        // Workaround: if progress is already full, do not call action (prevents the weird {" error state)
        if (alreadyComplete) {
            setAutoSyncOn(false);
            setFinalReport({
                totals: latestRunTotalsRef.current,
                completedAt: new Date().toISOString(),
                note: "Already completed (offset is at the end). Reset offset if you want to re-run.",
            });
            return;
        }

        setFinalReport(null);

        // reset run totals for THIS run (optional). If you want totals to continue across runs, remove this block.
        const freshTotals = {
            batches: 0,
            uniqueHandles: 0,
            updatedHandles: 0,
            updatedRows: 0,
            insertedProducts: 0,
            insertedRows: 0,
            missingInShopify: 0,
        };
        setSyncTotals(freshTotals);
        latestRunTotalsRef.current = freshTotals;
        lastBatchIdRef.current = 0;

        setAutoSyncOn(true);
        syncFetcher.submit(
            {
                intent: "syncGradesBatch",
                offset: String(syncOffset),
                limit: String(syncLimit),
                runTotals: JSON.stringify(freshTotals),
            },
            { method: "POST" }
        );
    };

    const stopAutoSync = () => {
        setAutoSyncOn(false);
        // No need to "cancel" fetcher request (not supported reliably). This stops chaining after current batch finishes.
    };

    const resetSync = () => {
        setAutoSyncOn(false);
        setSyncOffset(0);
        setFinalReport(null);
        const freshTotals = {
            batches: 0,
            uniqueHandles: 0,
            updatedHandles: 0,
            updatedRows: 0,
            insertedProducts: 0,
            insertedRows: 0,
            missingInShopify: 0,
        };
        setSyncTotals(freshTotals);
        latestRunTotalsRef.current = freshTotals;
        lastBatchIdRef.current = 0;
        setDisplayPct(0);
        try {
            window.localStorage.setItem("master_sync_offset", "0");
        } catch {
            // ignore
        }
    };

    const saveRow = (p) => {
        const collectionsData = [...(collectionGradeByProductId[p.id] || [])].map((item) => ({
            id: item.id,
            title: item.title,
            handle: item.handle,
            grade: item.grade,
        }));

        setAddingCollectionFor(null);
        setAddDraftByProductId((prev) => {
            const next = { ...prev };
            delete next[p.id];
            return next;
        });
        setEditingUnsavedCollection(null);

        fetcher.submit(
            {
                intent: "saveRow",
                productId: p.id,
                productTitle: p.title,
                productHandle: p.handle || "",
                collectionGrades: JSON.stringify(collectionsData),
                size_range: p.size_range || "",
                size_type: p.size_type || "",
                size: JSON.stringify(p.size || []),
            },
            { method: "POST" }
        );
    };

    const savingThisRow = (pid) => isSaving && fetcher.formData?.get("productId") === pid;

    const renderErrorText = (v) => {
        if (!v) return "";
        if (typeof v === "string") return v;
        try {
            return JSON.stringify(v);
        } catch {
            return String(v);
        }
    };

    useEffect(() => {
        const trimmed = String(searchQuery || "").trim();
        const initialTrimmed = String(initialSearchQuery || "").trim();
        const selectedTrimmed = String(selectedCollectionId || "").trim();
        const initialSelectedTrimmed = String(initialSelectedCollectionId || "").trim();

        if (trimmed === initialTrimmed && selectedTrimmed === initialSelectedTrimmed) return;

        const timer = setTimeout(() => {
            const searchChanged = trimmed !== initialTrimmed;
            const collectionChanged = selectedTrimmed !== initialSelectedTrimmed;

            if (searchChanged) {
                setIsSearchLoading(true);
            }

            if (collectionChanged) {
                setIsCollectionFilterLoading(true);
            }

            const params = new URLSearchParams();

            if (trimmed) {
                params.set("q", trimmed);
            }

            if (selectedTrimmed) {
                params.set("collectionId", selectedTrimmed);
            }

            const qs = params.toString();

            searchFetcher.load(
                qs ? `${window.location.pathname}?${qs}` : window.location.pathname
            );
        }, 400);

        return () => clearTimeout(timer);
    }, [searchQuery, selectedCollectionId, initialSearchQuery, initialSelectedCollectionId]);

    // Reset search loading when fetcher completes
    useEffect(() => {
        if (searchFetcher.state === "idle") {
            setIsSearchLoading(false);
            setIsCollectionFilterLoading(false);
        }
    }, [searchFetcher.state]);

    return (
        <Page fullWidth title="Grade and Collection">
            <Layout>
                <Layout.Section>
                    {saveError && (
                        <Banner tone="critical" title="Save error">
                            <p>{renderErrorText(saveError)}</p>
                        </Banner>
                    )}

                    {syncError && (
                        <Banner tone="critical" title="Sync error">
                            <p>{renderErrorText(syncError)}</p>
                        </Banner>
                    )}

                    {syncAllError && (
                        <Banner tone="critical" title="Sync halted">
                            <p>{renderErrorText(syncAllError)}</p>
                        </Banner>
                    )}

                    {finalReport && (
                        <Banner tone="success" title="Sync completed (final report)">
                            {finalReport.note ? <p>{finalReport.note}</p> : null}
                            <p>
                                Unique handles: {finalReport.totals?.uniqueHandles || 0} | Updated handles:{" "}
                                {finalReport.totals?.updatedHandles || 0} | Updated rows: {finalReport.totals?.updatedRows || 0}
                            </p>
                            <p>Not in Shopify: {finalReport.totals?.missingInShopify || 0}</p>
                        </Banner>
                    )}

                    <Card>
                        <div style={{ padding: 16 }}>
                            <BlockStack gap="300">
                                <InlineStack align="space-between" gap="200">
                                    <Text as="h2" variant="headingMd">
                                        Products
                                    </Text>

                                    <InlineStack gap="200" blockAlign="center">
                                        <Button
                                            variant="primary"
                                            loading={autoSyncOn}
                                            disabled={isSaving || autoSyncOn || alreadyComplete}
                                            onClick={startAutoSync}
                                        >
                                            Sync all
                                        </Button>

                                        {autoSyncOn ? (
                                            <Button tone="critical" disabled={isSaving} onClick={stopAutoSync}>
                                                Stop
                                            </Button>
                                        ) : null}

                                        <Button
                                            disabled={isSaving || isSyncing || autoSyncOn || alreadyComplete}
                                            onClick={() =>
                                                syncFetcher.submit(
                                                    {
                                                        intent: "syncGradesBatch",
                                                        offset: String(syncOffset),
                                                        limit: String(syncLimit),
                                                        runTotals: JSON.stringify(latestRunTotalsRef.current),
                                                    },
                                                    { method: "POST" }
                                                )
                                            }
                                        >
                                            Sync next {syncLimit}
                                        </Button>
                                    </InlineStack>
                                </InlineStack>

                                <Card sectioned>
                                    <BlockStack gap="300">
                                        <InlineStack align="space-between">
                                            <Text as="span" tone="subdued">
                                                {typeof totalForUI === "number"
                                                    ? `${syncedSoFar} / ${totalForUI}`
                                                    : `${syncedSoFar} / ?`}
                                            </Text>

                                            <Text as="span" tone="subdued">
                                                {alreadyComplete ? "Completed" : ""}
                                            </Text>
                                        </InlineStack>

                                        <div
                                            className="waveProgress"
                                            aria-label="Sync progress"
                                            role="progressbar"
                                            aria-valuenow={displayPct}
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                        >
                                            <div className="waveProgress__fill" style={{ width: `${displayPct}%` }}>
                                                <div
                                                    ref={waveRef}
                                                    className={`waveProgress__wave ${waveFrozen ? "waveProgress__wave--frozen" : ""}`}
                                                    style={waveFrozen ? { backgroundPosition: waveBgPos } : undefined}
                                                />
                                            </div>

                                            <div className="waveProgress__label">{displayPct}%</div>
                                        </div>

                                        <InlineStack align="space-between">
                                            <Button size="slim" disabled={isSyncing || !alreadyComplete} onClick={resetSync}>
                                                Reset offset
                                            </Button>
                                        </InlineStack>

                                        {alreadyComplete ? (
                                            <Text as="span" tone="subdued" variant="bodySm">
                                                Sync is already complete. Click Reset offset to run again.
                                            </Text>
                                        ) : null}

                                        <style>{`
      .waveProgress{
        position: relative;
        height: 16px;
        border-radius: 999px;
        background: #e5e7eb;
        overflow: hidden;
      }

      .waveProgress__fill{
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        border-radius: 999px;
        overflow: hidden;
        transition: width 520ms ease;
        will-change: width;
        background: #2c6ecb;
      }

      .waveProgress__wave{
        position: absolute;
        inset: 0;
        background-image:
          radial-gradient(circle at 20px 8px, rgba(255,255,255,0.35) 0 8px, transparent 9px),
          radial-gradient(circle at 60px 14px, rgba(255,255,255,0.25) 0 7px, transparent 8px),
          radial-gradient(circle at 100px 6px, rgba(255,255,255,0.30) 0 9px, transparent 10px),
          radial-gradient(circle at 140px 12px, rgba(255,255,255,0.22) 0 7px, transparent 8px);
        background-size: 160px 16px;
        background-repeat: repeat-x;
        animation: waveMove 1.1s linear infinite;
        opacity: 0.95;
        filter: blur(0.2px);
      }

      .waveProgress__wave--frozen{
        animation: none;
      }

      @keyframes waveMove{
        from { background-position: 0 0; }
        to   { background-position: 160px 0; }
      }

      .waveProgress__label{
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        font-size: 12px;
        font-weight: 700;
        color: #000;
      }

      

      /* Prevent scrollbar width shift */
      html {
        scrollbar-gutter: stable;
      }

      @keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
    `}</style>
                                    </BlockStack>
                                </Card>

                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        gap: 16,
                                        marginTop: 12,
                                        marginBottom: 12,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <div style={{ flex: "1 1 420px", maxWidth: 420 }}>
                                        <TextField
                                            label="Search product"
                                            labelHidden
                                            placeholder="Search by product name..."
                                            value={searchQuery}
                                            onChange={setSearchQuery}
                                            autoComplete="off"
                                            clearButton
                                            onClearButtonClick={() => setSearchQuery("")}
                                            loading={isSearchLoading}
                                        />
                                    </div>

                                    <div
                                        style={{
                                            width: 280,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 8,
                                        }}
                                    >
                                        <div style={{ flex: 1 }}>
                                            <Select
                                                label="Filter by collection"
                                                labelHidden
                                                options={allowedCollectionFilterOptions}
                                                value={selectedCollectionId}
                                                onChange={setSelectedCollectionId}
                                            />
                                        </div>

                                        {isCollectionFilterLoading ? (
                                            <div
                                                style={{
                                                    width: 20,
                                                    height: 20,
                                                    border: "2px solid #d1d5db",
                                                    borderTop: "2px solid #111827",
                                                    borderRadius: "50%",
                                                    animation: "spin 0.8s linear infinite",
                                                    flexShrink: 0,
                                                    marginTop: 2,
                                                }}
                                            />
                                        ) : null}
                                    </div>
                                </div>


                                <IndexTable
                                    resourceName={{ singular: "product", plural: "products" }}
                                    itemCount={filteredProducts.length}
                                    selectable={false}
                                    headings={headings}
                                >
                                    {filteredProducts.map((p, idx) => {
                                        const currentCollectionGrades = collectionGradeByProductId[p.id] || [];
                                        const allowedCollections = currentCollectionGrades.filter((c) =>
                                            ALLOWED_COLLECTION_IDS.has(String(c.id))
                                        );

                                        const originalCollectionGrades =
                                            p.savedCollections && p.savedCollections.length > 0
                                                ? p.savedCollections
                                                : p.collectionId && p.collectionTitle
                                                    ? [
                                                        {
                                                            id: p.collectionId,
                                                            title: p.collectionTitle,
                                                            handle: p.collectionHandle || "",
                                                            grade: p.grade || "",
                                                        },
                                                    ]
                                                    : [];

                                        const changed =
                                            JSON.stringify(currentCollectionGrades) !==
                                            JSON.stringify(originalCollectionGrades);

                                        return (
                                            <IndexTable.Row id={p.id} key={p.id} position={idx}>
                                                <IndexTable.Cell>
                                                    <InlineStack align="trailing" gap="100">
                                                        {p.imageUrl ? (
                                                            <img
                                                                src={p.imageUrl}
                                                                alt={p.title || ""}
                                                                style={{
                                                                    width: 48,
                                                                    height: 48,
                                                                    objectFit: "cover",
                                                                    borderRadius: 6,
                                                                }}
                                                            />
                                                        ) : (
                                                            <div
                                                                style={{
                                                                    width: 48,
                                                                    height: 48,
                                                                    background: "#f4f6f8",
                                                                    borderRadius: 6,
                                                                }}
                                                            />
                                                        )}
                                                        <BlockStack gap="050">
                                                            <Text as="span">{p.title}</Text>
                                                        </BlockStack>
                                                    </InlineStack>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <Text as="span" tone={p.age_size_range ? "base" : "subdued"}>
                                                        {p.age_size_range || ""}
                                                    </Text>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <BlockStack gap="150">
                                                        {allowedCollections.length === 0 && addingCollectionFor !== p.id && (
                                                            <Text tone="subdued">—</Text>
                                                        )}

                                                        {allowedCollections.map((collItem, colIdx) => {
                                                            const isEditingThisUnsaved =
                                                                editingUnsavedCollection?.productId === p.id &&
                                                                editingUnsavedCollection?.collectionId === collItem.id &&
                                                                collItem.__unsaved === true;

                                                            return (
                                                                <div
                                                                    key={`${p.id}-collection-${colIdx}`}
                                                                    style={{
                                                                        minHeight: 20,
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        marginBottom: 6,
                                                                    }}
                                                                >
                                                                    <div style={{ width: 230 }}>
                                                                        {isEditingThisUnsaved ? (
                                                                            <Select
                                                                                labelHidden
                                                                                options={collectionOptions.filter(
                                                                                    (opt) =>
                                                                                        !opt.value ||
                                                                                        opt.value === collItem.id ||
                                                                                        !(collectionGradeByProductId[p.id] || []).some(
                                                                                            (c) => c.id === opt.value
                                                                                        )
                                                                                )}
                                                                                value={String(collItem.id || "")}
                                                                                onChange={(newCollectionId) => {
                                                                                    if (!newCollectionId) return;

                                                                                    const title = gidToTitle.get(newCollectionId) || "";
                                                                                    const handle = gidToHandle.get(newCollectionId) || "";

                                                                                    setCollectionGradeByProductId((prev) => {
                                                                                        const existing = prev[p.id] || [];
                                                                                        const updated = existing.map((item) => {
                                                                                            if (String(item.id) !== String(collItem.id)) return item;

                                                                                            return {
                                                                                                ...item,
                                                                                                id: newCollectionId,
                                                                                                title,
                                                                                                handle,
                                                                                                __unsaved: true,
                                                                                            };
                                                                                        });

                                                                                        return {
                                                                                            ...prev,
                                                                                            [p.id]: updated,
                                                                                        };
                                                                                    });

                                                                                    setEditingUnsavedCollection(null);
                                                                                }}
                                                                            />
                                                                        ) : (
                                                                            <div
                                                                                onClick={() => {
                                                                                    if (collItem.__unsaved === true) {
                                                                                        setEditingUnsavedCollection({
                                                                                            productId: p.id,
                                                                                            collectionId: collItem.id,
                                                                                        });
                                                                                    }
                                                                                }}
                                                                                style={{
                                                                                    cursor: collItem.__unsaved === true ? "pointer" : "default",
                                                                                }}
                                                                            >
                                                                                <Badge tone="info">{collItem.title}</Badge>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}

                                                        {addingCollectionFor === p.id ? (
                                                            <BlockStack gap="100">
                                                                <InlineStack gap="200" blockAlign="end" wrap={false}>
                                                                    <div style={{ minWidth: 200 }}>
                                                                        <Select
                                                                            options={collectionOptions.filter(
                                                                                (opt) =>
                                                                                    !opt.value ||
                                                                                    !(collectionGradeByProductId[p.id] || []).some(
                                                                                        (c) => c.id === opt.value
                                                                                    )
                                                                            )}
                                                                            value={addDraftByProductId[p.id]?.collectionId || ""}
                                                                            onChange={(collectionId) => {
                                                                                if (!collectionId) return;

                                                                                const title = gidToTitle.get(collectionId) || "";
                                                                                const handle = gidToHandle.get(collectionId) || "";

                                                                                setCollectionGradeByProductId((prev) => {
                                                                                    const existing = prev[p.id] || [];

                                                                                    if (existing.some((c) => c.id === collectionId)) {
                                                                                        return prev;
                                                                                    }

                                                                                    return {
                                                                                        ...prev,
                                                                                        [p.id]: [
                                                                                            ...existing,
                                                                                            {
                                                                                                id: collectionId,
                                                                                                title,
                                                                                                handle,
                                                                                                grade: "",
                                                                                                __unsaved: true,
                                                                                            },
                                                                                        ],
                                                                                    };
                                                                                });

                                                                                setAddingCollectionFor(null);
                                                                            }}
                                                                        />
                                                                    </div>


                                                                </InlineStack>
                                                            </BlockStack>
                                                        ) : null}
                                                    </BlockStack>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <BlockStack gap="150">
                                                        {allowedCollections.length === 0 && addingCollectionFor !== p.id && (
                                                            <Text tone="subdued">—</Text>
                                                        )}

                                                        {allowedCollections.map((collItem, colIdx) => {
                                                            const realIndex = currentCollectionGrades.findIndex(
                                                                (item) => String(item.id) === String(collItem.id)
                                                            );

                                                            return (
                                                                <div
                                                                    key={`${p.id}-grade-${colIdx}`}
                                                                    style={{
                                                                        minHeight: 20,
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        marginBottom: 6,
                                                                    }}
                                                                >
                                                                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                                                                        <div style={{ width: "100%", minWidth: 130 }}>
                                                                            <TextField
                                                                                label={`Grade for ${collItem.title}`}
                                                                                labelHidden
                                                                                placeholder="Enter grade"
                                                                                value={String(collItem.grade ?? "")}
                                                                                onChange={(v) => {
                                                                                    setCollectionGradeByProductId((prev) => {
                                                                                        const existing = prev[p.id] || [];
                                                                                        const updated = existing.map((item, idx2) =>
                                                                                            idx2 === realIndex ? { ...item, grade: v } : item
                                                                                        );

                                                                                        return {
                                                                                            ...prev,
                                                                                            [p.id]: updated,
                                                                                        };
                                                                                    });
                                                                                }}
                                                                                autoComplete="off"
                                                                            />
                                                                        </div>

                                                                        <Button
                                                                            icon={DeleteIcon}
                                                                            tone="critical"
                                                                            variant="tertiary"
                                                                            size="slim"
                                                                            onClick={async () => {
                                                                                const confirmDelete = window.confirm(
                                                                                    "Delete this collection mapping?"
                                                                                );

                                                                                if (!confirmDelete) return;

                                                                                const isUnsaved = collItem.__unsaved === true;

                                                                                if (!isUnsaved) {
                                                                                    await fetcher.submit(
                                                                                        {
                                                                                            intent: "deleteMapping",
                                                                                            productId: p.id,
                                                                                            collectionId: collItem.id,
                                                                                        },
                                                                                        { method: "post" }
                                                                                    );
                                                                                }

                                                                                setCollectionGradeByProductId((prev) => {
                                                                                    const existing = prev[p.id] || [];

                                                                                    return {
                                                                                        ...prev,
                                                                                        [p.id]: existing.filter(
                                                                                            (item) => String(item.id) !== String(collItem.id)
                                                                                        ),
                                                                                    };
                                                                                });

                                                                                setEditingUnsavedCollection((prev) => {
                                                                                    if (
                                                                                        prev?.productId === p.id &&
                                                                                        prev?.collectionId === collItem.id
                                                                                    ) {
                                                                                        return null;
                                                                                    }
                                                                                    return prev;
                                                                                });
                                                                            }}
                                                                        />
                                                                    </InlineStack>
                                                                </div>
                                                            );
                                                        })}
                                                    </BlockStack>

                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <div
                                                        style={{
                                                            display: "flex",
                                                            alignItems: "center",
                                                            justifyContent: "space-between",
                                                            gap: "12px",
                                                            width: "100%",
                                                        }}
                                                    >

                                                        <InlineStack gap="200">



                                                            {/* ADD COLLECTION BUTTON */}
                                                            {addingCollectionFor !== p.id ? (
                                                                <Button
                                                                    variant="primary"
                                                                    tone="success"
                                                                    size="slim"
                                                                    onClick={() => setAddingCollectionFor(p.id)}
                                                                >
                                                                    +
                                                                </Button>
                                                            ) : (
                                                                <div />
                                                            )}


                                                        </InlineStack>

                                                        {/* SAVE BUTTON */}
                                                        <Button
                                                            variant="primary"
                                                            loading={savingThisRow(p.id)}
                                                            disabled={!changed}
                                                            onClick={() => saveRow(p)}
                                                        >
                                                            Save
                                                        </Button>
                                                    </div>
                                                </IndexTable.Cell>
                                            </IndexTable.Row>
                                        );
                                    })}
                                </IndexTable>


                                <InlineStack align="space-between">
                                    {shouldShowPagination ? (
                                        <Pagination
                                            hasPrevious={!!after}
                                            onPrevious={() => {
                                                const u = new URL(window.location.href);
                                                u.searchParams.delete("after");
                                                window.location.href = u.toString();
                                            }}
                                            hasNext={hasNextPage}
                                            onNext={() => {
                                                const u = new URL(window.location.href);
                                                u.searchParams.set("after", endCursor);
                                                window.location.href = u.toString();
                                            }}
                                        />
                                    ) : (
                                        <div />
                                    )}

                                    <Text as="span" tone="subdued">
                                        Showing {filteredProducts.length} of {products.length} products
                                    </Text>
                                </InlineStack>
                            </BlockStack>
                        </div>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
export const headers = boundary.headers;
export const ErrorBoundary = boundary.error;
export const CatchBoundary = boundary.catch;