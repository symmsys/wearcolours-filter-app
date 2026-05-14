import crypto from "node:crypto";
import { unauthenticated } from "../shopify.server";

const PACK_DISCOUNTS = {
    essentials: 10,
    complete: 12.5,
    full_wardrobe: 15,
};

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

function normalizeCustomerGid(value) {
    const raw = cleanText(value);

    if (!raw) return "";

    if (raw.startsWith("gid://shopify/Customer/")) {
        return raw;
    }

    if (/^\d+$/.test(raw)) {
        return `gid://shopify/Customer/${raw}`;
    }

    return raw;
}

function verifySignature(rawBody, signature) {
    const secret = process.env.CUSTOMER_BRIDGE_SECRET;

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

function toMoney(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        return "";
    }

    return amount.toFixed(2);
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? []);
    } catch {
        return "[]";
    }
}

function gidToNumericId(gid) {
    const raw = cleanText(gid);
    const parts = raw.split("/");
    return parts[parts.length - 1] || "";
}

function getDiscountByPackKey(packKey) {
    const key = cleanText(packKey).toLowerCase();

    if (Object.prototype.hasOwnProperty.call(PACK_DISCOUNTS, key)) {
        return PACK_DISCOUNTS[key];
    }

    return 0;
}

function buildProductTitle({ packKey, planName, studentName }) {
    const safePack = cleanText(planName || packKey || "Annual Pack");
    const safeStudent = cleanText(studentName || "Student");

    return `${safePack} - ${safeStudent}`;
}

const CUSTOMER_QUERY = `#graphql
  query CustomerById($id: ID!) {
    customer(id: $id) {
      id
      email
      phone
      defaultAddress {
        firstName
        lastName
        address1
        address2
        city
        province
        country
        zip
        phone
      }
    }
  }
`;

