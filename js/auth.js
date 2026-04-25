// ===========================
// DISCORD AUTHENTICATION
// ===========================

const Auth = (() => {
    const STORAGE_KEY = 'mpsq_discord_user';
    const TOKEN_KEY = 'mpsq_discord_token';

    // Build Discord OAuth2 authorization URL (implicit grant, no client secret needed)
    function getAuthUrl() {
        const params = new URLSearchParams({
            client_id: DISCORD_CONFIG.clientId,
            redirect_uri: DISCORD_CONFIG.redirectUri,
            response_type: 'token',
            scope: DISCORD_CONFIG.scopes
        });
        return `https://discord.com/oauth2/authorize?${params.toString()}`;
    }

    // Fetch Discord user info using the access token
    async function fetchDiscordUser(token) {
        const response = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Failed to fetch Discord user');
        return response.json();
    }

    // Store user session in localStorage
    function saveSession(user, token) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
        localStorage.setItem(TOKEN_KEY, token);
    }

    // Load user session from localStorage
    function loadSession() {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    }

    // Clear session (logout)
    function clearSession() {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(TOKEN_KEY);
    }

    // Get current user (or null if not logged in)
    function getUser() {
        return loadSession();
    }

    // Check if the logged-in user is the authorized editor
    function isEditor() {
        const user = getUser();
        return user && user.id === DISCORD_CONFIG.editorId;
    }

    // Redirect to Discord login
    function login() {
        window.location.href = getAuthUrl();
    }

    // Logout and reload
    function logout() {
        clearSession();
        // Refresh page to update UI
        window.location.reload();
    }

    // Update navbar login button based on auth state
    function updateNavbar() {
        const container = document.querySelector('.nav-auth');
        if (!container) return;

        const user = getUser();

        if (user) {
            const avatarUrl = user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`
                : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;

            container.innerHTML = `
                <div class="nav-user-menu">
                    <button class="nav-user-btn" id="navUserBtn" aria-label="Benutzermenü">
                        <img src="${avatarUrl}" alt="${user.username}" class="nav-user-avatar">
                        <span class="nav-user-name">${user.username}</span>
                        <svg class="nav-user-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <div class="nav-user-dropdown" id="navUserDropdown">
                        ${isEditor() ? `<a href="editing.html" class="nav-dropdown-item">✏️ Bearbeiten</a>` : ''}
                        <button class="nav-dropdown-item nav-dropdown-logout" id="navLogoutBtn">🚪 Abmelden</button>
                    </div>
                </div>`;

            document.getElementById('navUserBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('navUserDropdown').classList.toggle('open');
            });

            document.addEventListener('click', () => {
                const dd = document.getElementById('navUserDropdown');
                if (dd) dd.classList.remove('open');
            });

            document.getElementById('navLogoutBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                logout();
            });
        } else {
            container.innerHTML = `<button class="btn-discord-login" id="navLoginBtn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.1.127 18.14.158 18.162a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
                Login
            </button>`;

            document.getElementById('navLoginBtn').addEventListener('click', login);
        }
    }

    return { getUser, isEditor, login, logout, updateNavbar, fetchDiscordUser, saveSession };
})();

// Auto-update navbar when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Auth.updateNavbar();
});
