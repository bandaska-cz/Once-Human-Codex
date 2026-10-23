/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./OnceHuman/**/*.{html,js}",
    "./OnceHuman/*.{html,js}"
  ],
  safelist: [
    { pattern: /(bg|text|border)-(amber|purple|blue|emerald|slate|cyan)-(300|400|500|600|700|800|900|950)/ },
    { pattern: /(bg|border)-(amber|purple|blue|emerald|slate|cyan)-(500|800|950)\/(15|20|30|40|50|60|70|80|90)/ }
  ],
  theme: {
    extend: {
      colors: {
        hud: {
          bg: '#05080f',
          surface: '#0d1522',
          card: '#111b2b',
          border: '#1e334d',
          cyan: '#00f0ff',
          gold: '#ffb703',
          purple: '#b5179e',
          danger: '#ef4444',
          green: '#10b981'
        }
      },
      fontFamily: {
        orbitron: ['Orbitron', 'sans-serif'],
        rajdhani: ['Rajdhani', 'sans-serif'],
        sans: ['Inter', 'sans-serif']
      }
    }
  },
  plugins: []
};

