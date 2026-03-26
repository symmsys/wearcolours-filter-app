import { getSupabaseAdmin } from "../supabase.server";
import { processOneSyncBatch } from "../utils/syncGrades.server";
import { unauthenticated } from "../shopify.server";

export const action = async ({ request }) => {
    const url = new URL(request.url);
    const workerToken = request.headers.get("x-worker-token");

    if (!process.env.SYNC_WORKER_TOKEN || workerToken !== process.env.SYNC_WORKER_TOKEN) {
        return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const shop = (url.searchParams.get("shop") || "").trim();
    if (!shop) {
        return Response.json({ ok: false, error: "Missing shop" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    const { data: job, error: jobErr } = await supabase
        .from("sync_jobs")
        .select("*")
        .eq("shop", shop)
        .eq("job_type", "grade_sync")
        .in("status", ["queued", "running", "paused"])
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (jobErr) {
        return Response.json({ ok: false, error: jobErr.message }, { status: 500 });
    }

    if (!job) {
        return Response.json({ ok: true, message: "No pending sync job" });
    }

    try {
        const { admin } = await unauthenticated.admin(shop);

        // If paused do nothing
        if (job.status === "paused") {
            return Response.json({
                ok: true,
                jobId: job.id,
                message: "Sync paused"
            });
        }

        const result = await processOneSyncBatch({
            admin,
            jobId: job.id,
        });

        return Response.json({
            ok: true,
            jobId: job.id,
            result,
        });
    } catch (e) {
        return Response.json(
            {
                ok: false,
                jobId: job.id,
                error: e?.message || String(e),
            },
            { status: 500 }
        );
    }
};