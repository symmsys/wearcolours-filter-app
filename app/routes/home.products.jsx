// app/routes/home.products.jsx

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import { DeleteIcon } from "@shopify/polaris-icons";

import {
    Page,
    Layout,
    Card,
    Link,
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

const COLLECTION_GID_TO_SCHOOL = {
    "gid://shopify/Collection/276875411527": "Regina Dominican",
    "gid://shopify/Collection/282935689287": "FSHA",
    "gid://shopify/Collection/276875509831": "AOLP",
    "gid://shopify/Collection/276875280455": "Castilleja",
    "gid://shopify/Collection/276875444295": "NDB",
    "gid://shopify/Collection/276875247687": "Marlborough",
};

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

function getNumericIdFromGid(gid) {
    return String(gid || "").split("/").pop() || "";
}

function cleanText(v) {
    return String(v ?? "").trim();
}

function getAllowedSchoolNames() {
    return Object.values(COLLECTION_GID_TO_SCHOOL).map((v) => cleanText(v)).filter(Boolean);
}

function resolveSchoolTag({ dbSchoolTag = "", shopifyTags = [] }) {
    const dbValue = cleanText(dbSchoolTag);
    if (dbValue) return dbValue;

    const allowedSchools = new Set(
        getAllowedSchoolNames().map((v) => v.toLowerCase())
    );

    for (const tag of shopifyTags || []) {
        const cleanTag = cleanText(tag);
        if (!cleanTag) continue;

        if (allowedSchools.has(cleanTag.toLowerCase())) {
            return cleanTag;
        }
    }

    return "";
}

function resolveSchoolTagFromShopify(shopifyTags = []) {
    const allowedSchools = new Set(
        getAllowedSchoolNames().map((v) => v.toLowerCase())
    );

    for (const tag of shopifyTags || []) {
        const cleanTag = cleanText(tag);
        if (!cleanTag) continue;

        if (allowedSchools.has(cleanTag.toLowerCase())) {
            return cleanTag;
        }
    }

    return "";
}

function buildShopifyProductQuery({ search = "", school = "" }) {
    const parts = [];

    const cleanSearch = cleanText(search);
    const cleanSchool = cleanText(school);

    if (cleanSearch) {
        parts.push(cleanSearch);
    }

    if (cleanSchool) {
        parts.push(`tag:'${cleanSchool.replace(/'/g, "\\'")}'`);
    }

    return parts.join(" AND ");
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

async function fetchShopifySizeRangeFallbackMap(admin, handles = []) {
    try {
        const safeHandles = Array.from(
            new Set((handles || []).map((h) => cleanText(h)).filter(Boolean))
        );

        if (!safeHandles.length) return {};

        const out = {};
        const chunkSize = 20;

        const isSizeRangeField = (name) => {
            const n = cleanText(name).toLowerCase();
            return n === "size range";
        };

        for (let i = 0; i < safeHandles.length; i += chunkSize) {
            const chunk = safeHandles.slice(i, i + chunkSize);
            const query = chunk.map((h) => `handle:${h}`).join(" OR ");

            const res = await admin.graphql(
                `#graphql
                query ProductsForSizeFallback($first: Int!, $query: String!) {
                  products(first: $first, query: $query) {
                    edges {
                      node {
                        handle
                        options {
                          name
                          values
                        }
                        variants(first: 250) {
                          edges {
                            node {
                              title
                              selectedOptions {
                                name
                                value
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                `,
                {
                    variables: {
                        first: 50,
                        query,
                    },
                }
            );

            const json = await parseGraphql(res);
            const edges = json?.data?.products?.edges || [];

            for (const edge of edges) {
                const product = edge?.node;
                const handle = cleanText(product?.handle).toLowerCase();
                if (!handle) continue;

                let values = [];

                // 1) First try product options
                const matchedOption = (product?.options || []).find((opt) =>
                    isSizeRangeField(opt?.name)
                );

                if (matchedOption?.values?.length) {
                    values = matchedOption.values
                        .map((v) => cleanText(v))
                        .filter(Boolean);
                }

                // 2) Then try selectedOptions from variants
                if (!values.length) {
                    const variantEdges = product?.variants?.edges || [];

                    for (const ve of variantEdges) {
                        const opts = ve?.node?.selectedOptions || [];
                        for (const o of opts) {
                            if (isSizeRangeField(o?.name) && cleanText(o?.value)) {
                                values.push(cleanText(o.value));
                            }
                        }
                    }
                }

                // 3) Last fallback: variant title if not default

                out[handle] = uniqStrings(values).join(", ");
            }
        }

        return out;
    } catch (err) {
        console.error("fetchShopifySizeRangeFallbackMap error:", err);
        return {};
    }
}

async function fetchProductsWithGradeAndCollection(
    admin,
    supabase,
    { first = 50, after = null, search = "", school = "" } = {}
) {
    const searchText = String(search || "").trim();

    /* ---------------- SEARCH MODE (Supabase global search) ---------------- */

    if (searchText) {
        const res = await admin.graphql(
            `#graphql
    query ProductsSearch($first: Int!, $after: String, $query: String!) {
      products(first: $first, after: $after, query: $query, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            tags
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
                    after,
                    query: buildShopifyProductQuery({
                        search: searchText,
                        school,
                    }),
                },
            }
        );

        const json = await parseGraphql(res);
        const conn = json?.data?.products;
        const normalizedSearch = cleanText(searchText).toLowerCase();

        const shopifyItems = (conn?.edges || [])
            .map((e) => e?.node)
            .filter(Boolean)


        if (!shopifyItems.length) {
            return {
                items: [],
                hasNextPage: false,
                endCursor: null,
                totalCount: 0,
            };
        }

        const allHandles = shopifyItems
            .map((p) => cleanText(p.handle))
            .filter(Boolean);

        const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, allHandles);

        const missingAgeSizeHandles = allHandles.filter(
            (handle) => !cleanText(ageSizeRangeMap[cleanText(handle).toLowerCase()])
        );

        const shopifySizeFallbackMap = missingAgeSizeHandles.length
            ? await fetchShopifySizeRangeFallbackMap(admin, missingAgeSizeHandles)
            : {};

        let savedQuery = supabase.from(EXTERNAL_TABLE).select("*").in("product_handle", allHandles);



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
                        school_tag: record.school_tag || "",
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
                    shopify_tags: Array.isArray(p?.tags) ? p.tags : [],
                    school_tag: resolveSchoolTagFromShopify(
                        Array.isArray(p?.tags) ? p.tags : []
                    ),
                    imageUrl: p?.featuredImage?.url || "",
                    size: collectArray("size"),
                    size_type: firstValue("size type"),
                    size_range: firstValue("size range"),
                    age_size_range:
                        ageSizeRangeMap[cleanText(p.handle).toLowerCase()] ||
                        shopifySizeFallbackMap[cleanText(p.handle).toLowerCase()] ||
                        "",
                    collectionId: savedCollections[0]?.id || firstCol?.id || "",
                    collectionTitle: savedCollections[0]?.title || firstCol?.title || "",
                    collectionHandle: savedCollections[0]?.handle || firstCol?.handle || "",
                    savedCollections,
                };
            })


        const totalCount = await fetchProductsCount(admin, searchText, school);

        return {
            items: products,
            hasNextPage: !!conn?.pageInfo?.hasNextPage,
            endCursor: conn?.pageInfo?.endCursor || null,
            totalCount,
        };
    }

    // if (!searchText && collectionId) {
    // //     const numericOffset = Number.isFinite(Number(after)) ? Number(after) : 0;

    // //     const { data: matchedRows, error: matchErr } = await supabase
    // //         .from(EXTERNAL_TABLE)
    // //             .select(`
    // //             shopify_product_id,
    // //             product_title,
    // //             product_handle,
    // //             collection_id,
    // //             collection_title,
    // //             collection_handle,
    // //             grade,
    // //             school_tag
    // //         `)
    // //         .eq("collection_id", collectionId)
    // //         .order("product_title", { ascending: true });

    // //     if (matchErr) throw new Error(matchErr.message);

    // //     const uniqueHandleMap = new Map();

    // //     for (const row of matchedRows || []) {
    // //         const handle = cleanText(row?.product_handle);
    // //         if (!handle) continue;

    // //         const key = handle.toLowerCase();

    // //         if (!uniqueHandleMap.has(key)) {
    // //             uniqueHandleMap.set(key, {
    // //                 id: row?.shopify_product_id || "",
    // //                 handle,
    // //                 title: row?.product_title || "",
    // //                 collection_id: cleanText(row?.collection_id),
    // //                 collection_title: cleanText(row?.collection_title),
    // //                 collection_handle: cleanText(row?.collection_handle),
    // //                 grade: cleanText(row?.grade),
    // //                 school_tag: cleanText(row?.school_tag),
    // //             });
    // //         }
    // //     }

    // //     const matchedProducts = Array.from(uniqueHandleMap.values());

    // //     const totalCount = matchedProducts.length;

    // //     if (!matchedProducts.length) {
    // //         return {
    // //             items: [],
    // //             hasNextPage: false,
    // //             endCursor: null,
    // //             totalCount: 0,
    // //             pageStart: 0,
    // //             pageEnd: 0,
    // //         };
    // //     }

    // //     const pagedMatches = matchedProducts.slice(numericOffset, numericOffset + first);
    // //     const nextOffset = numericOffset + first;
    // //     const hasNextPage = nextOffset < matchedProducts.length;

    // //     const handles = pagedMatches
    // //         .map((entry) => cleanText(entry.handle))
    // //         .filter(Boolean);

    // //     const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, handles);
    // //     const missingAgeSizeHandles = handles.filter(
    // //         (handle) => !cleanText(ageSizeRangeMap[cleanText(handle).toLowerCase()])
    // //     );

    // //     const shopifySizeFallbackMap = missingAgeSizeHandles.length
    // //         ? await fetchShopifySizeRangeFallbackMap(admin, missingAgeSizeHandles)
    // //         : {};

    // //     const products = [];

    // //     for (const entry of pagedMatches) {
    // //         const res = await admin.graphql(
    // //             `#graphql
    // //         query ProductByHandle($handle: String!) {
    // //           productByHandle(handle: $handle) {
    // //             id
    // //             title
    // //             handle
    // //             tags
    // //             metafield(namespace: "${GRADE_NAMESPACE}", key: "${GRADE_KEY}") { value }
    // //             featuredImage { url altText }
    // //             variants(first: 250) {
    // //               edges { node { selectedOptions { name value } } }
    // //             }
    // //           }
    // //         }
    // //         `,
    // //             { variables: { handle: entry.handle } }
    // //         );

    // //         const json = await parseGraphql(res);
    // //         const p = json?.data?.productByHandle;

    // //         if (!p?.id) continue;

    // //         const variantEdges = p?.variants?.edges || [];

    // //         const collectArray = (optName) => {
    // //             const vals = [];
    // //             for (const ve of variantEdges) {
    // //                 const opts = ve?.node?.selectedOptions || [];
    // //                 for (const o of opts) {
    // //                     if (String(o.name || "").toLowerCase() === optName) vals.push(o.value);
    // //                 }
    // //             }
    // //             return Array.from(new Set(vals)).filter((v) => v != null && String(v).trim() !== "");
    // //         };

    // //         const firstValue = (optName) => {
    // //             for (const ve of variantEdges) {
    // //                 const opts = ve?.node?.selectedOptions || [];
    // //                 for (const o of opts) {
    // //                     if (String(o.name || "").toLowerCase() === optName && o.value) return o.value;
    // //                 }
    // //             }
    // //             return null;
    // //         };

    // //         products.push({
    // //             id: p.id,
    // //             title: p.title || entry.title || "",
    // //             handle: p.handle || entry.handle || "",
    // //             grade: entry.grade || p?.metafield?.value || "",
    // //             shopify_tags: Array.isArray(p?.tags) ? p.tags : [],
    // //             school_tag: resolveSchoolTagFromShopify(
    // //                 Array.isArray(p?.tags) ? p.tags : []
    // //             ),
    // //             imageUrl: p?.featuredImage?.url || "",
    // //             size: collectArray("size"),
    // //             size_type: firstValue("size type"),
    // //             size_range: firstValue("size range"),
    // //             age_size_range:
    // //                 ageSizeRangeMap[cleanText(p.handle).toLowerCase()] ||
    // //                 shopifySizeFallbackMap[cleanText(p.handle).toLowerCase()] ||
    // //                 "",
    // //             collectionId: entry.collection_id || "",
    // //             collectionTitle: entry.collection_title || "",
    // //             collectionHandle: entry.collection_handle || "",
    // //             savedCollections: [
    // //                 {
    // //                     id: entry.collection_id || "",
    // //                     title: entry.collection_title || "",
    // //                     handle: entry.collection_handle || "",
    // //                     grade: entry.grade || "",
    // //                 },
    // //             ],
    // //         });
    // //     }

    // //     return {
    // //         items: products,
    // //         hasNextPage,
    // //         endCursor: hasNextPage ? String(nextOffset) : null,
    // //         totalCount,
    // //         pageStart: totalCount ? numericOffset + 1 : 0,
    // //         pageEnd: Math.min(numericOffset + products.length, totalCount),
    // //     };
    // // }

    const res = await admin.graphql(
        `#graphql
      query Products($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              handle
              tags
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
        {
            variables: {
                first,
                after,
                query: buildShopifyProductQuery({
                    search: "",
                    school,
                }) || null,
            },
        }
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
            shopify_tags: Array.isArray(p?.tags) ? p.tags : [],
            imageUrl: p?.featuredImage?.url || "",
            size: collectArray("size"),
            size_type: firstValue("size type"),
            size_range: firstValue("size range"),
            collectionId: firstCol?.id || "",
            collectionTitle: firstCol?.title || "",
            collectionHandle: firstCol?.handle || "",
        };
    });

    const currentPageProductIds = items
        .map((item) => cleanText(item.id))
        .filter(Boolean);

    let savedData = [];
    let fetchErr = null;

    if (currentPageProductIds.length > 0) {
        const result = await supabase
            .from(EXTERNAL_TABLE)
            .select("*")
            .in("shopify_product_id", currentPageProductIds);

        savedData = result.data || [];
        fetchErr = result.error || null;
    }

    if (fetchErr) console.error("Error fetching from Supabase:", fetchErr);

    const allProductHandles = items
        .map((item) => cleanText(item.handle))
        .filter(Boolean);

    const ageSizeRangeMap = await fetchAgeSizeRangeMap(supabase, allProductHandles);

    const missingAgeSizeHandles = allProductHandles.filter(
        (handle) => !cleanText(ageSizeRangeMap[cleanText(handle).toLowerCase()])
    );

    const shopifySizeFallbackMap = missingAgeSizeHandles.length
        ? await fetchShopifySizeRangeFallbackMap(admin, missingAgeSizeHandles)
        : {};

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
                    school_tag: record.school_tag || "",
                });
            }
        }
    }

    const mergedItems = items.map((item) => {
        const savedCollections = collectionsByProductId[item.id] || [];
        const ageSizeRange =
            ageSizeRangeMap[cleanText(item.handle).toLowerCase()] ||
            shopifySizeFallbackMap[cleanText(item.handle).toLowerCase()] ||
            "";

        if (savedCollections.length > 0) {
            return {
                ...item,
                age_size_range: ageSizeRange,
                school_tag: resolveSchoolTagFromShopify(item.shopify_tags || []),
                collectionId: savedCollections[0]?.id || "",
                collectionTitle: savedCollections[0]?.title || "",
                collectionHandle: savedCollections[0]?.handle || "",
                savedCollections,
            };
        }

        return {
            ...item,
            age_size_range: ageSizeRange,
            school_tag: resolveSchoolTagFromShopify(item.shopify_tags || []),
            savedCollections: [],
        };
    });



    const shouldFetchTotalCount = !after;
    const totalCount = shouldFetchTotalCount ? await fetchProductsCount(admin, "", school) : null;
    return {
        items: mergedItems,
        hasNextPage: !!conn?.pageInfo?.hasNextPage,
        endCursor: conn?.pageInfo?.endCursor || null,
        totalCount,
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

            if (String(o?.name || "").toLowerCase() === "size range" && o?.value) {
                sizes.push(o.value);
            }
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

async function fetchShopifySchoolTagByHandle(admin, handle) {
    const cleanHandle = cleanText(handle);
    if (!cleanHandle) return "";

    const res = await admin.graphql(
        `#graphql
        query ProductSchoolTags($handle: String!) {
          productByHandle(handle: $handle) {
            id
            handle
            tags
          }
        }
        `,
        { variables: { handle: cleanHandle } }
    );

    const json = await parseGraphql(res);
    const product = json?.data?.productByHandle;

    if (!product) return "";

    return resolveSchoolTagFromShopify(
        Array.isArray(product.tags) ? product.tags : []
    );
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

async function fetchProductsCount(admin, search = "", school = "") {
    try {
        const res = await admin.graphql(
            `#graphql
            query ProductsCount($query: String) {
              productsCount(query: $query) {
                count
              }
            }
            `,
            {
                variables: {
                    query: buildShopifyProductQuery({
                        search,
                        school,
                    }) || null,
                },
            }
        );

        const json = await parseGraphql(res);
        return Number(json?.data?.productsCount?.count || 0);
    } catch (err) {
        console.error("fetchProductsCount error:", err);
        return null;
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
    const schoolFromUrl = (url.searchParams.get("school") || "").trim();
    // const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);

    const collections = await fetchAllCollections(admin);



    const {
        items,
        hasNextPage,
        endCursor,
        totalCount = null,
        pageStart = null,
        pageEnd = null,
    } = await fetchProductsWithGradeAndCollection(admin, supabase, {
        first: 50,
        after: after || null,
        search: q,
        school: schoolFromUrl,
    });

    let masterTotal = null;
    try {
        const { count, error } = await supabase
            .from(MASTER_TABLE)
            .select('"Handle"', { count: "exact", head: true });

        if (!error && typeof count === "number") masterTotal = count;
    } catch {
        // ignore
    }

    let syncJob = null;
    try {
        const { data, error } = await supabase
            .from("sync_jobs")
            .select("*")
            .eq("shop", shop)
            .eq("job_type", "grade_sync")
            .order("id", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!error) syncJob = data || null;
    } catch {
        // ignore
    }

    return {
        shop,
        products: items,
        searchQuery: q,
        selectedSchool: schoolFromUrl,
        collections,
        hasNextPage,
        endCursor,
        after: after || null,
        masterTotal,
        totalCount,
        pageStart,
        pageEnd,
        syncJob,
    };
};

async function updateMasterDatabaseGrades(supabase, { productHandle, collectionGradesList = [] }) {
    const cleanHandle = cleanText(productHandle);
    if (!cleanHandle) return;

    for (const item of collectionGradesList) {
        const collectionId = cleanText(item?.id);
        const grade = cleanText(item?.grade);
        const schoolName = COLLECTION_GID_TO_SCHOOL[collectionId];

        // If collection is not in hardcoded map, skip it
        if (!schoolName) continue;

        const { error } = await supabase
            .from(MASTER_TABLE)
            .update({
                Grade: grade || null,
            })
            .eq("Handle", cleanHandle)
            .eq("School", schoolName);

        if (error) {
            throw new Error(
                `Failed to update master database colours for handle "${cleanHandle}" and school "${schoolName}": ${error.message}`
            );
        }
    }
}

/* ---------------- ACTION ---------------- */

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const supabase = getSupabaseAdmin();
    const form = await request.formData();
    const intent = cleanText(form.get("intent"));

    if (intent === "startSyncJob") {
        const { session } = await authenticate.admin(request);
        const shop = session?.shop || "";

        if (!shop) return { ok: false, error: "Missing shop" };

        try {
            const batchLimit = Math.max(1, Math.max(200, toInt(form.get("batchLimit"), 100)));

            const { data: existingJob, error: existingErr } = await supabase
                .from("sync_jobs")
                .select("*")
                .eq("shop", shop)
                .eq("job_type", "grade_sync")
                .order("id", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existingErr) throw new Error(existingErr.message);

            // If there is already a running or queued job, just return it
            if (existingJob && ["queued", "running"].includes(existingJob.status)) {
                return { ok: true, intent, job: existingJob };
            }

            // If there is a paused/completed/failed/cancelled job, reuse it and start from its current state
            if (existingJob) {
                const { data: resumedJob, error: resumeErr } = await supabase
                    .from("sync_jobs")
                    .update({
                        status: "queued",
                        batch_limit: batchLimit,
                        cancel_requested: false,
                        error_message: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", existingJob.id)
                    .select("*")
                    .single();

                if (resumeErr) throw new Error(resumeErr.message);

                return { ok: true, intent, job: resumedJob };
            }

            // No job exists yet, create a new queued one
            const { data: newJob, error: newErr } = await supabase
                .from("sync_jobs")
                .insert({
                    shop,
                    job_type: "grade_sync",
                    status: "queued",
                    batch_offset: 0,
                    batch_limit: batchLimit,
                    total_master: null,
                    batches: 0,
                    unique_handles: 0,
                    updated_handles: 0,
                    updated_rows: 0,
                    inserted_products: 0,
                    inserted_rows: 0,
                    missing_in_shopify: 0,
                    cancel_requested: false,
                    error_message: null,
                    started_at: null,
                    completed_at: null,
                    updated_at: new Date().toISOString(),
                })
                .select("*")
                .single();

            if (newErr) throw new Error(newErr.message);

            return { ok: true, intent, job: newJob };
        } catch (e) {
            return { ok: false, intent, error: safeErrToString(e) };
        }
    }

    if (intent === "pauseSyncJob") {
        const { session } = await authenticate.admin(request);
        const shop = session?.shop || "";

        try {
            const { data, error } = await supabase
                .from("sync_jobs")
                .update({
                    status: "paused",
                    updated_at: new Date().toISOString(),
                })
                .eq("shop", shop)
                .eq("job_type", "grade_sync")
                .in("status", ["queued", "running"])
                .select("*")
                .limit(1)
                .maybeSingle();

            if (error) throw new Error(error.message);

            return { ok: true, intent, job: data || null };
        } catch (e) {
            return { ok: false, intent, error: safeErrToString(e) };
        }
    }

    if (intent === "resetSyncJob") {
        const { session } = await authenticate.admin(request);
        const shop = session?.shop || "";

        if (!shop) return { ok: false, error: "Missing shop" };

        try {
            const { data: existingJob, error: existingErr } = await supabase
                .from("sync_jobs")
                .select("*")
                .eq("shop", shop)
                .eq("job_type", "grade_sync")
                .order("id", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existingErr) throw new Error(existingErr.message);

            // If no job exists yet, create a fresh paused job
            if (!existingJob) {
                const { data: newJob, error: newErr } = await supabase
                    .from("sync_jobs")
                    .insert({
                        shop,
                        job_type: "grade_sync",
                        status: "paused",
                        batch_offset: 0,
                        batch_limit: 100,
                        total_master: null,
                        batches: 0,
                        unique_handles: 0,
                        updated_handles: 0,
                        updated_rows: 0,
                        inserted_products: 0,
                        inserted_rows: 0,
                        missing_in_shopify: 0,
                        cancel_requested: false,
                        error_message: null,
                        started_at: null,
                        completed_at: null,
                        updated_at: new Date().toISOString(),
                    })
                    .select("*")
                    .single();

                if (newErr) throw new Error(newErr.message);

                return { ok: true, intent, job: newJob };
            }

            // If a job exists, just reset it in place and keep it paused
            const { data: resetJob, error: resetErr } = await supabase
                .from("sync_jobs")
                .update({
                    status: "paused",
                    batch_offset: 0,
                    total_master: null,
                    batches: 0,
                    unique_handles: 0,
                    updated_handles: 0,
                    updated_rows: 0,
                    inserted_products: 0,
                    inserted_rows: 0,
                    missing_in_shopify: 0,
                    cancel_requested: false,
                    error_message: null,
                    started_at: null,
                    completed_at: null,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", existingJob.id)
                .select("*")
                .single();

            if (resetErr) throw new Error(resetErr.message);

            return { ok: true, intent, job: resetJob };
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

        const resolvedSchoolTag = await fetchShopifySchoolTagByHandle(admin, productHandle);

        const upsertRecords = collectionGradesList.map((item) => ({
            shopify_product_id: productId,
            product_title: productTitle || null,
            product_handle: productHandle || null,

            collection_id: item.id || null,
            collection_title: item.title || null,
            collection_handle: String(item.handle ?? "").trim() || null,

            school_tag: resolvedSchoolTag || null,

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

            // NEW: update Grade in "master database colours"
            await updateMasterDatabaseGrades(supabase, {
                productHandle,
                collectionGradesList,
            });
        } else {
            const { error: delErr } = await supabase
                .from(EXTERNAL_TABLE)
                .delete()
                .eq("shopify_product_id", productId);

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

    const navigate = useNavigate();
    const [cursorStack, setCursorStack] = useState([]);
    useAppBridge(); // keep bridge ready

    const fetcher = useFetcher(); // saveRow
    const syncFetcher = useFetcher(); // syncGradesBatch
    const searchFetcher = useFetcher(); // for search form (to reset pagination)

    const data = loaderData;

    const {
        shop,
        products,
        collections,
        hasNextPage,
        endCursor,
        after,
        page,
        masterTotal,
        searchQuery: initialSearchQuery,
        selectedSchool: initialSelectedSchool,
        totalCount,
        pageStart,
        pageEnd,
        syncJob,
    } = data;

    const [collectionGradeByProductId, setCollectionGradeByProductId] = useState({});

    const [selectedSchool, setSelectedSchool] = useState(initialSelectedSchool || "");
    useEffect(() => {
        setSelectedSchool(initialSelectedSchool || "");
    }, [initialSelectedSchool]);
    const [addingCollectionFor, setAddingCollectionFor] = useState(null);
    const [addDraftByProductId, setAddDraftByProductId] = useState({});
    const [searchQuery, setSearchQuery] = useState(initialSearchQuery || "");
    const [editingUnsavedCollection, setEditingUnsavedCollection] = useState(null);

    const PAGE_SIZE = 50;

    const isSchoolMode = !!initialSelectedSchool && !initialSearchQuery;




    // auto-sync controls
    const [waveFrozen, setWaveFrozen] = useState(false);
    const [waveBgPos, setWaveBgPos] = useState("0px 0px");
    const waveRef = useRef(null);

    // Only show FINAL report when done




    // Progress animation (smooth percent count-up)
    const [displayPct, setDisplayPct] = useState(0);

    const isSaving = fetcher.state !== "idle";
    const isSyncing = syncFetcher.state !== "idle";
    const isSearching = searchFetcher.state !== "idle";

    const currentJob =
        syncFetcher.state !== "idle"
            ? (syncFetcher.data?.job ?? searchFetcher.data?.syncJob ?? syncJob ?? null)
            : (searchFetcher.data?.syncJob ?? syncJob ?? null);

    const currentStatus = currentJob?.status || "idle";

    const isRunning = currentStatus === "queued" || currentStatus === "running";
    const isPaused = currentStatus === "paused";
    const alreadyComplete = currentStatus === "completed";

    const isResetState =
        currentStatus === "paused" &&
        !currentJob?.started_at &&
        Number(currentJob?.batch_offset || 0) === 0;

    const showPausedLabel = isPaused && !isResetState;

    const showResumeButton = !isRunning && !alreadyComplete && isPaused && !isResetState;

    const currentOffset = Number(currentJob?.batch_offset || 0);
    const totalForUI = Number(currentJob?.total_master || masterTotal || 0);

    const isCompleted = currentJob?.status === "completed";

    const syncedSoFar = isCompleted
        ? 0
        : Math.min(currentOffset, totalForUI || currentOffset);

    const progressPct =
        isCompleted
            ? 0
            : totalForUI > 0
                ? Math.min(100, Math.round((syncedSoFar / totalForUI) * 100))
                : 0;

    // Track if we're currently searching (not filtering)
    const [isSearchLoading, setIsSearchLoading] = useState(false);
    const [isCollectionFilterLoading, setIsCollectionFilterLoading] = useState(false);

    const saveError = fetcher.data?.ok === false ? fetcher.data.error : null;

    const syncError =
        syncFetcher.data?.ok === false
            ? syncFetcher.data.error
            : currentJob?.status === "failed"
                ? currentJob?.error_message
                : null;


    useEffect(() => {
        setCursorStack([]);
    }, [initialSearchQuery, initialSelectedSchool]);

    useEffect(() => {
        if (!currentJob) return;
        if (!["queued", "running", "paused"].includes(currentJob.status)) return;

        const timer = setInterval(() => {
            searchFetcher.load(window.location.pathname + window.location.search);
        }, 5000);

        return () => clearInterval(timer);
    }, [currentJob, searchFetcher]);

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



    const collectionOptions = useMemo(() => {
        const filtered = (collections || []).filter((c) =>
            ALLOWED_COLLECTION_IDS.has(String(c.id))
        );

        return [
            { label: "No collection", value: "" },
            ...filtered.map((c) => ({ label: c.title, value: c.id })),
        ];
    }, [collections]);

    const schoolFilterOptions = useMemo(() => {
        const schools = getAllowedSchoolNames().sort((a, b) => a.localeCompare(b));

        return [
            { label: "All schools", value: "" },
            ...schools.map((school) => ({
                label: school,
                value: school,
            })),
        ];
    }, []);

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

    const headings = useMemo(() => [{ title: "Product" }, { title: "Age size range" }, { title: "School" }, { title: "Collection" },
    { title: "Grade" }, { title: "Action" }], []);

    const filteredProducts = products || [];
    const shouldShowPagination = !!after || hasNextPage;



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



    const startAutoSync = () => {
        syncFetcher.submit(
            {
                intent: "startSyncJob",
                batchLimit: "100",
            },
            { method: "POST" }
        );
    };

    const stopAutoSync = () => {
        syncFetcher.submit(
            {
                intent: "pauseSyncJob",
            },
            { method: "POST" }
        );
    };



    const resetSync = () => {
        syncFetcher.submit(
            {
                intent: "resetSyncJob",
            },
            { method: "POST" }
        );
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
        const selectedTrimmed = String(selectedSchool || "").trim();
        const initialSelectedTrimmed = String(initialSelectedSchool || "").trim();

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
                params.set("school", selectedTrimmed);
            } else {
                params.delete("school");
            }

            params.delete("page");
            params.delete("after");
            params.delete("collectionId");

            const qs = params.toString();

            navigate(
                qs ? `${window.location.pathname}?${qs}` : window.location.pathname
            );
        }, 400);

        return () => clearTimeout(timer);
    }, [
        searchQuery,
        selectedSchool,
        initialSearchQuery,
        initialSelectedSchool,
        navigate,
    ]);
    // Reset search loading when fetcher completes
    useEffect(() => {
        setIsSearchLoading(false);
        setIsCollectionFilterLoading(false);
    }, [initialSearchQuery, initialSelectedSchool]);

    const getAdminProductUrl = (productGid) => {
        const numericId = getNumericIdFromGid(productGid);
        if (!numericId || !shop) return "#";
        return `https://${shop}/admin/products/${numericId}`;
    };

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



                    {currentJob?.status === "completed" && (
                        <Banner tone="success" title="Sync completed">
                            <p>
                                Unique handles: {currentJob?.unique_handles || 0} | Updated handles:{" "}
                                {currentJob?.updated_handles || 0} | Updated rows: {currentJob?.updated_rows || 0}
                            </p>
                            <p>Not in Shopify: {currentJob?.missing_in_shopify || 0}</p>
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
                                        {!alreadyComplete && !isRunning ? (
                                            <Button
                                                variant="primary"
                                                loading={syncFetcher.state !== "idle"}
                                                disabled={isSaving || syncFetcher.state !== "idle"}
                                                onClick={startAutoSync}
                                            >
                                                {showResumeButton ? "Resume Sync" : "Sync all"}
                                            </Button>
                                        ) : null}

                                        {isRunning ? (
                                            <Button
                                                tone="critical"
                                                disabled={isSaving || syncFetcher.state !== "idle"}
                                                onClick={stopAutoSync}
                                            >
                                                Pause
                                            </Button>
                                        ) : null}
                                    </InlineStack>
                                </InlineStack>

                                <Card sectioned>
                                    <BlockStack gap="300">
                                        <InlineStack align="space-between">
                                            <Text as="span" tone="subdued">
                                                {alreadyComplete
                                                    ? "Sync complete"
                                                    : isResetState
                                                        ? "Ready to sync"
                                                        : typeof totalForUI === "number"
                                                            ? `${syncedSoFar} / ${totalForUI}`
                                                            : `${syncedSoFar} / ?`}
                                            </Text>

                                            <Text as="span" tone="subdued">
                                                {showPausedLabel
                                                    ? "Paused"
                                                    : alreadyComplete
                                                        ? "Sync complete"
                                                        : isRunning
                                                            ? "Running"
                                                            : ""}
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
                                            <Button size="slim" disabled={isSyncing || isRunning} onClick={resetSync}>
                                                Reset sync
                                            </Button>
                                        </InlineStack>

                                        {alreadyComplete ? (
                                            <Text as="span" tone="subdued" variant="bodySm">
                                                Sync is complete. Click Reset sync to start over.
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
                                                label="Filter by school"
                                                labelHidden
                                                options={schoolFilterOptions}
                                                value={selectedSchool}
                                                onChange={setSelectedSchool}
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
                                                            <Link url={getAdminProductUrl(p.id)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", color: "inherit", fontWeight: 500 }} removeUnderline>
                                                                {p.title}
                                                            </Link>
                                                        </BlockStack>
                                                    </InlineStack>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <Text as="span" tone={p.age_size_range ? "base" : "subdued"}>
                                                        {p.age_size_range || ""}
                                                    </Text>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>
                                                    <Text as="span" tone={p.school_tag ? "base" : "subdued"}>
                                                        {p.school_tag || "—"}
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
                                            hasPrevious={cursorStack.length > 0}
                                            hasNext={hasNextPage}
                                            onPrevious={() => {
                                                const u = new URL(window.location.href);

                                                setCursorStack((prev) => {
                                                    const nextStack = [...prev];
                                                    const previousCursor = nextStack.pop();

                                                    if (previousCursor) {
                                                        u.searchParams.set("after", previousCursor);
                                                    } else {
                                                        u.searchParams.delete("after");
                                                    }

                                                    navigate(`${u.pathname}${u.search}`);
                                                    return nextStack;
                                                });
                                            }}
                                            onNext={() => {
                                                if (!endCursor) return;

                                                const u = new URL(window.location.href);

                                                setCursorStack((prev) => {
                                                    const currentCursor = after || "";
                                                    return [...prev, currentCursor];
                                                });

                                                u.searchParams.set("after", endCursor);
                                                navigate(`${u.pathname}${u.search}`);
                                            }}
                                        />
                                    ) : (
                                        <div />
                                    )}

                                    <div />
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