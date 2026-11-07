/**
 * Tailwind config for the launcher — the design tokens mirror the live website
 * (assassins.network / AN-Flask static/main.css): blue-tinted dark surfaces, a
 * cyan (#00f5ff) accent, JetBrains Mono + Inter, soft radii.
 *
 * The token *names* are the Material-style names the pages already use
 * (bg-surface, text-on-primary, bg-primary, ...); only their *values* mirror
 * the website palette. Compiled to vendor/tailwind.css via `npm run build:css`.
 */
module.exports = {
    darkMode: 'class',
    content: ['./*.html', './preload.js', './main.js'],
    safelist: [
        // Status colors composed in JS (stats leaderboard trend arrows, etc.).
        'text-muted-deep-green',
        'text-muted-deep-red',
        'text-win',
        'text-loss',
        'text-tie',
        // Install-log line colors built as `text-${type}` in settings.html.
        'text-primary',
        'text-primary-container',
        'text-secondary',
        'text-error',
        'font-bold',
    ],
    theme: {
        extend: {
            colors: {
                'background': '#0c0e12',
                'surface': '#0c0e12',
                'surface-dim': '#0c0e12',
                'surface-bright': '#333539',
                'surface-container-lowest': '#080a0d',
                'surface-container-low': '#111317',
                'surface-container': '#1a1c20',
                'surface-container-high': '#1e2024',
                'surface-container-highest': '#282a2e',
                'surface-variant': '#282a2e',
                'surface-tint': '#00f5ff',
                'inverse-surface': '#e2e2e8',
                'inverse-on-surface': '#1a1c20',

                'on-surface': '#e2e2e8',
                'on-surface-variant': '#94a3b8',
                'on-background': '#e2e2e8',

                'outline': '#6b7280',
                'outline-variant': '#2d323c',

                'primary': '#00f5ff',
                'primary-container': '#00b8c4',
                'primary-fixed': '#00b8c4',
                'primary-fixed-dim': '#4df6ff',
                'inverse-primary': '#00b8c4',
                'on-primary': '#003739',
                'on-primary-container': '#003739',
                'on-primary-fixed': '#003739',
                'on-primary-fixed-variant': '#004b4f',

                'secondary': '#94a3b8',
                'secondary-fixed': '#94a3b8',
                'secondary-fixed-dim': '#4df6ff',
                'secondary-container': '#282a2e',
                'on-secondary': '#0c0e12',
                'on-secondary-container': '#e2e2e8',
                'on-secondary-fixed': '#0c0e12',
                'on-secondary-fixed-variant': '#94a3b8',

                'tertiary': '#e2e2e8',
                'tertiary-container': '#333539',
                'tertiary-fixed': '#94a3b8',
                'tertiary-fixed-dim': '#6b7280',
                'on-tertiary': '#0c0e12',
                'on-tertiary-container': '#0c0e12',
                'on-tertiary-fixed': '#ffffff',
                'on-tertiary-fixed-variant': '#e2e2e8',

                'error': '#ef4444',
                'error-container': '#7f1d1d',
                'on-error': '#450a0a',
                'on-error-container': '#fecaca',
                'win': '#10b981',
                'loss': '#ef4444',
                'tie': '#94a3b8',
                'gold': '#ffd700',
                'silver': '#c0c0c0',
                'bronze': '#cd7f32',
                'muted-deep-green': '#10b981',
                'muted-deep-red': '#ef4444',
            },
            fontFamily: {
                'headline': ['JetBrains Mono', 'ui-monospace', 'monospace'],
                'body': ['Inter', 'sans-serif'],
                'label': ['JetBrains Mono', 'ui-monospace', 'monospace'],
            },
            borderRadius: {DEFAULT: '0.375rem', lg: '0.5rem', xl: '0.75rem', full: '9999px'},
        },
    },
    plugins: [
        require('@tailwindcss/forms'),
        require('@tailwindcss/container-queries'),
    ],
};
