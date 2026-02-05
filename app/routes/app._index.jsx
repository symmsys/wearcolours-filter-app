// app/routes/app._index.jsx

import { useEffect, useMemo, useState } from "react";
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
} from "@shopify/polaris";

const EXTERNAL_TABLE = "product_grade_collection";

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
            edges { node { id title } }
          }
        }
      `,
      { variables: { first: 250, after } }
    );

    const json = await parseGraphql(res);
    const conn = json?.data?.collections;
    const edges = conn?.edges || [];

    for (const e of edges) {
      if (e?.node?.id) all.push({ id: e.node.id, title: e.node.title || "" });
    }

    const pageInfo = conn?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo?.endCursor;
    if (!after) break;
  }

  return all;
}

async function fetchProductsWithGradeAndCollection(admin, { first = 50, after = null } = {}) {
  const res = await admin.graphql(
    `#graphql
      query Products($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              metafield(namespace: "${GRADE_NAMESPACE}", key: "${GRADE_KEY}") { value }
                featuredImage { url altText }
                variants(first: 250) {
                  edges { node { selectedOptions { name value } } }
                }
                collections(first: 1) {
                edges { node { id title } }
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
    // collect values across variants
    const variantEdges = p?.variants?.edges || [];

    // collect all values for an option name into a deduplicated array
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

    // get first matching value for an option name (used for size_type and size_range)
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
      grade: p?.metafield?.value || "",
      imageUrl: p?.featuredImage?.url || "",
      // size should be an array of all variant values for the `size` option
      size: collectArray("size"),
      // size_type and size_range are single text values (take first found)
      size_type: firstValue("size type"),
      size_range: firstValue("size range"),
      collectionId: firstCol?.id || "",
      collectionTitle: firstCol?.title || "",
    };
  });

  return {
    items,
    hasNextPage: !!conn?.pageInfo?.hasNextPage,
    endCursor: conn?.pageInfo?.endCursor || null,
  };
}

async function setProductGrade(admin, productId, gradeValue) {
  const value = String(gradeValue ?? "").trim();

  const res = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: productId,
          namespace: GRADE_NAMESPACE,
          key: GRADE_KEY,
          type: GRADE_TYPE,
          value,
        },
      ],
    },
  });

  await parseGraphql(res, {
    nodeName: "metafieldsSet",
    nodeGetter: (j) => j?.data?.metafieldsSet,
  });
}

async function addToCollection(admin, collectionId, productId) {
  const res = await admin.graphql(COLLECTION_ADD_PRODUCTS, {
    variables: { collectionId, productIds: [productId] },
  });

  await parseGraphql(res, {
    nodeName: "collectionAddProducts",
    nodeGetter: (j) => j?.data?.collectionAddProducts,
  });
}

async function removeFromCollection(admin, collectionId, productId) {
  const res = await admin.graphql(COLLECTION_REMOVE_PRODUCTS, {
    variables: { collectionId, productIds: [productId] },
  });

  await parseGraphql(res, {
    nodeName: "collectionRemoveProducts",
    nodeGetter: (j) => j?.data?.collectionRemoveProducts,
  });
}

/* ---------------- LOADER ---------------- */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  const url = new URL(request.url);
  const after = url.searchParams.get("after"); // cursor
  const { items, hasNextPage, endCursor } = await fetchProductsWithGradeAndCollection(admin, {
    first: 50,
    after: after || null,
  });

  const collections = await fetchAllCollections(admin);

  return {
    shop,
    products: items,
    collections,
    hasNextPage,
    endCursor,
    after: after || null,
  };
};

/* ---------------- ACTION ---------------- */

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  const supabase = getSupabaseAdmin();
  const form = await request.formData();

  const intent = cleanText(form.get("intent"));
  if (intent !== "saveRow") return { ok: false, error: "Unknown intent" };

  const productId = cleanText(form.get("productId"));
  const productTitle = cleanText(form.get("productTitle"));
  const grade = String(form.get("grade") ?? "");
  const newCollectionId = cleanText(form.get("collectionId"));
  const oldCollectionId = cleanText(form.get("oldCollectionId"));
  const newCollectionTitle = cleanText(form.get("collectionTitle"));

  if (!productId) return { ok: false, error: "Missing productId" };

  // Only persist changes to external DB (Supabase). Do NOT modify Shopify admin.
  try {
    // parse JSON array string for `size` and read plain strings for size_range/size_type
    const parseArr = (k) => {
      const v = form.get(k);
      if (!v) return null;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : null;
      } catch (e) {
        return null;
      }
    };

    const sizeArr = parseArr("size");
    const sizeRangeVal = form.get("size_range") || null;
    const sizeTypeVal = form.get("size_type") || null;

    const { error: upErr } = await supabase
      .from(EXTERNAL_TABLE)
      .upsert(
        [
          {
            shopify_product_id: productId,
            product_title: productTitle || null,
            grade: String(grade ?? "").trim() || null,
            collection_id: newCollectionId || null,
            collection_title: newCollectionTitle || null,
            size_range: sizeRangeVal,
            size_type: sizeTypeVal,
            size: sizeArr,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: "shopify_product_id" }
      );

    if (upErr) throw new Error(upErr.message);

    return { ok: true, productId };
  } catch (e) {
    return { ok: false, error: e?.message || "Save failed" };
  }
};

