/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: {
            900: '#1B2B5B',
            800: '#1F3268',
            700: '#2A3F7E',
            600: '#3B5298',
            500: '#4E68B0',
            400: '#7088C4',
            300: '#96A9D6',
            200: '#BCC9E6',
            100: '#E8ECF4',
            50:  '#F3F5F9',
          },
          orange: {
            700: '#C85A1C',
            600: '#E86C25',
            500: '#F09055',
            400: '#F4A87A',
            300: '#F7C09F',
            200: '#FBD8C4',
            100: '#FEF0E7',
            50:  '#FFF8F3',
          }
        },
        status: {
          success:    '#059669',
          'success-bg': '#ECFDF5',
          warning:    '#D97706',
          'warning-bg': '#FFFBEB',
          error:      '#DC2626',
          'error-bg': '#FEF2F2',
          info:       '#2563EB',
          'info-bg':  '#EFF6FF',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        'page-title': ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        'section-title': ['1rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        'body': ['0.875rem', { lineHeight: '1.25rem' }],
        'small': ['0.75rem', { lineHeight: '1rem' }],
        'tiny': ['0.6875rem', { lineHeight: '0.875rem' }],
      },
      spacing: {
        '4.5': '1.125rem',
        '13': '3.25rem',
        '15': '3.75rem',
        '18': '4.5rem',
        '22': '5.5rem',
        'sidebar': '15rem',
      },
      boxShadow: {
        'card': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'card-hover': '0 1px 3px 0 rgb(0 0 0 / 0.1)',
        'dropdown': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        'modal': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
      },
      borderRadius: {
        'card': '0.5rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.25s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
}
