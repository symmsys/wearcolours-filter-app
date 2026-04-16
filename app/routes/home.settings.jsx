// app/routes/product.settings.jsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineStack,
  Layout,
  Page,
  Checkbox,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

/* ─────────────────────────────────────────────
   Constants
───────────────────────────────────────────── */

// Only allow these collections in Settings page
const ALLOWED_COLLECTION_IDS = new Set([
  "gid://shopify/Collection/276875509831",
  "gid://shopify/Collection/276875247687",
  "gid://shopify/Collection/276875411527",
  "gid://shopify/Collection/276875280455",
  "gid://shopify/Collection/276875444295",
  "gid://shopify/Collection/282935689287",
]);
const SETTINGS_TABLE = "settings";

const SORT_OPTIONS = [
  { label: "Title A → Z", value: "TITLE_ASC" },
  { label: "Title Z → A", value: "TITLE_DESC" },
  { label: "Price Low → High", value: "PRICE_ASC" },
  { label: "Price High → Low", value: "PRICE_DESC" },
  { label: "Best Selling", value: "BEST_SELLING" },
  { label: "Created (Newest)", value: "CREATED_DESC" },
  { label: "Created (Oldest)", value: "CREATED_ASC" },
  { label: "Manual", value: "MANUAL" },
];

const DEFAULT_SORT = "TITLE_ASC";

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */
function cleanText(v) {
  return String(v ?? "").trim();
}

function safeErrToString(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e?.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
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

    const json = await res.json();
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

    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn?.pageInfo?.endCursor;
    if (!after) break;
  }

  return all;
}

/* ─────────────────────────────────────────────
   LOADER
───────────────────────────────────────────── */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const supabase = getSupabaseAdmin();

  const allCollections = await fetchAllCollections(admin);

  const collections = allCollections.filter((c) =>
    ALLOWED_COLLECTION_IDS.has(String(c.id))
  );

  const { data: rows, error: fetchErr } = await supabase
    .from(SETTINGS_TABLE)
    .select("*")
    .eq("shop", shop);

  if (fetchErr) console.error("Settings fetch error:", fetchErr);

  const settingsMap = {};
  for (const row of rows || []) {
    if (row.collection_id) {
      settingsMap[row.collection_id] = {
        default_sort_order: row.default_sort_order || DEFAULT_SORT,
        show_in_school_dropdown: !!row.show_in_school_dropdown,
      };
    }
  }
  return { shop, collections, settingsMap };
};

/* ─────────────────────────────────────────────
   ACTION
───────────────────────────────────────────── */
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const supabase = getSupabaseAdmin();

  const form = await request.formData();
  const intent = cleanText(form.get("intent"));

  if (intent === "saveSortOrder") {
    const collectionId = cleanText(form.get("collectionId"));
    const collectionTitle = cleanText(form.get("collectionTitle"));
    const collectionHandle = cleanText(form.get("collectionHandle"));
    const sortOrder = cleanText(form.get("sortOrder")) || DEFAULT_SORT;
    const showInSchoolDropdown = String(form.get("showInSchoolDropdown")) === "true";

    if (!collectionId) return { ok: false, error: "Missing collectionId" };

    try {
      const { error: upsertErr } = await supabase
        .from(SETTINGS_TABLE)
        .upsert(
          {
            shop,
            collection_id: collectionId,
            collection_title: collectionTitle || null,
            collection_handle: collectionHandle || null,
            default_sort_order: sortOrder,
            show_in_school_dropdown: showInSchoolDropdown,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shop,collection_id" }
        );

      if (upsertErr) throw new Error(upsertErr.message);

      return {
        ok: true,
        intent,
        collectionId,
        sortOrder,
        showInSchoolDropdown,
      };
    } catch (e) {
      return { ok: false, error: safeErrToString(e) };
    }
  }

  return { ok: false, error: "Unknown intent" };
};

