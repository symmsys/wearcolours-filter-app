import { authenticate } from "../shopify.server";
import { getSupabaseAdmin } from "../supabase.server";

function esc(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

export async function loader({ request }) {
    // 1) Verify request is App Proxy + get Admin API client
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) return new Response("Unauthorized", { status: 401 });

    const url = new URL(request.url);
    const collectionHandle = (url.searchParams.get("collection_handle") || "").trim();
    const gradeSelected = (url.searchParams.get("grade") || "").trim(); // optional

    if (!collectionHandle) {
        return new Response("Missing collection_handle", { status: 400 });
    }

    // 2) Fetch mapping from Supabase
    const supabase = getSupabaseAdmin();

    const { data: rows, error } = await supabase
        .from("product_grade_collection")
        .select("product_handle, grade")
        .eq("collection_handle", collectionHandle)
        .not("product_handle", "is", null);

    if (error) return new Response("Supabase error", { status: 500 });

    // optional server-side grade filter (supports "7,8,9,10" strings)
    const filteredRows = gradeSelected
        ? rows.filter((r) => {
            const list = String(r.grade || "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            return list.includes(String(gradeSelected));
        })
        : rows;

    const handles = Array.from(new Set(filteredRows.map((r) => r.product_handle).filter(Boolean)));

    if (!handles.length) {
        return new Response(
            JSON.stringify({
                ok: true,
                collection_handle: collectionHandle,
                grade_selected: gradeSelected || null,
                handles: [],
                products: [],
                gradeByHandle: {},
            }),
            {
                headers: { "Content-Type": "application/json; charset=utf-8" },
            }
        );

    }

    // 3) Fetch product data from Shopify Admin API by handles
    const q = handles.map((h) => `handle:${h}`).join(" OR ");

    const resp = await admin.graphql(
        `#graphql
    query ProductsByHandle($q: String!) {
      products(first: 250, query: $q) {
        nodes {
          title
          handle
          featuredImage { url altText }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
        }
      }
    }`,
        { variables: { q } }
    );

    const json = await resp.json();
    const products = json?.data?.products?.nodes || [];

    // grade lookup for THIS school mapping
    const gradeByHandle = {};
    for (const r of rows) {
        if (r.product_handle) gradeByHandle[r.product_handle] = r.grade || "all";
    }

    // 4) Return HTML grid
    const cards = products.map((p) => {
        const img = p.featuredImage?.url
            ? `<img src="${esc(p.featuredImage.url)}" alt="${esc(p.featuredImage.altText || "")}" style="width:100%;height:auto;" />`
            : "";

        const price = p.priceRangeV2?.minVariantPrice
            ? `${esc(p.priceRangeV2.minVariantPrice.amount)} ${esc(p.priceRangeV2.minVariantPrice.currencyCode)}`
            : "";

        const dataGrade = esc(gradeByHandle[p.handle] || "all");

        return `
      <div class="grid__item" data-handle="${esc(p.handle)}" data-grade="${dataGrade}">
        <a href="/products/${esc(p.handle)}" style="text-decoration:none;">
          ${img}
          <div style="margin-top:10px;font-weight:600;">${esc(p.title)}</div>
          <div style="margin-top:6px;">${price}</div>
        </a>
      </div>
    `;
    }).join("");

    const out = products.map((p) => ({
        title: p.title,
        handle: p.handle,
        url: `/products/${p.handle}`,
        image: p.featuredImage?.url
            ? { url: p.featuredImage.url, alt: p.featuredImage.altText || "" }
            : null,
        price: p.priceRangeV2?.minVariantPrice
            ? {
                amount: p.priceRangeV2.minVariantPrice.amount,
                currencyCode: p.priceRangeV2.minVariantPrice.currencyCode,
            }
            : null,
        grade: gradeByHandle[p.handle] || "all", // 👈 grade from Supabase mapping
    }));

    return new Response(
        JSON.stringify({
            ok: true,
            collection_handle: collectionHandle,
            grade_selected: gradeSelected || null,
            handles,
            products: out,
            gradeByHandle,
        }),
        {
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
            },
        }
    );

}
