import crypto from "node:crypto";
import { getSupabaseAdmin } from "../supabase.server";
import { unauthenticated } from "../shopify.server";

const TABLE = "product_grade_collection";

const COLLECTION_GID_TO_SCHOOL_TAG = {
    "gid://shopify/Collection/276875411527": "Regina Dominican Shop",
    "gid://shopify/Collection/282935689287": "FSHA SHOP",
    "gid://shopify/Collection/276875509831": "AOLP SHOP",
    "gid://shopify/Collection/276875280455": "Castilleja Shop",
    "gid://shopify/Collection/276875444295": "NDB Shop",
    "gid://shopify/Collection/276875247687": "Marlborough Shop",
};

const SCHOOL_TAG_TO_COLLECTION_ID = Object.fromEntries(
    Object.entries(COLLECTION_GID_TO_SCHOOL_TAG).map(([collectionId, schoolTag]) => [
        String(schoolTag).trim().toLowerCase(),
        {
            collection_id: collectionId,
            collection_title: schoolTag,
            collection_handle: null,
        },
    ])
);

function jsonResponse(data, init = {}) {
    return new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: {
            "Content-Type": "application/json",
            ...(init.headers || {}),
        },
    });
}

function cleanText(value) {
    return String(value ?? "").trim();
}

function toProductGid(shopifyProductId) {
    const raw = cleanText(shopifyProductId);
    if (!raw) return "";

    if (raw.startsWith("gid://shopify/Product/")) return raw;
    if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;

    return raw;
}

function verifySignature(rawBody, signature) {
    const secret = process.env.SCHOOL_TAG_SYNC_SHARED_SECRET;

    if (!secret || !signature) return false;

    const expected = crypto
        .createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("hex");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected, "hex"),
            Buffer.from(String(signature), "hex")
        );
    } catch {
        return false;
    }
}

function parseSchoolTags(value) {
    return [
        ...new Set(
            String(value ?? "")
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean)
        ),
    ];
}

function getMappedCollectionIdsFromTags(tags = []) {
    const mapped = new Map();

    for (const rawTag of tags) {
        const tag = cleanText(rawTag);
        if (!tag) continue;

        const found = SCHOOL_TAG_TO_COLLECTION_ID[tag.toLowerCase()];
        if (!found) continue;

        const collectionId = found.collection_id;

        if (!mapped.has(collectionId)) {
            mapped.set(collectionId, {
                collection_id: collectionId,
                matched_tags: [tag],
            });
        } else {
            mapped.get(collectionId).matched_tags.push(tag);
        }
    }

    return Array.from(mapped.values());
}

const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductById($id: ID!) {
    product(id: $id) {
      ... on Product {
        id
        title
        handle
        tags
      }
    }
  }
