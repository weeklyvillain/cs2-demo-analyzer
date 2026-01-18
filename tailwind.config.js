/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#1e2124',
        secondary: '#282b30',
        surface: '#36393e',
        border: '#424549',
        accent: '#d07a2d',
      },
    },
  },
  plugins: [],
}

