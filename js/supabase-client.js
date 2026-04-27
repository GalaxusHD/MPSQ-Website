// ===========================
// SUPABASE HELPER
// ===========================
// Uses Supabase REST API via fetch (no build step needed)

const SupabaseClient = (() => {
    function headers() {
        return {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        };
    }

    // Fetch all team members ordered by rank then sort_order (public read)
    async function getTeamMembers() {
        const url = `${SUPABASE_URL}/rest/v1/team_members?select=*&order=rank.asc,sort_order.asc,name.asc`;
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
        return res.json();
    }

    // Fetch a single content block by key (public read)
    async function getContentBlock(key) {
        const url = `${SUPABASE_URL}/rest/v1/content_blocks?key=eq.${encodeURIComponent(key)}&select=*&limit=1`;
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
        const rows = await res.json();
        return rows[0] || null;
    }

    return { getTeamMembers, getContentBlock };
})();