/* ---------------- UI ---------------- */

export default function GradeCollectionPage() {
  const { shop, products, collections, hasNextPage, endCursor, after } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [gradeById, setGradeById] = useState({});
  const [collectionById, setCollectionById] = useState({});

  const isSaving = fetcher.state !== "idle";
  const saveError = fetcher.data?.ok === false ? fetcher.data.error : null;

  const collectionOptions = useMemo(() => {
    return [
      { label: "No collection", value: "" },
      ...collections.map((c) => ({ label: c.title, value: c.id })),
    ];
  }, [collections]);

  const gidToTitle = useMemo(() => {
    const m = new Map();
    for (const c of collections) m.set(String(c.id), String(c.title || ""));
    return m;
  }, [collections]);

  // Initialize local editable state when products change
  useEffect(() => {
    const g = {};
    const c = {};
    for (const p of products) {
      g[p.id] = p.grade || "";
      c[p.id] = p.collectionId || "";
    }
    setGradeById(g);
    setCollectionById(c);
  }, [products]);

  const saveRow = (p) => {
    const newCollectionId = cleanText(collectionById[p.id]);
    const collectionTitle = newCollectionId ? gidToTitle.get(newCollectionId) || "" : "";

    fetcher.submit(
      {
        intent: "saveRow",
        productId: p.id,
        productTitle: p.title,
        grade: String(gradeById[p.id] ?? ""),
        collectionId: newCollectionId,
        oldCollectionId: p.collectionId || "",
        collectionTitle,
        // size is sent as JSON array; size_range and size_type are plain strings
        size_range: p.size_range || "",
        size_type: p.size_type || "",
        size: JSON.stringify(p.size || []),
      },
      { method: "POST" }
    );
  };

  const headings = useMemo(
    () => [
      { title: "Product" },
      { title: "Grade" },
      { title: "Collection" },
      { title: "Save" },
    ],
    []
  );

  return (
    <Page title="Grade and Collection">
      <Layout>
        <Layout.Section>
          {saveError && (
            <Banner tone="critical" title="Save error">
              <p>{saveError}</p>
            </Banner>
          )}

          <Card>
            <div style={{ padding: 16 }}>
              <BlockStack gap="300">
                <InlineStack align="space-between" gap="200">
                  <Text as="h2" variant="headingMd">
                    Products
                  </Text>
                  <Text as="span" tone="subdued">
                    Store: {shop}
                  </Text>
                </InlineStack>

                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={products.length}
                  selectable={false}
                  headings={headings}
                >
                  {products.map((p, idx) => {
                    const currentGrade = String(gradeById[p.id] ?? "");
                    const currentCollection = String(collectionById[p.id] ?? "");

                    const changed =
                      currentGrade.trim() !== String(p.grade || "").trim() ||
                      currentCollection !== String(p.collectionId || "");

                    const savingThisRow = isSaving && fetcher.formData?.get("productId") === p.id;

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
                          <div style={{ minWidth: 220 }}>
                            <TextField
                              label="Grade"
                              labelHidden
                              value={currentGrade}
                              onChange={(v) => setGradeById((prev) => ({ ...prev, [p.id]: v }))}
                              autoComplete="off"
                            />
                          </div>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <div style={{ minWidth: 260 }}>
                            <Select
                              label="Collection"
                              labelHidden
                              options={collectionOptions}
                              value={currentCollection}
                              onChange={(v) => setCollectionById((prev) => ({ ...prev, [p.id]: v }))}
                            />
                          </div>
                          <div style={{ marginTop: 6 }}>
                            <Badge tone="info">
                              Current: {p.collectionTitle ? p.collectionTitle : "None"}
                            </Badge>
                          </div>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <Button
                            variant="primary"
                            loading={savingThisRow}
                            disabled={!changed || savingThisRow}
                            onClick={() => saveRow(p)}
                          >
                            Save
                          </Button>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>

                <InlineStack align="space-between">
                  <Pagination
                    hasPrevious={!!after}
                    onPrevious={() => {
                      // Simple approach: go back to first page (cursor pagination has no easy prev)
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
