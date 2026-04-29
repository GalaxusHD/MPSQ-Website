// ===========================
// WORKER API HELPER
// ===========================
// Uses the Cloudflare Worker API (window.API_BASE_URL) via fetch (no build step needed)

const SupabaseClient = (() => {
    // Fetch all team members ordered by rank then sort_order (public read)
    async function getTeamMembers() {
        const url = `${window.API_BASE_URL}/api/team-members`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Worker error: ${res.status}`);
        const out = await res.json();
        // Worker returns { data: [...] }; accept both shapes for backwards compatibility
        return Array.isArray(out) ? out : (out.data || []);
    }

    // Fetch a single content block by key (public read)
    async function getContentBlock(key) {
        const url = `${window.API_BASE_URL}/api/content-blocks?key=${encodeURIComponent(key)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Worker error: ${res.status}`);
        const out = await res.json();
        // Worker returns { data: <value> }
        if (out?.data !== undefined) return { key, value: out.data };
        return null;
    }

    return { getTeamMembers, getContentBlock };
})();

