// app/routes/app._index.jsx

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import {
  Page,
  Layout,
  Card,
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
  ProgressBar,
} from "@shopify/polaris";

import { DeleteIcon } from "@shopify/polaris-icons";

const EXTERNAL_TABLE = "product_grade_collection";
const MASTER_TABLE = "master database colours"; // exact name, with spaces

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

async function fetchProductsWithGradeAndCollection(admin, supabase, { first = 50, after = null } = {}) {
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
    if (savedCollections.length > 0) {
      return {
        ...item,
        collectionId: savedCollections[0]?.id || "",
        collectionTitle: savedCollections[0]?.title || "",
        collectionHandle: savedCollections[0]?.handle || "",
        savedCollections,
      };
    }
    return { ...item, savedCollections: [] };
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

  const { items, hasNextPage, endCursor } = await fetchProductsWithGradeAndCollection(admin, supabase, {
    first: 50,
    after: after || null,
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
  const { shop, products, collections, hasNextPage, endCursor, after, masterTotal } = useLoaderData();
  useAppBridge(); // keep bridge ready

  const fetcher = useFetcher(); // saveRow
  const deleteFetcher = useFetcher(); // deleteCollection
  const syncFetcher = useFetcher(); // syncGradesBatch

  const [collectionGradeByProductId, setCollectionGradeByProductId] = useState({});
  const [addingCollectionFor, setAddingCollectionFor] = useState(null);
  const [addDraftByProductId, setAddDraftByProductId] = useState({});

  // auto-sync controls
  const [syncOffset, setSyncOffset] = useState(0);
  const [autoSyncOn, setAutoSyncOn] = useState(false);
  const syncLimit = 50;

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
  const isDeleting = deleteFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";

  const saveError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const deleteError = deleteFetcher.data?.ok === false ? deleteFetcher.data.error : null;

  const syncError =
    syncFetcher.data?.intent === "syncGradesBatch" && syncFetcher.data?.ok === false ? syncFetcher.data.error : null;

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
    return [{ label: "No collection", value: "" }, ...(collections || []).map((c) => ({ label: c.title, value: c.id }))];
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

  const headings = useMemo(() => [{ title: "Product" }, { title: "Collections and grade" }, { title: "Action" }], []);

  // progress
  const totalForUI = syncSummary?.masterTotal ?? masterTotal;
  const syncedSoFar = Math.min(syncOffset, typeof totalForUI === "number" ? totalForUI : syncOffset);
  const progressPct =
    typeof totalForUI === "number" && totalForUI > 0 ? Math.min(100, Math.round((syncedSoFar / totalForUI) * 100)) : 0;

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
    try {
      window.localStorage.setItem("master_sync_offset", "0");
    } catch {
      // ignore
    }
  };

  const saveRow = (p) => {
    const collectionsData = [...(collectionGradeByProductId[p.id] || [])];
    const draft = addDraftByProductId[p.id];

    if (draft && draft.collectionId) {
      const alreadyExists = collectionsData.some((c) => c.id === draft.collectionId);
      if (!alreadyExists) {
        const titleFromList = gidToTitle.get(String(draft.collectionId)) || "";
        const handleFromList = gidToHandle.get(String(draft.collectionId)) || "";
        collectionsData.push({
          id: draft.collectionId,
          title: titleFromList || draft.collectionId,
          handle: handleFromList,
          grade: String(draft.grade ?? ""),
        });
      }
    }

    setAddingCollectionFor(null);
    setAddDraftByProductId((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });

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

  const deleteOneCollection = (productId, collectionId, colIdx) => {
    setCollectionGradeByProductId((prev) => {
      const existing = prev[productId] || [];
      return { ...prev, [productId]: existing.filter((_, i) => i !== colIdx) };
    });

    deleteFetcher.submit({ intent: "deleteCollection", productId, collectionId }, { method: "POST" });
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

  return (
    <Page title="Grade and Collection">
      <Layout>
        <Layout.Section>
          {saveError && (
            <Banner tone="critical" title="Save error">
              <p>{renderErrorText(saveError)}</p>
            </Banner>
          )}

          {deleteError && (
            <Banner tone="critical" title="Delete error">
              <p>{renderErrorText(deleteError)}</p>
            </Banner>
          )}

          {syncError && (
            <Banner tone="critical" title="Sync error">
              <p>{renderErrorText(syncError)}</p>
            </Banner>
          )}

          {finalReport && (
            <Banner tone="success" title="Sync completed (final report)">
              {finalReport.note ? <p>{finalReport.note}</p> : null}
              <p>
                Unique handles: {finalReport.totals?.uniqueHandles || 0} |
                Updated handles: {finalReport.totals?.updatedHandles || 0} | Updated rows:{" "}
                {finalReport.totals?.updatedRows || 0}
              </p>
              <p>
                Not in Shopify:{" "}
                {finalReport.totals?.missingInShopify || 0}
              </p>
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
                      loading={autoSyncOn && isSyncing}
                      disabled={isSaving || isDeleting || autoSyncOn || alreadyComplete}
                      onClick={startAutoSync}
                    >
                      Sync all (50 x batches)
                    </Button>

                    {autoSyncOn ? (
                      <Button tone="critical" disabled={isSaving || isDeleting} onClick={stopAutoSync}>
                        Stop
                      </Button>
                    ) : null}

                    <Button
                      disabled={isSaving || isDeleting || isSyncing || autoSyncOn || alreadyComplete}
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
                  <BlockStack gap="200">
                    <InlineStack align="space-between">

                      <Text as="span" tone="subdued">
                        {typeof totalForUI === "number" ? `${syncedSoFar} / ${totalForUI}` : `${syncedSoFar} / ?`}
                      </Text>
                    </InlineStack>

                    <ProgressBar progress={progressPct} />

                    <InlineStack align="space-between">

                      <Button size="slim" disabled={isSyncing} onClick={resetSync}>
                        Reset offset
                      </Button>
                    </InlineStack>

                    {alreadyComplete ? (
                      <Text as="span" tone="subdued" variant="bodySm">
                        Sync is already complete. If you want to run again, click Reset offset.
                      </Text>
                    ) : null}
                  </BlockStack>
                </Card>

                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={products.length}
                  selectable={false}
                  headings={headings}
                >
                  {products.map((p, idx) => {
                    const currentCollectionGrades = collectionGradeByProductId[p.id] || [];
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

                    const changed = JSON.stringify(currentCollectionGrades) !== JSON.stringify(originalCollectionGrades);

                    return (
                      <IndexTable.Row id={p.id} key={p.id} position={idx}>
                        <IndexTable.Cell>
                          <InlineStack align="trailing" gap="100">
                            {p.imageUrl ? (
                              <img
                                src={p.imageUrl}
                                alt={p.title || ""}
                                style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6 }}
                              />
                            ) : (
                              <div style={{ width: 48, height: 48, background: "#f4f6f8", borderRadius: 6 }} />
                            )}
                            <BlockStack gap="050">
                              <Text as="span">{p.title}</Text>
                            </BlockStack>
                          </InlineStack>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <BlockStack gap="150">
                            {(collectionGradeByProductId[p.id] || []).map((collItem, colIdx) => {
                              const deletingThis =
                                isDeleting &&
                                deleteFetcher.formData?.get("productId") === p.id &&
                                deleteFetcher.formData?.get("collectionId") === collItem.id;

                              return (
                                <InlineStack
                                  key={`${p.id}-collgrade-${colIdx}`}
                                  gap="200"
                                  blockAlign="center"
                                  wrap={false}
                                >
                                  <div style={{ width: 160, textOverflow: "ellipsis", whiteSpace: "normal" }}>
                                    <Badge tone="info">{collItem.title}</Badge>
                                  </div>

                                  <div style={{ width: 140 }}>
                                    <TextField
                                      label="Grade"
                                      labelHidden
                                      value={String(collItem.grade ?? "")}
                                      onChange={(v) => {
                                        setCollectionGradeByProductId((prev) => {
                                          const existing = prev[p.id] || [];
                                          const updated = [...existing];
                                          updated[colIdx] = { ...updated[colIdx], grade: v };
                                          return { ...prev, [p.id]: updated };
                                        });
                                      }}
                                      autoComplete="off"
                                    />
                                  </div>

                                  <Button
                                    size="slim"
                                    variant="plain"
                                    icon={DeleteIcon}
                                    tone="critical"
                                    loading={deletingThis}
                                    disabled={savingThisRow(p.id)}
                                    accessibilityLabel={`Remove ${collItem.title}`}
                                    onClick={() => deleteOneCollection(p.id, collItem.id, colIdx)}
                                  />
                                </InlineStack>
                              );
                            })}

                            {addingCollectionFor === p.id ? (
                              <InlineStack gap="200" blockAlign="center" wrap={false}>
                                <div style={{ minWidth: 220 }}>
                                  <Select
                                    options={collectionOptions.filter(
                                      (opt) =>
                                        !opt.value ||
                                        !(collectionGradeByProductId[p.id] || []).some((c) => c.id === opt.value)
                                    )}
                                    value={addDraftByProductId[p.id]?.collectionId || ""}
                                    onChange={(v) => {
                                      if (!v) return;
                                      const title = gidToTitle.get(String(v)) || "";
                                      const handle = gidToHandle.get(String(v)) || "";

                                      setCollectionGradeByProductId((prev) => {
                                        const existing = prev[p.id] || [];
                                        if (existing.some((c) => c.id === v)) return prev;
                                        return {
                                          ...prev,
                                          [p.id]: [
                                            ...existing,
                                            {
                                              id: v,
                                              title: title || String(v),
                                              handle,
                                              grade: String(addDraftByProductId[p.id]?.grade ?? ""),
                                            },
                                          ],
                                        };
                                      });

                                      setAddingCollectionFor(null);
                                      setAddDraftByProductId((prev) => {
                                        const next = { ...prev };
                                        delete next[p.id];
                                        return next;
                                      });
                                    }}
                                  />
                                </div>

                                <div style={{ width: 140 }}>
                                  <TextField
                                    label="Grade"
                                    labelHidden
                                    value={String(addDraftByProductId[p.id]?.grade ?? "")}
                                    onChange={(v) => {
                                      setAddDraftByProductId((prev) => ({
                                        ...prev,
                                        [p.id]: {
                                          collectionId: prev[p.id]?.collectionId || "",
                                          grade: v,
                                        },
                                      }));
                                    }}
                                    autoComplete="off"
                                  />
                                </div>

                                <Button
                                  size="slim"
                                  onClick={() => {
                                    setAddingCollectionFor(null);
                                    setAddDraftByProductId((prev) => {
                                      const next = { ...prev };
                                      delete next[p.id];
                                      return next;
                                    });
                                  }}
                                >
                                  Cancel
                                </Button>
                              </InlineStack>
                            ) : (
                              <InlineStack gap="200" blockAlign="center" wrap={false}>
                                <div style={{ minWidth: 220 }} />
                                <div style={{ minWidth: 220 }} />
                              </InlineStack>
                            )}
                          </BlockStack>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              width: "100%",
                              gap: "12px",
                            }}
                          >
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
                  <Pagination
                    hasPrevious={!!after}
                    onPrevious={() => {
                      window.location.href = window.location.pathname;
                    }}
                    hasNext={hasNextPage}
                    onNext={() => {
                      const u = new URL(window.location.href);
                      u.searchParams.set("after", endCursor);
                      window.location.href = u.toString();
                    }}
                  />
                  <Text as="span" tone="subdued">
                    Showing {products.length} products
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