const PRODUCT_CREATE_MUTATION = `#graphql
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        handle
        status
        variants(first: 1) {
          nodes {
            id
            title
            price
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation ProductVariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
      allowPartialUpdates: false
    ) {
      product {
        id
      }
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SELLING_PLAN_GROUP_CREATE_MUTATION = `#graphql
  mutation SellingPlanGroupCreate(
    $input: SellingPlanGroupInput!
    $resources: SellingPlanGroupResourceInput!
  ) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup {
        id
        name
        merchantCode
        sellingPlans(first: 1) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLICATIONS_QUERY = `#graphql
  query Publications {
    publications(first: 20) {
      edges {
        node {
          id
          autoPublish
        }
      }
    }
  }
`;

const PUBLISHABLE_PUBLISH_MUTATION = `#graphql
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
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
    const signature = request.headers.get("x-dynamic-subscription-signature");

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
    const currencyCode = cleanText(process.env.SHOPIFY_CURRENCY_CODE || "USD");

    const annualAmount = toMoney(body?.annual_amount);
    const customerId = normalizeCustomerGid(body?.customer_id);
    const customerEmail = cleanText(body?.customer_email);
    const customerPhone = cleanText(body?.customer_phone);

    const packKey = cleanText(body?.pack_key).toLowerCase();
    const planName = cleanText(body?.plan_name);
    const studentName = cleanText(body?.student_name);
    const schoolName = cleanText(body?.school_name);
    const selections = Array.isArray(body?.selections) ? body.selections : [];



    if (!shop) {
        return jsonResponse(
            { ok: false, error: "Missing SHOPIFY_STORE_DOMAIN in env" },
            { status: 500 }
        );
    }

    if (!annualAmount) {
        return jsonResponse(
            { ok: false, error: "Invalid or missing annual_amount" },
            { status: 400 }
        );
    }

    if (!packKey) {
        return jsonResponse(
            { ok: false, error: "Missing pack_key" },
            { status: 400 }
        );
    }

    if (!["essentials", "complete", "full_wardrobe"].includes(packKey)) {
        return jsonResponse(
            {
                ok: false,
                error: "Invalid pack_key. Use essentials, complete, or full_wardrobe",
            },
            { status: 400 }
        );
    }

    try {
        const { admin } = await unauthenticated.admin(shop);

        let customer = null;

        if (customerId) {
            const customerResponse = await admin.graphql(CUSTOMER_QUERY, {
                variables: {
                    id: customerId,
                },
            });

            const customerResult = await customerResponse.json();

            if (customerResult?.errors?.length) {
                return jsonResponse(
                    { ok: false, error: customerResult.errors },
                    { status: 500 }
                );
            }

            customer = customerResult?.data?.customer || null;
        }

        const discountPercentage = getDiscountByPackKey(packKey);
        const baseAmount = Number(annualAmount);

        const discountAmount = Number(
            ((baseAmount * discountPercentage) / 100).toFixed(2)
        );

        const finalAmount = Number(
            (baseAmount - discountAmount).toFixed(2)
        );

        const productTitle = buildProductTitle({
            packKey,
            planName,
            studentName,
        });

        const descriptionHtml = `
            <p>Generated annual subscription pack from Lovable.</p>
            <p><strong>Pack:</strong> ${planName || packKey}</p>
            <p><strong>Student:</strong> ${studentName || ""}</p>
            <p><strong>School:</strong> ${schoolName || ""}</p>
        `;

        const productCreateResponse = await admin.graphql(PRODUCT_CREATE_MUTATION, {
            variables: {
                product: {
                    title: productTitle,
                    descriptionHtml,
                    vendor: "Club Colours",
                    productType: "Dynamic Annual Pack",
                    status: "ACTIVE",
                    tags: [
                        "lovable-generated",
                        "annual-pack",
                        `pack-${packKey}`,
                        "auto-created",
                    ],
                },
            },
        });

        const productCreateResult = await productCreateResponse.json();

        if (productCreateResult?.errors?.length) {
            return jsonResponse(
                { ok: false, error: productCreateResult.errors },
                { status: 500 }
            );
        }

        const productCreateErrors =
            productCreateResult?.data?.productCreate?.userErrors || [];

        if (productCreateErrors.length) {
            return jsonResponse(
                { ok: false, error: productCreateErrors },
                { status: 400 }
            );
        }

        const product = productCreateResult?.data?.productCreate?.product;
        const variant = product?.variants?.nodes?.[0];

        if (!product?.id || !variant?.id) {
            return jsonResponse(
                { ok: false, error: "Product or default variant was not created" },
                { status: 500 }
            );
        }

        const variantUpdateResponse = await admin.graphql(
            PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
            {
                variables: {
                    productId: product.id,
                    variants: [
                        {
                            id: variant.id,
                            price: annualAmount,
                        },
                    ],
                },
            }
        );

        const variantUpdateResult = await variantUpdateResponse.json();

        if (variantUpdateResult?.errors?.length) {
            return jsonResponse(
                { ok: false, error: variantUpdateResult.errors },
                { status: 500 }
            );
        }

        const variantUpdateErrors =
            variantUpdateResult?.data?.productVariantsBulkUpdate?.userErrors || [];

        if (variantUpdateErrors.length) {
            return jsonResponse(
                { ok: false, error: variantUpdateErrors },
                { status: 400 }
            );
        }

        const sellingPlanResponse = await admin.graphql(
            SELLING_PLAN_GROUP_CREATE_MUTATION,
            {
                variables: {
                    input: {
                        name: `Annual Subscription - ${planName || packKey} - ${Date.now()}`,
                        merchantCode: `annual-${packKey}-${Date.now()}`,
                        options: ["Billing frequency"],
                        position: 1,
                        sellingPlansToCreate: [
                            {
                                name: "Annual billing",
                                options: ["Annual billing"],
                                position: 1,
                                category: "SUBSCRIPTION",
                                billingPolicy: {
                                    recurring: {
                                        interval: "YEAR",
                                        intervalCount: 1,
                                    },
                                },
                                deliveryPolicy: {
                                    recurring: {
                                        interval: "YEAR",
                                        intervalCount: 1,
                                    },
                                },
                                inventoryPolicy: {
                                    reserve: "ON_SALE",
                                },
                                pricingPolicies: [
                                    {
                                        fixed: {
                                            adjustmentType: "PERCENTAGE",
                                            adjustmentValue: {
                                                percentage: discountPercentage,
                                            },
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                    resources: {
                        productVariantIds: [variant.id],
                    },
                },
            }
        );

        const sellingPlanResult = await sellingPlanResponse.json();

        if (sellingPlanResult?.errors?.length) {
            return jsonResponse(
                { ok: false, error: sellingPlanResult.errors },
                { status: 500 }
            );
        }

        const sellingPlanErrors =
            sellingPlanResult?.data?.sellingPlanGroupCreate?.userErrors || [];

        if (sellingPlanErrors.length) {
            return jsonResponse(
                { ok: false, error: sellingPlanErrors },
                { status: 400 }
            );
        }

        const sellingPlanGroup =
            sellingPlanResult?.data?.sellingPlanGroupCreate?.sellingPlanGroup;

        const sellingPlan =
            sellingPlanGroup?.sellingPlans?.edges?.[0]?.node || null;

        if (!sellingPlan?.id) {
            return jsonResponse(
                { ok: false, error: "Selling plan was not created" },
                { status: 500 }
            );
        }

        let publishWarning = null;

        try {
            const publicationsResponse = await admin.graphql(PUBLICATIONS_QUERY);
            const publicationsResult = await publicationsResponse.json();

            const publicationId =
                publicationsResult?.data?.publications?.edges?.[0]?.node?.id || null;

            if (publicationId) {
                const publishResponse = await admin.graphql(
                    PUBLISHABLE_PUBLISH_MUTATION,
                    {
                        variables: {
                            id: product.id,
                            input: [
                                {
                                    publicationId,
                                },
                            ],
                        },
                    }
                );

                const publishResult = await publishResponse.json();
                const publishErrors =
                    publishResult?.data?.publishablePublish?.userErrors || [];

                if (publishResult?.errors?.length || publishErrors.length) {
                    publishWarning =
                        "Product created, but publishing to Online Store failed. Cart URL may not work until product is available on Online Store.";
                }
            } else {
                publishWarning =
                    "Product created, but no publication ID found. Cart URL may not work until product is available on Online Store.";
            }
        } catch {
            publishWarning =
                "Product created, but publishing step failed. Cart URL may not work until product is available on Online Store.";
        }

        const numericVariantId = gidToNumericId(variant.id);
        const numericSellingPlanId = gidToNumericId(sellingPlan.id);

        const addParams = new URLSearchParams();

        addParams.set("id", numericVariantId);
        addParams.set("quantity", "1");
        addParams.set("selling_plan", numericSellingPlanId);

        // addParams.set("properties[Source]", "Lovable");
        addParams.set("properties[Billing Type]", "Annual Subscription");
        addParams.set("properties[Pack Key]", packKey);

        addParams.set("properties[Base Price]", `$${baseAmount.toFixed(2)}`);
        addParams.set("properties[Pack Discount]", `${discountPercentage}%`);
        addParams.set("properties[Discount Amount]", `$${discountAmount.toFixed(2)}`);
        addParams.set("properties[Final Annual Price]", `$${finalAmount.toFixed(2)}`);

        const address = customer?.defaultAddress || null;

// if (address) {
//     const fullName = `${cleanText(address.firstName)} ${cleanText(address.lastName)}`.trim();

//     if (fullName) {
//         addParams.set("properties[Shipping Name]", fullName);
//     }

//     if (address.address1) {
//         addParams.set("properties[Shipping Address 1]", address.address1);
//     }

//     if (address.address2) {
//         addParams.set("properties[Shipping Address 2]", address.address2);
//     }

//     if (address.city) {
//         addParams.set("properties[Shipping City]", address.city);
//     }

//     if (address.province) {
//         addParams.set("properties[Shipping Province]", address.province);
//     }

//     if (address.country) {
//         addParams.set("properties[Shipping Country]", address.country);
//     }

//     if (address.zip) {
//         addParams.set("properties[Shipping ZIP]", address.zip);
//     }

//     if (address.phone) {
//         addParams.set("properties[Shipping Phone]", address.phone);
//     }
// }

        if (planName) {
            addParams.set("properties[Plan Name]", planName);
        }

        if (studentName) {
            addParams.set("properties[Student Name]", studentName);
        }

        if (schoolName) {
            addParams.set("properties[School Name]", schoolName);
        }

        if (selections.length) {
            selections.forEach((item, index) => {
                const title = cleanText(item.title);
                const size = cleanText(item.size);
                const quantity = cleanText(item.quantity || 1);

                const label = `Selected Item ${index + 1}`;
                const value = `${quantity} x ${title}${size ? ` - Size ${size}` : ""}`;

                addParams.set(`properties[${label}]`, value);
            });
        }

        // addParams.set("return_to", "/checkout");

        const checkoutParams = new URLSearchParams();

        const checkoutEmail = customerEmail || customer?.email || "";
        const checkoutPhone =
            customerPhone ||
            customer?.phone ||
            customer?.defaultAddress?.phone ||
            "";

        if (checkoutEmail) {
            checkoutParams.set("checkout[email]", checkoutEmail);
        }

        // const address = customer?.defaultAddress || null;

        if (address) {
            if (address.firstName) {
                checkoutParams.set(
                    "checkout[shipping_address][first_name]",
                    address.firstName
                );
            }

            if (address.lastName) {
                checkoutParams.set(
                    "checkout[shipping_address][last_name]",
                    address.lastName
                );
            }

            if (address.address1) {
                checkoutParams.set(
                    "checkout[shipping_address][address1]",
                    address.address1
                );
            }

            if (address.address2) {
                checkoutParams.set(
                    "checkout[shipping_address][address2]",
                    address.address2
                );
            }

            if (address.city) {
                checkoutParams.set(
                    "checkout[shipping_address][city]",
                    address.city
                );
            }

            if (address.province) {
                checkoutParams.set(
                    "checkout[shipping_address][province]",
                    address.province
                );
            }

            if (address.country) {
                checkoutParams.set(
                    "checkout[shipping_address][country]",
                    address.country
                );
            }

            if (address.zip) {
                checkoutParams.set(
                    "checkout[shipping_address][zip]",
                    address.zip
                );
            }

            if (checkoutPhone) {
                checkoutParams.set(
                    "checkout[shipping_address][phone]",
                    checkoutPhone
                );
            }
        } else if (checkoutPhone) {
            checkoutParams.set(
                "checkout[shipping_address][phone]",
                checkoutPhone
            );
        }

        const checkoutPath = `/checkout${
    checkoutParams.toString() ? `?${checkoutParams.toString()}` : ""
}`;

addParams.set("return_to", checkoutPath);

const cartAddUrl = `/cart/add?${addParams.toString()}`;

const checkoutUrl = `https://${shop}/cart/clear?return_to=${encodeURIComponent(
    cartAddUrl
)}`;

        return jsonResponse({
            ok: true,
            message: "Dynamic annual subscription product created",
            checkoutUrl,
            publishWarning,
            product: {
                id: product.id,
                title: product.title,
                handle: product.handle,
            },
            variant: {
                id: variant.id,
                numericId: numericVariantId,
                price: annualAmount,
            },
            sellingPlanGroup: {
                id: sellingPlanGroup.id,
                name: sellingPlanGroup.name,
                merchantCode: sellingPlanGroup.merchantCode,
            },
            sellingPlan: {
                id: sellingPlan.id,
                numericId: numericSellingPlanId,
                name: sellingPlan.name,
                discountPercentage,
            },
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