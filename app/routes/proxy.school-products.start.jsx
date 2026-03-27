import crypto from "crypto";
import { authenticate } from "../shopify.server";

function clean(v) {
    return String(v ?? "").trim();
}

function json(data, init = {}) {
    return new Response(JSON.stringify(data), {
        ...init,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...(init.headers || {}),
        },
    });
}

export async function action({ request }) {
    try {
        const { admin, session } = await authenticate.public.appProxy(request);

        if (!admin) {
            return json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);

        // Shopify proxy query params
        const shop = clean(url.searchParams.get("shop"));
        const loggedInCustomerId = clean(url.searchParams.get("logged_in_customer_id"));

        if (!loggedInCustomerId) {
            return json(
                { ok: false, error: "No logged-in customer found" },
                { status: 401 }
            );
        }

        // Body sent from theme JS
        let body = {};
        try {
            body = await request.json();
        } catch {
            body = {};
        }

        const email = clean(body.email);
        const customerIdFromTheme = clean(body.customerId);
        const firstName = clean(body.firstName);
        const lastName = clean(body.lastName);

        if (!email) {
            return json({ ok: false, error: "Missing email" }, { status: 400 });
        }

        if (!customerIdFromTheme) {
            return json({ ok: false, error: "Missing customerId" }, { status: 400 });
        }

        // if (!firstName) {
        //     return json({ ok: false, error: "Missing firstName" }, { status: 400 });
        // }

        // if (!lastName) {
        //     return json({ ok: false, error: "Missing lastName" }, { status: 400 });
        // }

        // Security check: customer id from Liquid must match Shopify proxy param
        if (customerIdFromTheme !== loggedInCustomerId) {
            return json(
                { ok: false, error: "Customer validation failed" },
                { status: 403 }
            );
        }

        const timestamp = Date.now().toString();

        // Shared secret for lovable validation
        const bridgeSecret = process.env.CUSTOMER_BRIDGE_SECRET;

        if (!bridgeSecret) {
            return json(
                { ok: false, error: "Missing CUSTOMER_BRIDGE_SECRET in server env" },
                { status: 500 }
            );
        }

        // Payload to sign
        const payload = `${shop}|${loggedInCustomerId}|${email}|${firstName}|${lastName}|${timestamp}`;

        const token = crypto
            .createHmac("sha256", bridgeSecret)
            .update(payload)
            .digest("hex");

        const lovableBaseUrl = "https://clubcoloursprocess.lovable.app/";

        const redirectUrl =
            `${lovableBaseUrl}` +
            `?shopify_customer_id=${encodeURIComponent(loggedInCustomerId)}` +
            `&first_name=${encodeURIComponent(firstName)}` +
            `&last_name=${encodeURIComponent(lastName)}` +
            `&email=${encodeURIComponent(email)}` +
            `&timestamp=${encodeURIComponent(timestamp)}` + // optional
            `&token=${encodeURIComponent(token)}`; // optional but recommended

        return json({
            ok: true,
            redirectUrl,
        });
    } catch (error) {
        return json(
            {
                ok: false,
                error: error?.message || "Server error",
            },
            { status: 500 }
        );
    }
}