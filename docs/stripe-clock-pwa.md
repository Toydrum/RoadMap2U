# PWA temporal en DEV/TEST

Decisión del usuario: adaptar la PWA real para cuentas sintéticas (respuesta
`call_6329be4486cc490e83c22e7f5c8168a9`). Implementación y pruebas locales;
publicación, despliegue, identidades, fixtures, claves, flags y relojes físicos
requieren sus ventanas específicas.

El contrato añade metadatos opcionales `simulation` a los resúmenes de pagos
y acceso: ambiente, estado ready/unavailable, tiempo financiero congelado,
revisión del reloj, hora real de lectura y caducidad real de evidencia. El
servidor los deriva del mismo reloj protegido ya usado por BillingService y
AccessResolver. No se exponen IDs de Stripe, perfiles ni claves. Las respuestas
ordinarias conservan su forma y PROD no emite ni acepta simulaciones.

AccessService consume ese acceso solo de una respuesta autenticada reciente
en DEV/TEST, en memoria durante un máximo de 15 segundos reales y mientras haya
conexión. Mantiene la autorización offline caducada; reemplaza la caché de esa identidad por Free. La evidencia
temporal de IndexedDB nunca se aceptará. Pérdida de conexión, error de lectura,
caducidad, cambio de usuario o cierre eliminan el acceso temporal. Las fechas
de la suscripción se comparan con el tiempo financiero recibido; los timers,
URLs de Checkout, seguridad y vida del bosque mantienen la hora real.

La pantalla de suscripción muestra una indicación ES/EN de ensayo y su fecha
financiera, con estado de espera cuando falte evidencia. La confirmación de
pago sigue requiriendo la fuente individual validada por AccessService y la
misma revisión/fecha financiera en ambos resúmenes.
No se crean botones para avanzar relojes ni un nuevo camino de entitlements.

Validación: contratos con metadatos malformados/cruzados/PROD; flujo online
Premium y caducidad al avanzar, pérdida de conexión y recarga; confirmación
financiera sin alterar Date; pantalla bilingüe; suites existentes, build y PWA.
La aceptación física DEV/TEST y fiscal/live/producción siguen pendientes.

Resultado local: 566 pruebas Angular en 61 archivos, 122 controles de
configuración, build de 0.0.131, 108 hashes del service worker y seis recorridos
críticos existentes de navegador aprobados. Estos últimos usan el mock local;
los nuevos escenarios de reloj usan los servicios y componentes Angular reales
con respuestas sintéticas inyectadas. No certifican el recorrido temporal físico
de DEV/TEST ni autorizan publicar o desplegar.
