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

import { DeleteIcon } from "@shopify/polaris-icons";

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
      grade: p?.metafield?.value || "",
      imageUrl: p?.featuredImage?.url || "",
      size: collectArray("size"),
      size_type: firstValue("size type"),
      size_range: firstValue("size range"),
      collectionId: firstCol?.id || "",
      collectionTitle: firstCol?.title || "",
    };
  });

  // Fetch saved collection-grade data from Supabase
  const { data: savedData, error: fetchErr } = await supabase.from(EXTERNAL_TABLE).select("*");

  if (fetchErr) {
    console.error("Error fetching from Supabase:", fetchErr);
  }

  const collectionsByProductId = {};
  if (savedData && Array.isArray(savedData)) {
    for (const record of savedData) {
      const pId = record.shopify_product_id;
      if (!collectionsByProductId[pId]) {
        collectionsByProductId[pId] = [];
      }
      if (record.collection_id && record.collection_title) {
        collectionsByProductId[pId].push({
          id: record.collection_id,
          title: record.collection_title,
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
        savedCollections,
      };
    }

    return {
      ...item,
      savedCollections: [],
    };
  });

  return {
    items: mergedItems,
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
  const supabase = getSupabaseAdmin();

  const url = new URL(request.url);
  const after = url.searchParams.get("after"); // cursor
  const { items, hasNextPage, endCursor } = await fetchProductsWithGradeAndCollection(admin, supabase, {
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

  // NEW: delete only one collection row from external DB
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
      return { ok: false, error: e?.message || "Delete failed" };
    }
  }

  if (intent !== "saveRow") return { ok: false, error: "Unknown intent" };

  const productId = cleanText(form.get("productId"));
  const productTitle = cleanText(form.get("productTitle"));
  const collectionGradesJson = form.get("collectionGrades");

  if (!productId) return { ok: false, error: "Missing productId" };

  // Only persist changes to external DB (Supabase). Do NOT modify Shopify admin.
  try {
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

    // Parse collection-grade pairs
    let collectionGradesList = [];
    if (collectionGradesJson) {
      try {
        collectionGradesList = JSON.parse(collectionGradesJson);
        if (!Array.isArray(collectionGradesList)) collectionGradesList = [];
      } catch (e) {
        collectionGradesList = [];
      }
    }

    const upsertRecords = collectionGradesList.map((item) => ({
      shopify_product_id: productId,
      product_title: productTitle || null,
      collection_id: item.id || null,
      collection_title: item.title || null,
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
    return { ok: false, error: e?.message || "Save failed" };
  }
};

/* ---------------- UI ---------------- */

export default function GradeCollectionPage() {
  const { shop, products, collections, hasNextPage, endCursor, after } = useLoaderData();
  const shopify = useAppBridge();

  const fetcher = useFetcher(); // saveRow
  const deleteFetcher = useFetcher(); // deleteCollection

  const [collectionGradeByProductId, setCollectionGradeByProductId] = useState({});
  const [addingCollectionFor, setAddingCollectionFor] = useState(null);
  // Draft row while adding a new collection (so dropdown + grade show together)
  const [addDraftByProductId, setAddDraftByProductId] = useState({});

  const isSaving = fetcher.state !== "idle";
  const isDeleting = deleteFetcher.state !== "idle";

  const saveError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const deleteError = deleteFetcher.data?.ok === false ? deleteFetcher.data.error : null;


  const ALLOWED_COLLECTION_GIDS = useMemo(() => new Set([
    "gid://shopify/Collection/276875509831",
    "gid://shopify/Collection/276875247687",
    "gid://shopify/Collection/276039368775",
    "gid://shopify/Collection/276875411527",
    "gid://shopify/Collection/276875444295",
    "gid://shopify/Collection/276875280455",
    "gid://shopify/Collection/282935689287",
  ]), []);

  const allowedCollections = useMemo(() => {
    return (collections || []).filter((c) => ALLOWED_COLLECTION_GIDS.has(String(c.id)));
  }, [collections, ALLOWED_COLLECTION_GIDS]);

  const collectionOptions = useMemo(() => {
    return [{ label: "No collection", value: "" }, ...allowedCollections.map((c) => ({ label: c.title, value: c.id }))];
  }, [allowedCollections]);

  const gidToTitle = useMemo(() => {
    const m = new Map();
    for (const c of allowedCollections) m.set(String(c.id), String(c.title || ""));
    return m;
  }, [allowedCollections]);

  useEffect(() => {
    const cg = {};
    for (const p of products) {
      if (p.savedCollections && p.savedCollections.length > 0) {
        cg[p.id] = p.savedCollections;
      } else if (p.collectionId && p.collectionTitle) {
        cg[p.id] = [{ id: p.collectionId, title: p.collectionTitle, grade: p.grade || "" }];
      } else {
        cg[p.id] = [];
      }
    }
    setCollectionGradeByProductId(cg);
  }, [products]);

  const saveRow = (p) => {
    // Existing rows
    const collectionsData = [...(collectionGradeByProductId[p.id] || [])];

    // If user is in "adding" mode and has picked a collection, include it in the saved payload.
    const draft = addDraftByProductId[p.id];
    if (draft && draft.collectionId) {
      const alreadyExists = collectionsData.some((c) => c.id === draft.collectionId);
      if (!alreadyExists) {
        const titleFromList = gidToTitle.get(String(draft.collectionId)) || "";
        collectionsData.push({
          id: draft.collectionId,
          title: titleFromList || draft.collectionId,
          grade: String(draft.grade ?? ""),
        });
      }
    }

    // Close adding UI after Save click (does not change backend behavior)
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
        collectionGrades: JSON.stringify(collectionsData),
        size_range: p.size_range || "",
        size_type: p.size_type || "",
        size: JSON.stringify(p.size || []),
      },
      { method: "POST" }
    );
  };

  const deleteOneCollection = (productId, collectionId, colIdx) => {
    // 1) remove from UI immediately
    setCollectionGradeByProductId((prev) => {
      const existing = prev[productId] || [];
      return {
        ...prev,
        [productId]: existing.filter((_, i) => i !== colIdx),
      };
    });

    // 2) delete from external DB immediately
    deleteFetcher.submit(
      {
        intent: "deleteCollection",
        productId,
        collectionId,
      },
      { method: "POST" }
    );
  };

  const headings = useMemo(
    () => [
      { title: "Product" },
      { title: "Collections and grade" },
      { title: "Action" },
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

          {deleteError && (
            <Banner tone="critical" title="Delete error">
              <p>{deleteError}</p>
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
                    const currentCollectionGrades = collectionGradeByProductId[p.id] || [];

                    const originalCollectionGrades =
                      p.savedCollections && p.savedCollections.length > 0
                        ? p.savedCollections
                        : p.collectionId && p.collectionTitle
                          ? [{ id: p.collectionId, title: p.collectionTitle, grade: p.grade || "" }]
                          : [];

                    const changed = JSON.stringify(currentCollectionGrades) !== JSON.stringify(originalCollectionGrades);

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

                        {/* Collection + Grade (same line) + Trash per row */}
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
                                  <div style={{ width: 120, textOverflow: "ellipsis", whiteSpace: "normal" }}>
                                    <Badge tone="info">{collItem.title}</Badge>
                                  </div>

                                  <div style={{ width: 120 }}>
                                    <TextField
                                      label="Grade"
                                      labelHidden
                                      value={String(collItem.grade ?? "")}
                                      onChange={(v) => {
                                        setCollectionGradeByProductId((prev) => {
                                          const existing = prev[p.id] || [];
                                          const updated = [...existing];
                                          updated[colIdx] = { ...updated[colIdx], grade: v };
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
                                    size="slim"
                                    variant="plain"
                                    icon={DeleteIcon}
                                    tone="critical"
                                    loading={deletingThis}
                                    disabled={savingThisRow}
                                    accessibilityLabel={`Remove ${collItem.title}`}
                                    onClick={() => deleteOneCollection(p.id, collItem.id, colIdx)}
                                  />


                                </InlineStack>
                              );
                            })}

                            {addingCollectionFor === p.id ? (
                              <InlineStack gap="200" blockAlign="center" wrap={false}>
                                <div style={{ minWidth: 180 }}>
                                  <Select
                                    options={collectionOptions.filter(
                                      (opt) =>
                                        !opt.value ||
                                        !(collectionGradeByProductId[p.id] || []).some((c) => c.id === opt.value)
                                    )}
                                    value={addDraftByProductId[p.id]?.collectionId || ""}
                                    onChange={(v) => {
                                      // Auto-add the selected collection into the list immediately
                                      if (!v) return;

                                      const title = gidToTitle.get(String(v)) || "";
                                      setCollectionGradeByProductId((prev) => {
                                        const existing = prev[p.id] || [];
                                        if (existing.some((c) => c.id === v)) return prev;
                                        return {
                                          ...prev,
                                          [p.id]: [
                                            ...existing,
                                            { id: v, title: title || String(v), grade: String(addDraftByProductId[p.id]?.grade ?? "") },
                                          ],
                                        };
                                      });

                                      // Close the add row; user will type grade in the newly added row
                                      setAddingCollectionFor(null);
                                      setAddDraftByProductId((prev) => {
                                        const next = { ...prev };
                                        delete next[p.id];
                                        return next;
                                      });
                                    }}
                                  />
                                </div>

                                <div style={{ width: 120 }}>
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

                                <Button size="slim" onClick={() => {
                                  setAddingCollectionFor(null);
                                  setAddDraftByProductId((prev) => {
                                    const next = { ...prev };
                                    delete next[p.id];
                                    return next;
                                  });
                                }}>
                                  Cancel
                                </Button>
                              </InlineStack>
                            ) : (
                              <InlineStack gap="200" blockAlign="center" wrap={false}>
                                <div style={{ minWidth: 180 }} />
                                <div style={{ minWidth: 220 }} />

                              </InlineStack>
                            )}
                          </BlockStack>
                        </IndexTable.Cell>

                        {/* Save column (ONLY Save button) */}
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
                            {/* Add button (left) */}
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

                            {/* Save button (right) */}
                            <Button
                              variant="primary"
                              loading={savingThisRow}
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
