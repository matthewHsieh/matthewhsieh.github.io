// Enhanced JavaScript for modern portfolio website
document.addEventListener('DOMContentLoaded', function() {
    // Initialize all features
    initializeNavigation();
    initializeSkillBars();
    initializeScrollAnimations();
    initializeForm();
    initializeParticles();
    
    // Mobile menu functionality
    function initializeNavigation() {
        const hamburger = document.getElementById('hamburger');
        const navMenu = document.getElementById('nav-menu');
        const navLinks = document.querySelectorAll('.nav-link');

        // Toggle mobile menu
        if (hamburger && navMenu) {
            hamburger.addEventListener('click', function() {
                hamburger.classList.toggle('active');
                navMenu.classList.toggle('active');
            });

            // Close menu when clicking on a link
            navLinks.forEach(link => {
                link.addEventListener('click', function() {
                    hamburger.classList.remove('active');
                    navMenu.classList.remove('active');
                });
            });
        }

        // Navbar scroll effect
        const navbar = document.getElementById('navbar');
        if (navbar) {
            let lastScrollTop = 0;
            
            window.addEventListener('scroll', function() {
                const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
                
                // Add/remove scrolled class
                if (scrollTop > 50) {
                    navbar.classList.add('scrolled');
                } else {
                    navbar.classList.remove('scrolled');
                }

                // Update active nav link based on scroll position
                updateActiveNavLink();
                
                lastScrollTop = scrollTop;
            });
        }

        // Update active navigation link based on current section
        function updateActiveNavLink() {
            const sections = document.querySelectorAll('section[id]');
            const scrollPos = window.scrollY + 100;

            sections.forEach(section => {
                const sectionTop = section.offsetTop;
                const sectionHeight = section.offsetHeight;
                const sectionId = section.getAttribute('id');
                const navLink = document.querySelector(`a[href="#${sectionId}"]`);

                if (scrollPos >= sectionTop && scrollPos < sectionTop + sectionHeight) {
                    navLinks.forEach(link => link.classList.remove('active'));
                    if (navLink) navLink.classList.add('active');
                }
            });
        }
    }

    // Skill bars animation
    function initializeSkillBars() {
        const observerOptions = {
            threshold: 0.3,
            rootMargin: '0px 0px -50px 0px'
        };

        const skillObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const skillBars = entry.target.querySelectorAll('.level-bar');
                    skillBars.forEach(bar => {
                        const level = bar.getAttribute('data-level');
                        setTimeout(() => {
                            bar.style.width = level + '%';
                        }, 200);
                    });
                }
            });
        }, observerOptions);

        const skillsSection = document.querySelector('.skills');
        if (skillsSection) {
            skillObserver.observe(skillsSection);
        }
    }

    // Scroll animations for elements
    function initializeScrollAnimations() {
        const observerOptions = {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        };

        const scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('animate-in');
                }
            });
        }, observerOptions);

        // Animate various elements
        const animateElements = document.querySelectorAll(`
            .about-card,
            .skill-card,
            .project-card,
            .conference-card,
            .achievement-item,
            .timeline-item
        `);

        animateElements.forEach(el => {
            scrollObserver.observe(el);
        });
    }

    // Contact form handling
    function initializeForm() {
        const form = document.querySelector('.form');
        if (form) {
            form.addEventListener('submit', function(e) {
                e.preventDefault();
                
                const formData = new FormData(form);
                const data = Object.fromEntries(formData);
                
                // Show loading state
                const submitBtn = form.querySelector('button[type="submit"]');
                const originalText = submitBtn.innerHTML;
                submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
                submitBtn.disabled = true;

                // Simulate form submission (replace with actual form handling)
                setTimeout(() => {
                    submitBtn.innerHTML = '<i class="fas fa-check"></i> Message Sent!';
                    submitBtn.style.background = 'var(--success-500)';
                    
                    setTimeout(() => {
                        submitBtn.innerHTML = originalText;
                        submitBtn.disabled = false;
                        submitBtn.style.background = '';
                        form.reset();
                    }, 2000);
                }, 1500);
                
                // Here you would typically send the data to your backend
                console.log('Form submitted:', data);
            });

            // Add floating labels effect
            const inputs = form.querySelectorAll('input, textarea');
            inputs.forEach(input => {
                input.addEventListener('focus', () => {
                    input.parentElement.classList.add('focused');
                });
                
                input.addEventListener('blur', () => {
                    if (!input.value) {
                        input.parentElement.classList.remove('focused');
                    }
                });
                
                // Check if input has value on load
                if (input.value) {
                    input.parentElement.classList.add('focused');
                }
            });
        }
    }

    // Particle animation for hero section
    function initializeParticles() {
        const particles = document.querySelector('.hero-particles');
        if (particles) {
            // Create floating particles
            for (let i = 0; i < 50; i++) {
                createParticle(particles);
            }
        }
    }

    function createParticle(container) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.cssText = `
            position: absolute;
            width: ${Math.random() * 4 + 2}px;
            height: ${Math.random() * 4 + 2}px;
            background: rgba(59, 130, 246, ${Math.random() * 0.5 + 0.1});
            border-radius: 50%;
            left: ${Math.random() * 100}%;
            top: ${Math.random() * 100}%;
            animation: float ${Math.random() * 20 + 10}s infinite linear;
            pointer-events: none;
        `;
        
        container.appendChild(particle);
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            
            if (target) {
                const navbarHeight = document.querySelector('.navbar').offsetHeight;
                const targetPosition = target.offsetTop - navbarHeight - 20;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // Lazy loading for images
    const images = document.querySelectorAll('img[src]');
    const imageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                img.classList.add('loaded');
                imageObserver.unobserve(img);
            }
        });
    });

    images.forEach(img => imageObserver.observe(img));

    // Add keyboard navigation support
    document.addEventListener('keydown', function(e) {
        // Close mobile menu on Escape
        if (e.key === 'Escape') {
            const hamburger = document.getElementById('hamburger');
            const navMenu = document.getElementById('nav-menu');
            
            if (hamburger && hamburger.classList.contains('active')) {
                hamburger.classList.remove('active');
                navMenu.classList.remove('active');
            }
        }
    });

    // Performance optimization: Debounce scroll events
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Add CSS animations
    const style = document.createElement('style');
    style.textContent = `
        /* Additional animations for enhanced UX */
        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            33% { transform: translateY(-10px) rotate(120deg); }
            66% { transform: translateY(5px) rotate(240deg); }
        }
        
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .animate-in {
            animation: fadeInUp 0.6s ease-out forwards;
        }
        
        /* Smooth image loading */
        img {
            opacity: 0;
            transition: opacity 0.3s ease-in-out;
        }
        
        img.loaded {
            opacity: 1;
        }
        
        /* Enhanced navbar scroll effect */
        .navbar.scrolled {
            background: rgba(255, 255, 255, 0.98);
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        
        /* Form focus states */
        .form-group.focused label {
            color: var(--primary-600);
            transform: translateY(-2px);
        }
        
        /* Loading states */
        .loading {
            cursor: not-allowed;
            opacity: 0.7;
        }
        
        /* Enhanced mobile menu animation */
        .hamburger.active .bar:nth-child(1) {
            transform: rotate(45deg) translate(5px, 5px);
        }
        
        .hamburger.active .bar:nth-child(2) {
            opacity: 0;
        }
        
        .hamburger.active .bar:nth-child(3) {
            transform: rotate(-45deg) translate(7px, -6px);
        }
        
        /* Accessibility improvements */
        .nav-link:focus,
        .btn:focus,
        .project-link:focus {
            outline: 2px solid var(--primary-500);
            outline-offset: 2px;
        }
        
        /* Reduced motion for accessibility */
        @media (prefers-reduced-motion: reduce) {
            * {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }
    `;
    
    document.head.appendChild(style);

    // Console welcome message for developers
    console.log(`
        🚀 Welcome to Matthew Hsieh's Portfolio!
        
        Built with modern web technologies:
        • Semantic HTML5
        • CSS Custom Properties
        • Vanilla JavaScript
        • Responsive Design
        • Accessibility Features
        
        Digital Twin Engineer | Isaac Sim Expert | AWS IoT Specialist
        
        Feel free to explore the code and reach out for collaboration!
    `);
});

// Utility functions for enhanced functionality
const utils = {
    // Throttle function for performance
    throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },

    // Check if element is in viewport
    isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    },

    // Format date for display
    formatDate(date) {
        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }).format(date);
    }
};