// ===========================
// NAVIGATION
// ===========================

document.addEventListener('DOMContentLoaded', () => {
    // Set active nav link based on current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const navLinks = document.querySelectorAll('.nav-links a');
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
            link.classList.add('active');
        }
    });

    // Hamburger menu toggle
    const hamburger = document.querySelector('.nav-hamburger');
    const navMenu = document.querySelector('.nav-links');

    if (hamburger && navMenu) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('open');
            navMenu.classList.toggle('open');
        });

        // Close menu when clicking a link
        navMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                hamburger.classList.remove('open');
                navMenu.classList.remove('open');
            });
        });

        // Close menu on outside click
        document.addEventListener('click', (e) => {
            if (!hamburger.contains(e.target) && !navMenu.contains(e.target)) {
                hamburger.classList.remove('open');
                navMenu.classList.remove('open');
            }
        });
    }

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    // Application form handling
    const applyForm = document.getElementById('apply-form');
    if (applyForm) {
        const getTrimmedFormValue = (formData, fieldName) => {
            const value = formData.get(fieldName);
            return typeof value === 'string' ? value.trim() : '';
        };

        const showApplyMessage = (message, isError = false) => {
            const existingMessage = applyForm.querySelector('[data-apply-message]');
            if (existingMessage) {
                existingMessage.remove();
            }

            const infoBox = document.createElement('div');
            const color = isError ? '#ff4d4f' : '#00b341';

            infoBox.className = 'info-box';
            infoBox.dataset.applyMessage = 'true';
            infoBox.style.borderColor = color;
            infoBox.style.marginTop = '20px';

            const text = document.createElement('p');
            text.style.color = color;
            text.style.fontWeight = '600';
            text.textContent = message;

            infoBox.appendChild(text);

            applyForm.appendChild(infoBox);
        };

        applyForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            if (!this.reportValidity()) {
                return;
            }

            const submitBtn = this.querySelector('[type="submit"]');
            const originalText = submitBtn.textContent;
            const formData = new FormData(this);
            const age = Number(formData.get('age'));

            if (Number.isNaN(age)) {
                showApplyMessage('❌ Bitte gib ein gültiges Alter ein.', true);
                return;
            }

            submitBtn.textContent = 'Wird gesendet...';
            submitBtn.disabled = true;

            try {
                if (!window.API_BASE_URL) {
                    throw new Error('Die API-Konfiguration fehlt. Bitte versuche es später erneut.');
                }

                const response = await fetch(`${window.API_BASE_URL}/api/applications`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        minecraft_name: getTrimmedFormValue(formData, 'minecraft-name'),
                        discord_name: getTrimmedFormValue(formData, 'discord-name'),
                        age,
                        role: formData.get('role'),
                        experience: formData.get('experience'),
                        why: getTrimmedFormValue(formData, 'why'),
                        skills: getTrimmedFormValue(formData, 'skills'),
                        submitted_at: new Date().toISOString(),
                        user_agent: navigator.userAgent
                    })
                });

                let result = null;
                try {
                    result = await response.json();
                } catch (error) {
                    console.warn('Could not parse application response JSON.', error);
                    result = null;
                }

                if (!response.ok || !result?.ok) {
                    throw new Error(result?.message || 'Deine Bewerbung konnte nicht gesendet werden. Bitte versuche es in ein paar Minuten erneut.');
                }

                showApplyMessage('✅ Bewerbung erfolgreich abgeschickt! Wir melden uns bald bei dir.');
                applyForm.reset();
            } catch (error) {
                showApplyMessage(`❌ ${error.message || 'Beim Senden ist ein Fehler aufgetreten. Bitte versuche es erneut.'}`, true);
            } finally {
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
            }
        });
    }

    // Card entrance animation with IntersectionObserver
    if ('IntersectionObserver' in window) {
        const observerOptions = {
            threshold: 0.1,
            rootMargin: '0px 0px -40px 0px'
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);

        document.querySelectorAll('.card, .team-card, .event-card, .social-card, .project-card, .feature-item').forEach(el => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(24px)';
            el.style.transition = 'opacity 0.4s ease, transform 0.4s ease, border-color 0.25s ease, box-shadow 0.25s ease';
            observer.observe(el);
        });
    }
});