/* ─────────────────────────────────────────────
   Collection Row Component
───────────────────────────────────────────── */
function CollectionRow({
  collection,
  currentSort,
  currentShowInDropdown,
  onSave,
  isSaving,
  justSaved,
}) {
  const [localSort, setLocalSort] = useState(currentSort || DEFAULT_SORT);
  const [localShowInDropdown, setLocalShowInDropdown] = useState(!!currentShowInDropdown);

  useEffect(() => {
    setLocalSort(currentSort || DEFAULT_SORT);
  }, [currentSort]);

  useEffect(() => {
    setLocalShowInDropdown(!!currentShowInDropdown);
  }, [currentShowInDropdown]);

  const handleSortChange = (value) => {
    setLocalSort(value);
    onSave(collection, {
      sortOrder: value,
      showInSchoolDropdown: localShowInDropdown,
    });
  };

  const handleCheckboxChange = (checked) => {
    setLocalShowInDropdown(checked);
    onSave(collection, {
      sortOrder: localSort,
      showInSchoolDropdown: checked,
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "14px 16px",
        borderBottom: "1px solid #e1e3e5",
        background: isSaving ? "#f9fafb" : "#ffffff",
        transition: "background 0.2s",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {collection.title}
        </Text>
        <div style={{ marginTop: 2 }}>
          <Text as="span" variant="bodySm" tone="subdued">
            /{collection.handle}
          </Text>
        </div>
      </div>

      <div style={{ width: 220, flexShrink: 0 }}>
        <Select
          label="Default sort order"
          labelHidden
          options={SORT_OPTIONS}
          value={localSort}
          onChange={handleSortChange}
          disabled={isSaving}
        />
      </div>

      <div style={{ width: 180, flexShrink: 0 }}>
        <Checkbox
          label="Show in school dropdown"
          checked={localShowInDropdown}
          onChange={handleCheckboxChange}
          disabled={isSaving}
        />
      </div>

      <div
        style={{
          width: 90,
          flexShrink: 0,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        {isSaving ? (
          <InlineStack gap="100" blockAlign="center">
            <Spinner size="small" />
            <Text as="span" variant="bodySm" tone="subdued">
              Saving…
            </Text>
          </InlineStack>
        ) : justSaved ? (
          <Badge tone="success">Saved ✓</Badge>
        ) : (
          <Badge
            tone={
              localSort !== DEFAULT_SORT || localShowInDropdown
                ? "attention"
                : "new"
            }
          >
            {localSort !== DEFAULT_SORT || localShowInDropdown ? "Custom" : "Default"}
          </Badge>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Main Page
───────────────────────────────────────────── */
export default function SettingsPage() {
  const { collections, settingsMap } = useLoaderData();
  const fetcher = useFetcher();

  const [localSettings, setLocalSettings] = useState({ ...settingsMap });
  const [savingCollectionId, setSavingCollectionId] = useState(null);
  const [savedCollectionId, setSavedCollectionId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const savedTimerRef = useRef(null);

  /* Filter collections by search query */
  const filteredCollections = useMemo(() => {
    if (!searchQuery.trim()) return collections;
    const q = searchQuery.toLowerCase();
    return collections.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.handle.toLowerCase().includes(q)
    );
  }, [collections, searchQuery]);

  const saveError =
    fetcher.data?.ok === false ? fetcher.data.error : null;

  /* Detect save completion */
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok === true &&
      fetcher.data?.intent === "saveSortOrder"
    ) {
      const id = fetcher.data.collectionId;
      setSavingCollectionId(null);
      setSavedCollectionId(id);

      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedCollectionId((prev) => (prev === id ? null : prev));
      }, 2500);
    }

    if (fetcher.state === "idle" && fetcher.data?.ok === false) {
      setSavingCollectionId(null);
    }
  }, [fetcher.state, fetcher.data]);

  /* Auto-save on dropdown change */
  const handleSave = useCallback(
    (collection, { sortOrder, showInSchoolDropdown }) => {
      setLocalSettings((prev) => ({
        ...prev,
        [collection.id]: {
          default_sort_order: sortOrder,
          show_in_school_dropdown: !!showInSchoolDropdown,
        },
      }));

      setSavingCollectionId(collection.id);
      setSavedCollectionId(null);

      fetcher.submit(
        {
          intent: "saveSortOrder",
          collectionId: collection.id,
          collectionTitle: collection.title,
          collectionHandle: collection.handle,
          sortOrder,
          showInSchoolDropdown: showInSchoolDropdown ? "true" : "false",
        },
        { method: "POST" }
      );
    },
    [fetcher]
  );

  const customCount = Object.values(localSettings).filter((v) => {
    if (!v || typeof v !== "object") return false;
    return (
      v.default_sort_order !== DEFAULT_SORT ||
      v.show_in_school_dropdown === true
    );
  }).length;

  return (
    <Page
      fullWidth
      title="Settings"
      subtitle="Set the default sort order for each school collection"
    >
      <Layout>
        <Layout.Section>

          {/* Error banner */}
          {saveError && (
            <div style={{ marginBottom: 16 }}>
              <Banner tone="critical" title="Save error">
                <p>{saveError}</p>
              </Banner>
            </div>
          )}

          {/* Summary card */}
          <Card>
            <div style={{ padding: "16px 20px" }}>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    Collection Sort Orders
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {collections.length} total collections · {customCount} customised
                  </Text>
                </BlockStack>
                <Badge tone={customCount > 0 ? "success" : "new"}>
                  {customCount > 0 ? `${customCount} custom` : "All default"}
                </Badge>
              </InlineStack>
            </div>
          </Card>

          <div style={{ marginTop: 16 }} />

          {/* Search + list card */}
          <Card padding="0">

            {/* Search header */}
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid #e1e3e5",
                background: "#f9fafb",
                borderRadius: "12px 12px 0 0",
              }}
            >
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <div style={{ flex: 1, maxWidth: 380 }}>
                  <TextField
                    label="Search collections"
                    labelHidden
                    placeholder="Search by name or handle…"
                    value={searchQuery}
                    onChange={setSearchQuery}
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                    autoComplete="off"
                  />
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                  Showing {filteredCollections.length} of {collections.length}
                </Text>
              </InlineStack>
            </div>

            {/* Column headers */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "10px 16px",
                background: "#f9fafb",
                borderBottom: "1px solid #e1e3e5",
              }}
            >
              <div style={{ flex: 1 }}>
                <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                  COLLECTION
                </Text>
              </div>
              <div style={{ width: 220 }}>
                <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                  DEFAULT SORT ORDER
                </Text>
              </div>
              <div style={{ width: 180 }}>
                <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                  SCHOOL DROPDOWN
                </Text>
              </div>
              <div style={{ width: 90 }}>
                <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                  STATUS
                </Text>
              </div>
            </div>

            {/* Rows */}
            {filteredCollections.length === 0 ? (
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <Text as="p" tone="subdued">
                  {searchQuery
                    ? `No collections matching "${searchQuery}"`
                    : "No collections found in your store."}
                </Text>
              </div>
            ) : (
              <div style={{ borderRadius: "0 0 12px 12px", overflow: "hidden" }}>
                {filteredCollections.map((collection) => (
                  <CollectionRow
                    key={collection.id}
                    collection={collection}
                    currentSort={
                      localSettings[collection.id]?.default_sort_order || DEFAULT_SORT
                    }
                    currentShowInDropdown={
                      !!localSettings[collection.id]?.show_in_school_dropdown
                    }
                    onSave={handleSave}
                    isSaving={
                      savingCollectionId === collection.id &&
                      fetcher.state !== "idle"
                    }
                    justSaved={savedCollectionId === collection.id}
                  />
                ))}
              </div>
            )}
          </Card>

          {/* Help note */}
          <div style={{ marginTop: 12 }}>
            <Text as="p" variant="bodySm" tone="subdued">
              Changes save automatically when you pick a new sort order. Settings are stored per collection in your Supabase{" "}
              <code>settings</code> table.
            </Text>
          </div>

        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = boundary.headers;
export const ErrorBoundary = boundary.error;
