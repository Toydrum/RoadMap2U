import type { Lang } from '../db/schema';

// The shared dictionaries are pinned by the backend contract. This guide is frontend-only.
const ES = {
  title: 'Instalar en mi teléfono',
  action: 'Instalar en este dispositivo',
  desktopHint: 'En computadora, busca el icono de instalación en la barra de direcciones o «Instalar aplicación» en el menú del navegador.',
  iphone: {
    title: 'iPhone',
    steps: [
      'Abre RoadMap2U en Safari.',
      'Toca Compartir y elige «Agregar a Inicio».',
      'Si aparece «Abrir como app web», actívalo. Toca «Agregar».',
    ],
  },
  android: {
    title: 'Android',
    steps: [
      'Abre RoadMap2U en Chrome.',
      'Toca el menú ⋮ y busca «Instalar», «Instalar y crear acceso directo» o «Agregar a la pantalla de inicio».',
      'Elige «Instalar» si aparece y confirma.',
    ],
  },
  openFromIcon: 'Después puedes abrir RoadMap2U desde el icono de la pantalla de inicio.',
  guide: 'Al entrar por primera vez al Bosque, encontrarás los pasos para iPhone y Android en «Instalar en mi teléfono». También puedes consultarlos en Ajustes → Instalar RoadMap2U cuando quieras, tanto en Free como en Premium.',
};

export const PHONE_INSTALL_COPY = {
  es: ES,
  en: {
    title: 'Install on my phone',
    action: 'Install on this device',
    desktopHint: 'On a computer, look for the install icon in the address bar or “Install app” in the browser menu.',
    iphone: {
      title: 'iPhone',
      steps: [
        'Open RoadMap2U in Safari.',
        'Tap Share and choose “Add to Home Screen”.',
        'If “Open as Web App” appears, turn it on. Tap “Add”.',
      ],
    },
    android: {
      title: 'Android',
      steps: [
        'Open RoadMap2U in Chrome.',
        'Tap the ⋮ menu and look for “Install”, “Install and create shortcut”, or “Add to Home screen”.',
        'Choose “Install” if it appears, then confirm.',
      ],
    },
    openFromIcon: 'You can then open RoadMap2U from the icon on your home screen.',
    guide: 'On your first visit to the Forest, look for “Install on my phone” for iPhone and Android steps. You can also find them under Settings → Install RoadMap2U anytime, on both Free and Premium.',
  },
} satisfies Record<Lang, typeof ES>;
