// ===========================
// MPSQ CONFIGURATION
// ===========================

// Discord OAuth2 Configuration
const DISCORD_CONFIG = {
    clientId: '1493778021545545980',
    redirectUri: 'https://galaxushd.github.io/MPSQ-Website/auth/discord/callback',
    scopes: 'identify',
    // Only this Discord User ID is allowed to access the editing page
    editorId: '826234747373617212'
};

// Supabase Configuration
// IMPORTANT: Replace these values with your actual Supabase project URL and anon key.
// 1. Go to https://supabase.com and open your project
// 2. Go to Settings > API
// 3. Copy "Project URL" into SUPABASE_URL
// 4. Copy "anon / public" key into SUPABASE_ANON_KEY
const SUPABASE_URL = 'https://hbikjzzkxsvjoqnedbmm.supabase.co';
const SUPABASE_ANON_KEY = 'GYkKzmIMb_OL7MOlOXikwzTjzJ267HQW';
