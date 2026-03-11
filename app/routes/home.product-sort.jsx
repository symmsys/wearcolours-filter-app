// app/routes/home.sort.jsx

import { useEffect, useMemo, useState, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

import {
    Page,
    Layout,
    Card,
    Text,
    TextField,
    Button,
    InlineStack,
    BlockStack,
    Select,
    Checkbox,
    Spinner,
    Banner,
} from "@shopify/polaris";

import {
    DndContext,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from "@dnd-kit/core";

import {
    SortableContext,
    verticalListSortingStrategy,
    useSortable,
    arrayMove,
} from "@dnd-kit/sortable";

import { CSS } from "@dnd-kit/utilities";

/* =========================
   helpers
========================= */

const ALLOWED_COLLECTION_IDS = new Set([
    "gid://shopify/Collection/276875509831",
    "gid://shopify/Collection/276875247687",
    "gid://shopify/Collection/276875411527",
    "gid://shopify/Collection/276875280455",
    "gid://shopify/Collection/276875444295",
    "gid://shopify/Collection/282935689287",
]);

function splitGrades(value) {
    return String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

function normalizeGrade(value) {
    return value == null ? "" : String(value).trim();
}

function sortKey(schoolId, grade) {
    return `${schoolId}__${normalizeGrade(grade)}`;
}

function getContextHandles(products, selectedCollectionId, selectedGrade) {
    if (!selectedCollectionId) {
        return products.map((p) => p.handle);
    }

    let list = products.filter((p) => !!p.collectionMap?.[selectedCollectionId]);

    if (selectedGrade) {
        list = list.filter((p) => {
            const gradeCsv = p.collectionMap?.[selectedCollectionId]?.grade || "";
            return splitGrades(gradeCsv).includes(selectedGrade);
        });
    }

    return list.map((p) => p.handle);
}

function resolveHandlesForContext({
    products,
    savedSorts,
    selectedCollectionId,
    selectedGrade,
}) {
    const fallbackHandles = getContextHandles(
        products,
        selectedCollectionId,
        selectedGrade
    );

    if (!selectedCollectionId) {
        return {
            handles: fallbackHandles,
            gradeOverride: false,
        };
    }

    const key = sortKey(selectedCollectionId, selectedGrade || "");
    const saved = savedSorts[key];

    if (Array.isArray(saved?.product_order?.handles) && saved.product_order.handles.length) {
        return {
            handles: mergeSavedOrder(fallbackHandles, saved.product_order.handles),
            gradeOverride: !!saved.grade_override,
        };
    }

    return {
        handles: fallbackHandles,
        gradeOverride: false,
    };
}

async function getSavedManualSort(supabase, schoolId, grade = "") {
    const safeSchoolId = String(schoolId || "").trim();
    const safeGrade = String(grade || "").trim();

    if (!safeSchoolId) return null;

    const { data, error } = await supabase
        .from("product_sort_order")
        .select("school_id, grade, product_order, grade_override, status")
        .eq("school_id", safeSchoolId)
        .eq("grade", safeGrade)
        .eq("status", 1)
        .maybeSingle();

    if (error) {
        throw new Error(error.message || "Failed to fetch saved manual sort");
    }

    if (!data) return null;

    return {
        school_id: data.school_id || "",
        grade: String(data.grade || ""),
        grade_override: !!data.grade_override,
        product_order: data.product_order || {
            handles: [],
            available_grades: [],
            gradeByHandle: {},
        },
    };
}

function uniqueStrings(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
}

function escapeShopifySearchValue(value) {
    return String(value || "").replace(/'/g, "\\'");
}

async function fetchProductsByHandles(admin, handles) {
    const out = new Map();
    const chunkSize = 10;

    for (let i = 0; i < handles.length; i += chunkSize) {
        const chunk = handles.slice(i, i + chunkSize);
        if (!chunk.length) continue;

        const query = chunk.map((h) => `handle:${h}`).join(" OR ");

        try {
            const resp = await admin.graphql(
                `#graphql
        query ProductsByHandles($query: String!) {
          products(first: 50, query: $query) {
            edges {
              node {
                id
                handle
                title
                featuredImage {
                  url
                  altText
                }
              }
            }
          }
        }`,
                { variables: { query } }
            );

            const json = await resp.json();

            if (json?.errors) {
                console.error("Shopify GraphQL errors:", json.errors);
            }

            const edges = json?.data?.products?.edges || [];

            for (const edge of edges) {
                const node = edge?.node;
                if (!node?.handle) continue;

                out.set(node.handle, {
                    id: node.id,
                    handle: node.handle,
                    title: node.title || node.handle,
                    imageUrl: node.featuredImage?.url || "",
                    imageAlt: node.featuredImage?.altText || node.title || node.handle,
                });
            }
        } catch (e) {
            console.error("fetchProductsByHandles chunk failed:", e, query);
        }
    }

    return out;
}

async function fetchShopId(admin) {
    const resp = await admin.graphql(
        `#graphql
    query {
      shop {
        id
      }
    }`
    );
    const json = await resp.json();
    return json?.data?.shop?.id || "";
}

function mergeSavedOrder(contextHandles, savedHandles) {
    const validSaved = (savedHandles || []).filter((h) => contextHandles.includes(h));
    const missing = contextHandles.filter((h) => !validSaved.includes(h));
    return [...validSaved, ...missing];
}

function reorderVisibleWithinFull(fullHandles, visibleHandles, activeId, overId) {
    if (!activeId || !overId || activeId === overId) return fullHandles;

    const currentVisible = fullHandles.filter((h) => visibleHandles.includes(h));
    const oldIndex = currentVisible.indexOf(activeId);
    const newIndex = currentVisible.indexOf(overId);

    if (oldIndex === -1 || newIndex === -1) return fullHandles;

    const movedVisible = arrayMove(currentVisible, oldIndex, newIndex);

    let visiblePointer = 0;
    return fullHandles.map((h) => {
        if (!visibleHandles.includes(h)) return h;
        const nextHandle = movedVisible[visiblePointer];
        visiblePointer += 1;
        return nextHandle;
    });
}

/* =========================
   loader
========================= */

export async function loader({ request }) {
    try {
        const { admin } = await authenticate.admin(request);
        const supabase = getSupabaseAdmin();



        const shopId = await fetchShopId(admin);


        const { data: mappingRows, error: mappingError } = await supabase
            .from("product_grade_collection")
            .select("product_handle, grade, collection_id, collection_handle")
            .not("product_handle", "is", null)
            .order("collection_handle", { ascending: true });

        if (mappingError) {
            console.error("mappingError:", mappingError);
            throw new Error(mappingError.message || "Failed to load product mappings");
        }

        const safeRows = (mappingRows || []).filter((row) =>
            ALLOWED_COLLECTION_IDS.has(String(row?.collection_id || "").trim())
        );


        const allHandles = uniqueStrings(
            safeRows.map((r) => String(r.product_handle || "").trim())
        );


        let shopifyMap = new Map();
        try {
            shopifyMap = await fetchProductsByHandles(admin, allHandles);

        } catch (e) {
            console.error("fetchProductsByHandles failed:", e);
            throw e;
        }

        const { data: masterRows, error: masterError } = await supabase
            .from("master database colours")
            .select('Handle,"Age Size Range"')
            .in("Handle", allHandles);

        if (masterError) {
            console.error("masterError:", masterError);
            throw new Error(masterError.message || "Failed to load Age Size Range");
        }



        const ageSizeByHandle = {};
        for (const row of masterRows || []) {
            const handle = String(row?.Handle || "").trim();
            if (!handle) continue;
            ageSizeByHandle[handle] = row?.["Age Size Range"] || "";
        }

        const collectionMap = new Map();
        const groupedByHandle = new Map();

        for (const row of safeRows) {
            const handle = String(row?.product_handle || "").trim();
            const collectionId = String(row?.collection_id || "").trim();
            const collectionHandle = String(row?.collection_handle || "").trim();
            const gradeCsv = normalizeGrade(row?.grade);

            if (!handle || !collectionId) continue;

            if (!collectionMap.has(collectionId)) {
                collectionMap.set(collectionId, {
                    value: collectionId,
                    label: collectionHandle || collectionId,
                    collection_id: collectionId,
                    collection_handle: collectionHandle || "",
                });
            }

            if (!groupedByHandle.has(handle)) {
                groupedByHandle.set(handle, {
                    handle,
                    title: shopifyMap.get(handle)?.title || handle,
                    productId: shopifyMap.get(handle)?.id || "",
                    imageUrl: shopifyMap.get(handle)?.imageUrl || "",
                    imageAlt: shopifyMap.get(handle)?.imageAlt || handle,
                    ageSizeRange: ageSizeByHandle[handle] || "",
                    collectionMap: {},
                });
            }

            groupedByHandle.get(handle).collectionMap[collectionId] = {
                collectionId,
                collectionHandle,
                grade: gradeCsv,
            };
        }

        const products = Array.from(groupedByHandle.values()).sort((a, b) =>
            String(a.title || "").localeCompare(String(b.title || ""))
        );

        const collections = Array.from(collectionMap.values()).sort((a, b) =>
            String(a.label || "").localeCompare(String(b.label || ""))
        );

        const { data: savedRows, error: savedError } = await supabase
            .from("product_sort_order")
            .select("school_id, grade, product_order, grade_override, status")
            .eq("status", 1);

        if (savedError) {
            console.error("savedError:", savedError);
            throw new Error(savedError.message || "Failed to load saved sort orders");
        }

        const savedSorts = {};

        for (const collectionId of ALLOWED_COLLECTION_IDS) {
            const schoolLevelSort = await getSavedManualSort(supabase, collectionId, "");
            if (schoolLevelSort) {
                savedSorts[sortKey(collectionId, "")] = schoolLevelSort;
            }

            const gradesForCollection = uniqueStrings(
                safeRows
                    .filter((row) => String(row?.collection_id || "").trim() === collectionId)
                    .flatMap((row) => splitGrades(row?.grade))
            );

            for (const grade of gradesForCollection) {
                const gradeLevelSort = await getSavedManualSort(supabase, collectionId, grade);
                if (gradeLevelSort) {
                    savedSorts[sortKey(collectionId, grade)] = gradeLevelSort;
                }
            }
        }


        return Response.json({
            ok: true,
            shopId,
            collections,
            products,
            savedSorts,
        });
    } catch (error) {
        console.error("manual-sort loader error:", error);
        return Response.json(
            {
                ok: false,
                error: error?.message || "Loader failed",
            },
            { status: 500 }
        );
    }
}

/* =========================
   action
========================= */

export async function action({ request }) {
    const { admin } = await authenticate.admin(request);
    const supabase = getSupabaseAdmin();

    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");

    if (intent !== "save-sort-order") {
        return Response.json({ ok: false, error: "Invalid intent" }, { status: 400 });
    }

    const schoolId = String(formData.get("school_id") || "").trim();
    const grade = normalizeGrade(formData.get("grade"));
    const gradeOverride = String(formData.get("grade_override") || "false") === "true";
    const productOrderRaw = String(formData.get("product_order") || "").trim();

    if (!schoolId) {
        return Response.json({ ok: false, error: "Missing school_id" }, { status: 400 });
    }

    if (!productOrderRaw) {
        return Response.json({ ok: false, error: "Missing product_order" }, { status: 400 });
    }

    let productOrder = null;
    try {
        productOrder = JSON.parse(productOrderRaw);
    } catch {
        return Response.json({ ok: false, error: "Invalid product_order JSON" }, { status: 400 });
    }

    const siteId = await fetchShopId(admin);
    const now = new Date().toISOString();

    const { data: existingRow, error: existingError } = await supabase
        .from("product_sort_order")
        .select("school_id, grade")
        .eq("school_id", schoolId)
        .eq("grade", grade)
        .maybeSingle();

    if (existingError) {
        return Response.json(
            { ok: false, error: existingError.message || "Failed to check existing row" },
            { status: 500 }
        );
    }

    if (existingRow) {
        const { error: updateError } = await supabase
            .from("product_sort_order")
            .update({
                site_id: siteId,
                grade_override: gradeOverride,
                product_order: productOrder,
                status: 1,
                updated: now,
            })
            .eq("school_id", schoolId)
            .eq("grade", grade);

        if (updateError) {
            return Response.json(
                { ok: false, error: updateError.message || "Failed to update sort order" },
                { status: 500 }
            );
        }

        return Response.json({ ok: true, mode: "updated" });
    }

    const { error: insertError } = await supabase
        .from("product_sort_order")
        .insert({
            site_id: siteId,
            school_id: schoolId,
            grade,
            product_order: productOrder,
            grade_override: gradeOverride,
            status: 1,
            created: now,
            updated: now,
        });

    if (insertError) {
        return Response.json(
            { ok: false, error: insertError.message || "Failed to insert sort order" },
            { status: 500 }
        );
    }

    return Response.json({ ok: true, mode: "inserted" });
}

/* =========================
   row component
========================= */

function SortableRow({ product, collectionLabel, gradeLabel, dragEnabled }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: product.handle,
        disabled: !dragEnabled,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        background: isDragging ? "#f6f6f7" : "#fff",
        opacity: isDragging ? 0.9 : 1,
    };

    return (
        <tr ref={setNodeRef} style={style}>
            <td style={{ padding: "12px", borderBottom: "1px solid #e1e3e5", width: 48 }}>
                <button
                    type="button"
                    {...attributes}
                    {...listeners}
                    disabled={!dragEnabled}
                    style={{
                        cursor: dragEnabled ? "grab" : "not-allowed",
                        border: "none",
                        background: "transparent",
                        fontSize: 18,
                    }}
                    aria-label="Drag row"
                >
                    ⋮⋮
                </button>
            </td>

            <td style={{ padding: "12px", borderBottom: "1px solid #e1e3e5" }}>
                <InlineStack gap="300" blockAlign="center">
                    <div
                        style={{
                            width: 56,
                            height: 56,
                            borderRadius: 8,
                            overflow: "hidden",
                            background: "#f1f2f3",
                            flex: "0 0 56px",
                        }}
                    >
                        {product.imageUrl ? (
                            <img
                                src={product.imageUrl}
                                alt={product.imageAlt}
                                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                        ) : null}
                    </div>

                    <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                            {product.title}
                        </Text>
                        <Text as="span" tone="subdued">
                            {product.handle}
                        </Text>
                    </BlockStack>
                </InlineStack>
            </td>

            <td style={{ padding: "12px", borderBottom: "1px solid #e1e3e5", width: 220 }}>
                <Text as="span">{product.ageSizeRange || "-"}</Text>
            </td>

            <td style={{ padding: "12px", borderBottom: "1px solid #e1e3e5", width: 220 }}>
                <Text as="span">{collectionLabel || "-"}</Text>
            </td>

            <td style={{ padding: "12px", borderBottom: "1px solid #e1e3e5", width: 200 }}>
                <Text as="span">{gradeLabel || "-"}</Text>
            </td>
        </tr>
    );
}

/* =========================
   page
========================= */

export default function ManualSortRoute() {
    const data = useLoaderData();

    if (!data?.ok) {
        return (
            <Page title="Manual Product Sort">
                <Layout>
                    <Layout.Section>
                        <Banner tone="critical">
                            <p>{data?.error || "Failed to load page data."}</p>
                        </Banner>
                    </Layout.Section>
                </Layout>
            </Page>
        );
    }

    const shopId = data?.shopId || "";
    const collections = Array.isArray(data?.collections) ? data.collections : [];
    const products = Array.isArray(data?.products) ? data.products : [];
    const [savedSorts, setSavedSorts] = useState(data?.savedSorts || {});
    const fetcher = useFetcher();

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    const [selectedCollectionId, setSelectedCollectionId] = useState("");
    const [selectedGrade, setSelectedGrade] = useState("");
    const [gradeOverride, setGradeOverride] = useState(false);

    const [searchInput, setSearchInput] = useState("");
    const [searchText, setSearchText] = useState("");
    const [isSearching, setIsSearching] = useState(false);

    const [orderedHandles, setOrderedHandles] = useState([]);
    const [message, setMessage] = useState("");


    const [initialHandles, setInitialHandles] = useState([]);
    const saveHandledRef = useRef(false);

    const selectedCollection = useMemo(
        () => (collections || []).find((c) => c.value === selectedCollectionId) || null,
        [collections, selectedCollectionId]
    );

    const allProductsByHandle = useMemo(() => {
        const map = {};
        for (const p of products) map[p.handle] = p;
        return map;
    }, [products]);

    const contextProducts = useMemo(() => {
        if (!selectedCollectionId) return products;

        let list = products.filter((p) => !!p.collectionMap[selectedCollectionId]);

        if (selectedGrade) {
            list = list.filter((p) => {
                const gradeCsv = p.collectionMap[selectedCollectionId]?.grade || "";
                return splitGrades(gradeCsv).includes(selectedGrade);
            });
        }

        return list;
    }, [products, selectedCollectionId, selectedGrade]);

    const availableGrades = useMemo(() => {
        if (!selectedCollectionId) return [];

        const gradeSet = new Set();

        for (const p of products) {
            const gradeCsv = p.collectionMap[selectedCollectionId]?.grade || "";
            for (const g of splitGrades(gradeCsv)) gradeSet.add(g);
        }

        return Array.from(gradeSet).sort((a, b) => String(a).localeCompare(String(b)));
    }, [products, selectedCollectionId]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setSearchText(searchInput.trim().toLowerCase());
            setIsSearching(false);
        }, 300);

        setIsSearching(true);
        return () => clearTimeout(timer);
    }, [searchInput]);

    useEffect(() => {
        const resolved = resolveHandlesForContext({
            products,
            savedSorts,
            selectedCollectionId,
            selectedGrade,
        });

        setOrderedHandles(resolved.handles);
        setInitialHandles(resolved.handles);
        setGradeOverride(resolved.gradeOverride);
    }, [products, savedSorts, selectedCollectionId, selectedGrade]);

    useEffect(() => {
        if (selectedGrade && !availableGrades.includes(selectedGrade)) {
            setSelectedGrade("");
        }
    }, [availableGrades, selectedGrade]);

    const filteredVisibleHandles = useMemo(() => {
        const contextHandles = getContextHandles(products, selectedCollectionId, selectedGrade);

        const baseHandles = selectedCollectionId
            ? orderedHandles.filter((h) => contextHandles.includes(h))
            : orderedHandles;

        if (!searchText) return baseHandles;

        return baseHandles.filter((handle) => {
            const title = String(allProductsByHandle[handle]?.title || "").toLowerCase();
            return title.includes(searchText);
        });
    }, [
        orderedHandles,
        products,
        selectedCollectionId,
        selectedGrade,
        searchText,
        allProductsByHandle,
    ]);

    const visibleProducts = useMemo(() => {
        return filteredVisibleHandles
            .map((handle) => allProductsByHandle[handle])
            .filter(Boolean);
    }, [filteredVisibleHandles, allProductsByHandle]);

    const dragEnabled = !!selectedCollectionId && !isSearching;

    const gradeOptions = useMemo(() => {
        return [
            { label: "All grades", value: "" },
            ...availableGrades.map((g) => ({ label: g, value: g })),
        ];
    }, [availableGrades]);

    const collectionOptions = useMemo(() => {
        return [
            { label: "Select school / collection", value: "" },
            ...collections.map((c) => ({
                label: c.label,
                value: c.value,
            })),
        ];
    }, [collections]);

    const handlesForCurrentContext = useMemo(() => {
        if (!selectedCollectionId) return [];

        const contextHandles = getContextHandles(products, selectedCollectionId, selectedGrade);
        return orderedHandles.filter((h) => contextHandles.includes(h));
    }, [orderedHandles, products, selectedCollectionId, selectedGrade]);

    const isDirty = useMemo(() => {
        if (!selectedCollectionId) return false;

        if (handlesForCurrentContext.length !== initialHandles.length) return true;

        for (let i = 0; i < handlesForCurrentContext.length; i += 1) {
            if (handlesForCurrentContext[i] !== initialHandles[i]) return true;
        }

        return false;
    }, [selectedCollectionId, handlesForCurrentContext, initialHandles]);

    function handleDragEnd(event) {
        if (!dragEnabled) return;

        const { active, over } = event;
        if (!active?.id || !over?.id) return;

        setOrderedHandles((prev) =>
            reorderVisibleWithinFull(prev, filteredVisibleHandles, active.id, over.id)
        );
    }

    function handleSave() {
        if (!selectedCollectionId) {
            setMessage("Please select a collection first.");
            return;
        }

        const handlesForSave = orderedHandles.filter((h) =>
            contextProducts.some((p) => p.handle === h)
        );

        const gradeByHandle = {};
        for (const handle of handlesForSave) {
            const gradeCsv = allProductsByHandle[handle]?.collectionMap?.[selectedCollectionId]?.grade || "";
            gradeByHandle[handle] = gradeCsv || "";
        }

        const productOrder = {
            handles: handlesForSave,
            available_grades: availableGrades,
            gradeByHandle,
        };

        const fd = new FormData();
        fd.append("intent", "save-sort-order");
        fd.append("school_id", selectedCollectionId);
        fd.append("grade", selectedGrade || "");
        fd.append("grade_override", String(gradeOverride));
        fd.append("product_order", JSON.stringify(productOrder));

        fetcher.submit(fd, { method: "post" });
    }

    useEffect(() => {
        if (fetcher.state === "submitting" || fetcher.state === "loading") {
            saveHandledRef.current = false;
            return;
        }

        if (fetcher.state !== "idle" || saveHandledRef.current) return;

        if (fetcher.data?.ok) {
            saveHandledRef.current = true;

            setMessage(
                fetcher.data.mode === "updated"
                    ? "Sort order updated."
                    : "Sort order saved."
            );

            if (!selectedCollectionId) return;

            const gradeValue = selectedGrade || "";
            const key = sortKey(selectedCollectionId, gradeValue);
            const handlesForSave = [...handlesForCurrentContext];

            const gradeByHandle = {};
            for (const handle of handlesForSave) {
                const gradeCsv =
                    allProductsByHandle[handle]?.collectionMap?.[selectedCollectionId]?.grade || "";
                gradeByHandle[handle] = gradeCsv || "";
            }

            const nextSavedEntry = {
                school_id: selectedCollectionId,
                grade: gradeValue,
                grade_override: gradeOverride,
                product_order: {
                    handles: handlesForSave,
                    available_grades: availableGrades,
                    gradeByHandle,
                },
            };

            setSavedSorts((prev) => ({
                ...prev,
                [key]: nextSavedEntry,
            }));

            setOrderedHandles(handlesForSave);
            setInitialHandles(handlesForSave);
        } else if (fetcher.data?.error) {
            saveHandledRef.current = true;
            setMessage(fetcher.data.error);
        }
    }, [
        fetcher.state,
        fetcher.data,
        selectedCollectionId,
        selectedGrade,
        gradeOverride,
        handlesForCurrentContext,
        allProductsByHandle,
        availableGrades,
    ]);

    return (
        <Page title="Manual Product Sort" fullWidth>
            <Layout>
                <Layout.Section>
                    <BlockStack gap="400">
                        {message ? (
                            <Banner
                                tone={fetcher.data?.ok ? "success" : "critical"}
                                onDismiss={() => setMessage("")}
                            >
                                <p>{message}</p>
                            </Banner>
                        ) : null}

                        <Card>
                            <BlockStack gap="400">
                                <InlineStack align="space-between" blockAlign="center">
                                    {fetcher.state !== "idle" ? <Spinner size="small" /> : null}
                                </InlineStack>

                                <InlineStack gap="300" wrap={false} blockAlign="end">
                                    <div style={{ minWidth: 260, flex: "1 1 260px" }}>
                                        <TextField
                                            label="Search products"
                                            labelHidden
                                            value={searchInput}
                                            onChange={setSearchInput}
                                            placeholder="Search by product title"
                                            autoComplete="off"
                                        />
                                    </div>

                                    <div style={{ minWidth: 260 }}>
                                        <Select
                                            label="School / Collection"
                                            options={collectionOptions}
                                            value={selectedCollectionId}
                                            onChange={(value) => {
                                                setSelectedCollectionId(value);
                                                setSelectedGrade("");
                                            }}
                                        />
                                    </div>

                                    <div style={{ minWidth: 220 }}>
                                        <Select
                                            label="Grade"
                                            options={gradeOptions}
                                            value={selectedGrade}
                                            onChange={setSelectedGrade}
                                            disabled={!selectedCollectionId}
                                        />
                                    </div>

                                    <div style={{ minWidth: 220, display: "flex", alignItems: "end" }}>
                                        <Checkbox
                                            label="Grade override"
                                            checked={gradeOverride}
                                            onChange={setGradeOverride}
                                            disabled={!selectedCollectionId}
                                        />
                                    </div>

                                    <div style={{ display: "flex", alignItems: "end", marginLeft: "auto" }}>
                                        <Button
                                            variant="primary"
                                            onClick={handleSave}
                                            loading={fetcher.state !== "idle"}
                                            disabled={!selectedCollectionId || !isDirty}
                                        >
                                            Save
                                        </Button>
                                    </div>
                                </InlineStack>


                            </BlockStack>
                        </Card>

                        <Card padding="0">
                            {isSearching ? (
                                <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
                                    <Spinner accessibilityLabel="Searching products" size="large" />
                                </div>
                            ) : (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handleDragEnd}
                                >
                                    <SortableContext
                                        items={filteredVisibleHandles}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <div style={{ overflowX: "auto" }}>
                                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                                <thead>
                                                    <tr style={{ background: "#f6f6f7" }}>
                                                        <th style={{ textAlign: "left", padding: 12, width: 48 }} />
                                                        <th style={{ textAlign: "left", padding: 12 }}>Product</th>
                                                        <th style={{ textAlign: "left", padding: 12, width: 220 }}>
                                                            Age Size Range
                                                        </th>
                                                        <th style={{ textAlign: "left", padding: 12, width: 220 }}>
                                                            Collection
                                                        </th>
                                                        <th style={{ textAlign: "left", padding: 12, width: 200 }}>
                                                            Grade
                                                        </th>
                                                    </tr>
                                                </thead>

                                                <tbody>
                                                    {visibleProducts.map((product) => {
                                                        const collectionLabel = selectedCollectionId
                                                            ? product.collectionMap[selectedCollectionId]?.collectionHandle || ""
                                                            : uniqueStrings(
                                                                Object.values(product.collectionMap || {}).map(
                                                                    (x) => x.collectionHandle
                                                                )
                                                            ).join(", ");

                                                        const gradeLabel = selectedCollectionId
                                                            ? product.collectionMap[selectedCollectionId]?.grade || ""
                                                            : uniqueStrings(
                                                                Object.values(product.collectionMap || {})
                                                                    .flatMap((x) => splitGrades(x.grade))
                                                            ).join(", ");

                                                        return (
                                                            <SortableRow
                                                                key={product.handle}
                                                                product={product}
                                                                collectionLabel={collectionLabel}
                                                                gradeLabel={gradeLabel}
                                                                dragEnabled={dragEnabled}
                                                            />
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </SortableContext>
                                </DndContext>
                            )}
                        </Card>
                    </BlockStack>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
export function ErrorBoundary({ error }) {
    console.error("Manual sort route error:", error);

    return (
        <Page title="Manual Product Sort Error" fullWidth>
            <Layout>
                <Layout.Section>
                    <Card>
                        <BlockStack gap="300">
                            <Text as="h2" variant="headingMd">
                                Something went wrong
                            </Text>
                            <Text as="p">
                                {error?.message || "Unknown server error"}
                            </Text>
                            {error?.stack ? (
                                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, overflowX: "auto" }}>
                                    {error.stack}
                                </pre>
                            ) : null}
                        </BlockStack>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}