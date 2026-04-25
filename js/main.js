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
        applyForm.addEventListener('submit', function (e) {
            e.preventDefault();

            const submitBtn = this.querySelector('[type="submit"]');
            const originalText = submitBtn.textContent;

            submitBtn.textContent = 'Wird gesendet...';
            submitBtn.disabled = true;

            setTimeout(() => {
                // Show success message
                const successMsg = document.createElement('div');
                successMsg.className = 'info-box';
                successMsg.style.borderColor = '#00b341';
                successMsg.style.marginTop = '20px';
                successMsg.innerHTML = '<p style="color:#00b341;font-weight:600;">✅ Bewerbung erfolgreich abgeschickt! Wir melden uns bald bei dir.</p>';
                applyForm.appendChild(successMsg);

                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
                applyForm.reset();
            }, 1200);
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
