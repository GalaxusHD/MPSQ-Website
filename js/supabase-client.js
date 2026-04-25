// ===========================
// SUPABASE HELPER
// ===========================
// Uses Supabase REST API via fetch (no build step needed)

const SupabaseClient = (() => {
    function headers(token) {
        const headerObj = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY
        };
        if (token) {
            headerObj['Authorization'] = `Bearer ${token}`;
        }
        return headerObj;
    }

    // Get Discord access token stored from login
    function getToken() {
        return localStorage.getItem('mpsq_discord_token') || null;
    }

    // Fetch all team members (public read)
    async function getTeamMembers() {
        const url = `${SUPABASE_URL}/rest/v1/team_members?select=*&order=rank.asc,minecraft_name.asc`;
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
        return res.json();
    }

    // Insert a new team member (requires Discord ID to match editor)
    async function addTeamMember(data) {
        const url = `${SUPABASE_URL}/rest/v1/team_members`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { ...headers(getToken()), 'Prefer': 'return=representation' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Supabase error: ${res.status} – ${errText}`);
        }
        return res.json();
    }

    // Update an existing team member by id
    async function updateTeamMember(id, data) {
        const url = `${SUPABASE_URL}/rest/v1/team_members?id=eq.${id}`;
        const res = await fetch(url, {
            method: 'PATCH',
            headers: { ...headers(getToken()), 'Prefer': 'return=representation' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Supabase error: ${res.status} – ${errText}`);
        }
        return res.json();
    }

    // Delete a team member by id
    async function deleteTeamMember(id) {
        const url = `${SUPABASE_URL}/rest/v1/team_members?id=eq.${id}`;
        const res = await fetch(url, {
            method: 'DELETE',
            headers: headers(getToken())
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Supabase error: ${res.status} – ${errText}`);
        }
        return true;
    }

    return { getTeamMembers, addTeamMember, updateTeamMember, deleteTeamMember };
})();