`;

const COLLECTION_BY_ID_QUERY = `#graphql
  query CollectionById($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation AddTagsToProduct($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        ... on Product {
          id
          title
          handle
          tags
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function action({ request }) {
    if (request.method !== "POST") {
        return jsonResponse(
            { ok: false, error: "Method not allowed" },
            { status: 405 }
        );
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-school-tag-signature");

    if (!verifySignature(rawBody, signature)) {
        return jsonResponse(
            { ok: false, error: "Invalid signature" },
            { status: 401 }
        );
    }

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return jsonResponse(
            { ok: false, error: "Invalid JSON body" },
            { status: 400 }
        );
    }

    const shop = cleanText(process.env.SHOPIFY_STORE_DOMAIN);
    const shopifyProductId = toProductGid(body?.shopify_product_id);
    const schoolTags = parseSchoolTags(body?.school_tag);

    if (!shop) {
        return jsonResponse(
            { ok: false, error: "Missing SHOPIFY_STORE_DOMAIN in env" },
            { status: 500 }
        );
    }

    if (!shopifyProductId) {
        return jsonResponse(
            { ok: false, error: "Missing shopify_product_id" },
            { status: 400 }
        );
    }

    if (!schoolTags.length) {
        return jsonResponse(
            { ok: false, error: "Missing school_tag" },
            { status: 400 }
        );
    }

    try {
        const { admin } = await unauthenticated.admin(shop);
        const supabase = getSupabaseAdmin();

        const productResponse = await admin.graphql(PRODUCT_BY_ID_QUERY, {
            variables: { id: shopifyProductId },
        });

        const productResult = await productResponse.json();

        if (productResult?.errors?.length) {
            return jsonResponse(
                { ok: false, error: productResult.errors },
                { status: 500 }
            );
        }

        const product = productResult?.data?.product;

        if (!product?.id) {
            return jsonResponse(
                { ok: false, error: "Product not found in Shopify" },
                { status: 404 }
            );
        }

        const existingTags = Array.isArray(product.tags) ? product.tags : [];
        const existingTagSet = new Set(
            existingTags.map((tag) => String(tag).trim().toLowerCase())
        );

        const tagsToAdd = schoolTags.filter(
            (tag) => !existingTagSet.has(tag.toLowerCase())
        );

        let updatedProduct = product;

        if (tagsToAdd.length) {
            const addResponse = await admin.graphql(TAGS_ADD_MUTATION, {
                variables: {
                    id: product.id,
                    tags: tagsToAdd,
                },
            });

            const addResult = await addResponse.json();

            if (addResult?.errors?.length) {
                return jsonResponse(
                    { ok: false, error: addResult.errors },
                    { status: 500 }
                );
            }

            const userErrors = addResult?.data?.tagsAdd?.userErrors || [];
            if (userErrors.length) {
                return jsonResponse(
                    { ok: false, error: userErrors },
                    { status: 400 }
                );
            }

            updatedProduct = addResult?.data?.tagsAdd?.node || product;
        }

        const mappedCollections = getMappedCollectionIdsFromTags(schoolTags);
        const upsertedRows = [];

        for (const item of mappedCollections) {
            const collectionResponse = await admin.graphql(COLLECTION_BY_ID_QUERY, {
                variables: { id: item.collection_id },
            });

            const collectionResult = await collectionResponse.json();

            if (collectionResult?.errors?.length) {
                return jsonResponse(
                    { ok: false, error: collectionResult.errors },
                    { status: 500 }
                );
            }

            const collection = collectionResult?.data?.collection;

            if (!collection?.id) {
                return jsonResponse(
                    {
                        ok: false,
                        error: `Collection not found in Shopify for ID ${item.collection_id}`,
                    },
                    { status: 404 }
                );
            }

            const payload = {
                shopify_product_id: shopifyProductId,
                product_title: updatedProduct?.title || product?.title || null,
                product_handle: updatedProduct?.handle || product?.handle || null,
                collection_id: collection.id,
                collection_title: collection.title,
                collection_handle: collection.handle,
                school_tag: item.matched_tags.join(","),
                updated_at: new Date().toISOString(),
            };

            const { data, error } = await supabase
                .from(TABLE)
                .upsert(payload, {
                    onConflict: "shopify_product_id,collection_id",
                })
                .select();

            if (error) {
                return jsonResponse(
                    {
                        ok: false,
                        error: `Supabase upsert failed: ${error.message}`,
                        failedPayload: payload,
                    },
                    { status: 500 }
                );
            }

            if (Array.isArray(data)) {
                upsertedRows.push(...data);
            }
        }

        return jsonResponse({
            ok: true,
            message: tagsToAdd.length
                ? "School tags added and collection mappings updated"
                : "No new Shopify tags needed; collection mappings updated",
            product: {
                id: updatedProduct?.id || product?.id,
                title: updatedProduct?.title || product?.title,
                handle: updatedProduct?.handle || product?.handle,
                tags: updatedProduct?.tags || existingTags,
            },
            receivedSchoolTags: schoolTags,
            addedTags: tagsToAdd,
            mappedCollections,
            upsertedRows,
        });
    } catch (error) {
        return jsonResponse(
            {
                ok: false,
                error: error?.message || "Server error",
            },
            { status: 500 }
        );
    }
}