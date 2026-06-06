/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    /* Override Tailwind's default screen widths so the desktop layout
       (channel-list as static side panel, member list visible, etc)
       kicks in at a much lower viewport width than the stock xl:1280.
       Below xl, the app uses a drawer-based mobile layout with a
       hamburger menu. 700px is the threshold below which the static
       three-column shell starts to feel cramped; everything above it
       has enough horizontal room. Other breakpoints stay at the
       defaults — sm/md/lg are used for column-count tweaks where
       Tailwind's defaults are well-tuned. */
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '700px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        // Themeable palette. Each token resolves to a CSS variable holding
        // "R G B" channels, so runtime themes (Settings → Appearance) can
        // re-skin the whole app by swapping the channel values on a
        // [data-theme] block in index.css — and Tailwind's opacity modifiers
        // (bg-accent/15, etc.) still work via the <alpha-value> slot. The
        // default channel values match the original abyssal-navy hex, so the
        // "Default" theme is pixel-identical to before. `ink` (text) is left
        // as static hex since it stays constant across themes.
        bg: {
          0: 'rgb(var(--c-bg-0) / <alpha-value>)',
          1: 'rgb(var(--c-bg-1) / <alpha-value>)',
          2: 'rgb(var(--c-bg-2) / <alpha-value>)',
          3: 'rgb(var(--c-bg-3) / <alpha-value>)',
        },
        ink: {
          1: '#f3f6fa',  // primary text
          2: '#b5becf',  // secondary text
          3: '#7a849a',  // tertiary / placeholder
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        },
        'accent-2': 'rgb(var(--c-accent-2) / <alpha-value>)',
        'accent-3': 'rgb(var(--c-accent-3) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
      },
      fontFamily: {
        // Zekktris type stack. Space Grotesk for the bulk of the
        // UI (humanist geometric sans, distinctive at small sizes).
        // JetBrains Mono for code blocks, timestamps, channel-id
        // chips, and any "machine voice" surface. System fallback
        // chains preserved so a font-load failure renders cleanly.
        sans: [
          'Space Grotesk',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
